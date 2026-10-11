// Whole-document import and releases (Onshape versions) for cadForMe. No git: Onshape is the source of truth, and a
// "release" is a named Onshape version plus a short summary of what changed since the previous release.
import fs from "node:fs";
import path from "node:path";
import { parseDocumentUrl } from "./client.js";
import { importFromOnshape, linkInfo } from "./sync.js";
import { parsePart } from "../kernel/format.js";

const slug = (s) => String(s).trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "part";

/**
 * Import every Part Studio (and Assembly, as STEP geometry) of an Onshape document as parts, each linked back to its tab.
 * Sketches, constraints, dimensions, variables, planes, extrudes, fillets, chamfers and shells come in as editable
 * features; any other Onshape feature is kept as a placeholder that is never modified (reported per part).
 * Parts already imported are skipped (use pull to refresh them).
 */
export async function importDocument(dir, client, url, { onProgress = () => {}, assemblies = true } = {}) {
  const doc = parseDocumentUrl(url);
  const d = await client.getDocument(doc.did);
  const wvm = doc.wvm ?? "w", wid = doc.wid ?? d.defaultWorkspace?.id;
  if (!wid) throw new Error("Couldn't find the document's main workspace. Paste the full link of a tab instead");
  const elements = await client.listElements(doc.did, wid);
  const wanted = elements.filter((e) => e.elementType === "PARTSTUDIO" || (assemblies && e.elementType === "ASSEMBLY")).filter((e) => !doc.eid || e.id === doc.eid);
  if (!wanted.length) throw new Error(`No Part Studios${assemblies ? " or Assemblies" : ""} found in ${d.name ? `"${d.name}"` : "that document"}`);
  const existing = new Set(fs.existsSync(path.join(dir, "parts")) ? fs.readdirSync(path.join(dir, "parts")) : []);
  const used = new Set(), results = [];
  for (const [n, el] of wanted.entries()) {
    let name = slug(el.name), k = 2;
    while (used.has(name)) name = `${slug(el.name)}-${k++}`;
    used.add(name);
    if (existing.has(`${name}.part.json`)) { results.push({ element: el.name, kind: el.elementType, status: "skipped", reason: "already imported (use pull to refresh it)", rel: `parts/${name}.part.json` }); continue; }
    onProgress(`Importing ${el.name} (${n + 1}/${wanted.length})`);
    try {
      const r = await importFromOnshape(dir, client, `https://cad.onshape.com/documents/${doc.did}/${wvm}/${wid}/e/${el.id}`, name, { onProgress });
      const feats = parsePart(fs.readFileSync(path.join(dir, r.rel), "utf8")).features ?? [];
      const placeholders = feats.filter((f) => f.type === "onshape").map((f) => f.name ?? f.id);
      results.push({ element: el.name, kind: el.elementType, status: "imported", rel: r.rel, features: feats.length, editable: feats.length - placeholders.length, placeholders, warnings: r.warnings ?? [] });
    } catch (e) { results.push({ element: el.name, kind: el.elementType, status: "failed", reason: e.message }); }
  }
  return { document: d.name ?? "", did: doc.did, results };
}

// ---------- releases ----------
const relFile = (dir) => path.join(dir, ".cadforme", "releases.json");
const readRel = (dir) => { try { return JSON.parse(fs.readFileSync(relFile(dir), "utf8")); } catch { return {}; } };

/** The parts of a project that are linked to Onshape, as { rel, link, part }. */
export function linkedParts(dir) {
  const out = [];
  const walk = (rel = "") => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith(".part.json")) { const i = linkInfo(dir, r); if (i.linked) out.push({ rel: r, link: i, part: parsePart(fs.readFileSync(path.join(dir, r), "utf8")) }); }
    }
  };
  walk();
  return out;
}

const brief = (part) => ({ variables: part.variables ?? {}, features: Object.fromEntries((part.features ?? []).map((f) => [f.id, `${f.type}: ${f.name ?? f.id}`])) });
function diff(prev, now) {
  const lines = [];
  for (const [rel, cur] of Object.entries(now)) {
    const old = prev?.[rel];
    if (!old) { lines.push(`${rel}: new (${Object.keys(cur.features).length} features)`); continue; }
    const add = Object.keys(cur.features).filter((id) => !(id in old.features)).map((id) => `+ ${cur.features[id]}`);
    const del = Object.keys(old.features).filter((id) => !(id in cur.features)).map((id) => `- ${old.features[id]}`);
    const renamed = Object.keys(cur.features).filter((id) => id in old.features && cur.features[id] !== old.features[id]).map((id) => `~ ${old.features[id]} -> ${cur.features[id]}`);
    const vars = Object.keys({ ...cur.variables, ...old.variables }).filter((v) => JSON.stringify(cur.variables[v]) !== JSON.stringify(old.variables[v]))
      .map((v) => (v in old.variables ? (v in cur.variables ? `variable ${v}: ${old.variables[v]} -> ${cur.variables[v]}` : `- variable ${v}`) : `+ variable ${v} = ${cur.variables[v]}`));
    const all = [...add, ...del, ...renamed, ...vars];
    if (all.length) lines.push(`${rel}:`, ...all.map((l) => `  ${l}`));
  }
  for (const rel of Object.keys(prev ?? {})) if (!(rel in now)) lines.push(`${rel}: removed`);
  return lines;
}

/**
 * Make a release: a named Onshape version of the document (a frozen snapshot you can open or restore in Onshape), with a
 * description of what changed in cadForMe since the previous release. Push first so Onshape has the latest.
 */
export async function createRelease(dir, client, name) {
  const parts = linkedParts(dir);
  if (!parts.length) throw new Error("No part is linked to Onshape yet. Import a document or push a part first");
  const docs = [...new Map(parts.map((p) => [p.link.did, p.link])).values()];
  if (docs.length > 1) throw new Error("Parts from different Onshape documents are in this project. Use one project folder per document");
  const link = docs[0];
  if (link.wvm && link.wvm !== "w") throw new Error("This is linked to a read-only Onshape version. Link a workspace to release");
  const state = readRel(dir);
  const now = Object.fromEntries(parts.map((p) => [p.rel, brief(p.part)]));
  const changes = diff(state.last?.parts, now);
  const label = String(name || "").trim() || `Release ${(state.history?.length ?? 0) + 1}`;
  const v = await client.createVersion(link.did, link.wid, label, changes.length ? changes.join("\n").slice(0, 2000) : "No changes since the previous release");
  const entry = { name: label, id: v.id, at: new Date().toISOString(), changes, url: `https://cad.onshape.com/documents/${link.did}/v/${v.id}` };
  fs.mkdirSync(path.dirname(relFile(dir)), { recursive: true });
  fs.writeFileSync(relFile(dir), JSON.stringify({ last: { parts: now }, history: [...(state.history ?? []), entry] }, null, 2));
  return entry;
}

/** Releases (Onshape versions) of the linked document, newest first. */
export async function listReleases(dir, client) {
  const parts = linkedParts(dir);
  if (!parts.length) throw new Error("No part is linked to Onshape yet");
  const out = [];
  for (const link of new Map(parts.map((p) => [p.link.did, p.link])).values()) {
    for (const v of await client.listVersions(link.did)) out.push({ name: v.name, id: v.id, at: v.createdAt, by: v.creator?.name ?? "", description: v.description ?? "", url: `https://cad.onshape.com/documents/${link.did}/v/${v.id}` });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ---------- STEP assembly upload ----------
/** Tab folders of a document as [{ name, nodeId, elementIds }] (Onshape's API can read them, not create them). */
export async function tabFolders(client, did, wid) {
  const r = await client.req("GET", `/documents/d/${did}/w/${wid}/contents`);
  const out = [];
  const walk = (g) => {
    for (const k of g.groups ?? []) {
      if (!String(k.btType).startsWith("BTElementGroup")) continue;
      out.push({ name: k.groupName, nodeId: k.nodeId, elementIds: JSON.stringify(k).match(/"elementId":"(\w+)"/g)?.map((x) => x.slice(13, -1)) ?? [] });
      walk(k);
    }
  };
  walk(r.folders ?? {});
  return out;
}

/**
 * Upload a STEP assembly (e.g. one made by `cadforme step-assembly`) into an Onshape document the way Onshape's Import
 * does: one Assembly per (sub)assembly, the parts in a Part Studio, appearances kept. Waits for the translation, then
 * drops the " (1)" suffixes Onshape adds when a tab name already existed (only where the plain name is free), and
 * records the new tabs in <project>/onshape-import.json. Polls slowly (15 s) to go easy on the API call budget.
 */
export async function importStepAssembly(dir, client, url, filePath, { folder, onProgress = () => {}, pollMs = 15000, maxWaitMs = 2 * 3600e3 } = {}) {
  const doc = parseDocumentUrl(url);
  const wid = doc.wvm && doc.wvm !== "w" ? null : doc.wid ?? (await client.getDocument(doc.did)).defaultWorkspace?.id;
  if (!wid) throw new Error("That link points to a version, which is read-only. Use a workspace link");
  const before = new Map((await client.listElements(doc.did, wid)).map((e) => [e.id, e.name]));
  let group;
  if (folder) {
    group = (await tabFolders(client, doc.did, wid)).find((f) => f.name.toLowerCase() === folder.toLowerCase());
    if (!group) throw new Error(`No tab folder "${folder}" in that document. Create it in Onshape first (the API can't make folders)`);
  }
  const name = path.basename(filePath).replace(/\.(step|stp)$/i, "") + ".step";
  onProgress(`Uploading ${name} (${Math.round(fs.statSync(filePath).size / 1e6)} MB)`);
  const tr = await client.translateFile(doc.did, wid, { name, bytes: fs.readFileSync(filePath), options: { importAppearances: true, ...(group ? { locationGroupId: group.nodeId } : {}) } });
  const tid = tr.translationId ?? tr.id;
  let st = tr.translationId ? { requestState: "ACTIVE" } : tr;
  for (const t0 = Date.now(); !["DONE", "FAILED"].includes(st.requestState);) {
    if (Date.now() - t0 > maxWaitMs) throw new Error(`Onshape is still translating ${name}; check the document later`);
    await new Promise((r) => setTimeout(r, pollMs));
    st = await client.getTranslation(tid);
    onProgress(`Onshape is translating ${name}: ${String(st.requestState).toLowerCase()}`);
  }
  if (st.requestState !== "DONE") throw new Error(`Onshape couldn't translate ${name}: ${st.failureReason ?? st.requestState}`);
  const made = (await client.listElements(doc.did, wid)).filter((e) => !before.has(e.id));
  const taken = new Set([...before.values(), ...made.map((e) => e.name)]);
  const renamed = [];
  for (const e of made.filter((x) => ["ASSEMBLY", "PARTSTUDIO"].includes(x.elementType))) {
    const plain = e.name.replace(/ \(\d+\)(?= parts$|$)/, "");
    if (plain === e.name || taken.has(plain)) continue;
    const md = await client.req("GET", `/metadata/d/${doc.did}/w/${wid}/e/${e.id}`);
    const prop = (md.properties ?? []).find((p) => p.name === "Name");
    if (!prop) continue;
    await client.req("POST", `/metadata/d/${doc.did}/w/${wid}/e/${e.id}`, { properties: [{ propertyId: prop.propertyId, value: plain }] });
    taken.delete(e.name); taken.add(plain); renamed.push({ from: e.name, to: plain }); e.name = plain;
  }
  const inFolder = group ? new Set((await tabFolders(client, doc.did, wid)).find((f) => f.nodeId === group.nodeId)?.elementIds ?? []) : new Set();
  const top = made.find((e) => e.elementType === "ASSEMBLY");   // Onshape lists the top-level assembly first
  const result = {
    did: doc.did, wid, file: name, at: new Date().toISOString(),
    tabs: made.map((e) => ({ type: e.elementType, name: e.name, eid: e.id })),
    renamed, folder: group ? { name: group.name, placed: made.filter((e) => inFolder.has(e.id)).length } : null,
    url: top ? `https://cad.onshape.com/documents/${doc.did}/w/${wid}/e/${top.id}` : `https://cad.onshape.com/documents/${doc.did}/w/${wid}`,
  };
  const log = path.join(dir, "onshape-import.json");
  let prev = []; try { const j = JSON.parse(fs.readFileSync(log, "utf8")); prev = Array.isArray(j) ? j : [j]; } catch { /* first upload */ }
  fs.writeFileSync(log, JSON.stringify([...prev, result], null, 2));
  return result;
}
