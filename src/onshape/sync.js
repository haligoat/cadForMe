// Onshape as a remote for a part: import, pull (3-way merge), push (planned operations).
// Link info lives in the part file under "onshape"; the last-synced Onshape state is stored in the repo at
// onshape/<part>.base.json so teammates share it and it participates in version control.
import fs from "node:fs";
import path from "node:path";
import { onshapeToPart, featureToOs, variableToOs } from "./map.js";
import { nativizePart } from "./nativize.js";
import { bodiesBefore } from "./bodies.js";
import { makeEvaluator } from "../kernel/expr.js";
import { parseOnshapeUrl } from "./client.js";
import { mergeParts } from "../vcs/partmerge.js";
import { formatPart, parsePart } from "../kernel/format.js";

const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v) { return v && typeof v === "object" ? (Array.isArray(v) ? v.map(sortKeys) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))) : v; }

// Onshape re-resolves query ids (deterministicIds behind a queryString) and filter blocks on every fetch, so compare
// features without those volatile parts.
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "filter" || k === "nodeId" || k === "suppressionState" || k === "parameterLibraries") continue;
    if (k === "deterministicIds" && v.queryString) continue;
    out[k] = stable(x);
  }
  return out;
}
const sameFeatures = (a, b) => same(stable(a), stable(b));
const slug = (rel) => path.basename(rel).replace(/\.part\.json$/, "");
const baseFile = (dir, rel) => path.join(dir, "onshape", `${slug(rel)}.base.json`);
const readPart = (dir, rel) => parsePart(fs.readFileSync(path.join(dir, rel), "utf8"));
const writePart = (dir, rel, part) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), formatPart(part)); };
const readBase = (dir, rel) => { try { return JSON.parse(fs.readFileSync(baseFile(dir, rel), "utf8")); } catch { return null; } };
function writeBase(dir, rel, snap) { fs.mkdirSync(path.dirname(baseFile(dir, rel)), { recursive: true }); fs.writeFileSync(baseFile(dir, rel), JSON.stringify(snap, null, 1)); }

const refOf = (link) => ({ did: link.did, wvm: link.wvm ?? "w", wid: link.wid, eid: link.eid });
const idMapOf = (part) => Object.fromEntries((part.features ?? []).filter((f) => f.osId).map((f) => [f.osId, f.id]));
const localForm = (part) => ({ variables: structuredClone(part.variables ?? {}), features: structuredClone(part.features ?? []), varIds: { ...(part.onshape?.varIds ?? {}) } });
const snapshot = (fetched, part) => ({ microversion: fetched.microversion, features: fetched.features, local: localForm(part) });
// The microversion is document-wide (edits in other tabs change it), so when it differs compare this Part Studio's features.
const unchanged = (base, fetched) => (base.microversion && base.microversion === fetched.microversion) || sameFeatures(base.features, fetched.features);
const stripMeta = (f) => { const { osId, ...rest } = f; return rest; };

function requireLink(part) {
  if (!part.onshape?.did) throw new Error("This part isn't linked to Onshape yet");
  return part.onshape;
}

/** Create a new part from an Onshape Part Studio. */
export async function importFromOnshape(dir, client, url, name, { onProgress = () => {} } = {}) {
  const ref = parseOnshapeUrl(url);
  // The link can point at any tab; only Part Studios have features. Assemblies come in as STEP geometry.
  const el = (await client.listElements(ref.did, ref.wid).catch(() => [])).find((e) => e.id === ref.eid);
  if (el && el.elementType === "ASSEMBLY") return importAssemblyAsStep(dir, client, ref, name || el.name, onProgress);
  if (el && el.elementType !== "PARTSTUDIO") throw new Error(`That link is a ${el.elementType === "BILLOFMATERIALS" ? "BOM" : el.elementType.toLowerCase()} tab ("${el.name}"). Open a Part Studio or Assembly tab in Onshape and copy that address instead`);
  const fetched = await client.getFeatures(ref);
  const { part, warnings, varIds } = onshapeToPart(fetched.features, { name });
  const rel = `parts/${(name || "onshape-part").trim().replace(/[^\w.-]+/g, "-")}.part.json`;
  if (fs.existsSync(path.join(dir, rel))) throw new Error(`parts/${path.basename(rel)} already exists. Pick another name`);
  part.onshape = { did: ref.did, wvm: ref.wvm, wid: ref.wid, eid: ref.eid, varIds };
  writePart(dir, rel, part);
  writeBase(dir, rel, snapshot(fetched, part));
  return { rel, warnings, features: part.features.length };
}

/** Import Onshape's current state, reusing the local-form of anything Onshape did not change since the last sync. */
function importTheirs(fetched, base, idMap, name) {
  const t = onshapeToPart(fetched.features, { idMap, name });
  const baseRaw = new Map(base.features.map((f) => [f.featureId, f])), rawNow = new Map(fetched.features.map((f) => [f.featureId, f]));
  const untouched = (osId) => baseRaw.has(osId) && sameFeatures(baseRaw.get(osId), rawNow.get(osId));
  t.part.features = t.part.features.map((f) => (untouched(f.osId) ? base.local.features.find((x) => x.osId === f.osId) ?? f : f));
  for (const [n, osId] of Object.entries(t.varIds)) if (untouched(osId) && n in base.local.variables) t.part.variables[n] = base.local.variables[n];
  return t;
}

/** Bring Onshape changes into the part (CAD-aware 3-way merge against the last synced state). */
export async function pullFromOnshape(dir, client, rel, { resolutions = {} } = {}) {
  const ours = readPart(dir, rel), link = requireLink(ours);
  const base = readBase(dir, rel);
  if (!base?.local) throw new Error("No sync history for this part. Re-import it from Onshape");
  const fetched = await client.getFeatures(refOf(link));
  if (unchanged(base, fetched)) return { status: "up-to-date" };
  const theirs = importTheirs(fetched, base, idMapOf(ours), ours.name);
  const { onshape, ...oursBare } = ours;
  const r = mergeParts({ variables: base.local.variables, features: base.local.features }, oursBare, theirs.part, resolutions);
  if (r.conflicts.length) return { status: "conflicts", conflicts: r.conflicts.map((c) => ({ ...c, path: rel })) };
  const merged = { ...r.merged, onshape: { ...link, varIds: { ...link.varIds, ...theirs.varIds } } };
  writePart(dir, rel, merged);
  // The baseline is what Onshape contains now (not the merge), so local-only edits still show up as pending pushes.
  writeBase(dir, rel, snapshot(fetched, { ...theirs.part, onshape: { varIds: theirs.varIds } }));
  return { status: "merged", warnings: theirs.warnings };
}

/** Work out what Onshape calls a push would make. */
export function planPush(local, baseP, link, baseVarIds = {}) {
  const ops = [], warnings = [];
  const varIds = { ...baseVarIds, ...(link.varIds ?? {}) };
  for (const [n, v] of Object.entries(local.variables ?? {})) {
    if (!(n in baseP.variables)) ops.push({ op: "add", kind: "variable", name: n, label: `Add variable ${n}`, os: variableToOs(n, v) });
    else if (!same(v, baseP.variables[n])) ops.push({ op: "update", kind: "variable", name: n, osId: varIds[n], label: `Update variable ${n}`, os: variableToOs(n, v) });
  }
  const baseById = new Map(baseP.features.map((f) => [f.id, f]));
  const localIds = new Set(local.features.map((f) => f.id));
  for (const f of local.features) {
    if (f.type === "onshape") continue;
    const b = baseById.get(f.id);
    // A feature that was never sent (no osId) is added, even if the last sync knew it under the same id.
    if (!b || !b.osId) ops.push({ op: "add", kind: "feature", id: f.id, label: `Add ${f.type} "${f.name ?? f.id}"`, feature: f });
    else if (!same(stripMeta(f), stripMeta(b))) ops.push({ op: "update", kind: "feature", id: f.id, osId: b.osId, label: `Update ${f.type} "${f.name ?? f.id}"`, feature: f });
  }
  for (const [n] of Object.entries(baseP.variables)) if (!(n in (local.variables ?? {}))) ops.push({ op: "delete", kind: "variable", name: n, osId: varIds[n], label: `Delete variable ${n}` });
  for (const b of [...baseP.features].reverse()) if (!localIds.has(b.id)) ops.push({ op: "delete", kind: "feature", id: b.id, osId: b.osId, label: `Delete ${b.type} "${b.name ?? b.id}"` });
  return { ops, warnings };
}

/** Preview (dryRun) or perform a push of the part to Onshape. */
export async function pushToOnshape(dir, client, rel, { dryRun = false } = {}) {
  const link = requireLink(readPart(dir, rel));
  if (link.wvm && link.wvm !== "w") throw new Error("This part is linked to an Onshape version, which is read-only. Link a workspace to push");
  // Boxes and cylinders go over as sketch + extrude (the part file is rewritten to match, same geometry).
  const nat = nativizePart(readPart(dir, rel));
  const local = nat.part;
  const base = readBase(dir, rel) ?? { microversion: null, features: [], local: { variables: {}, features: [], varIds: {} } };
  const fetched = await client.getFeatures(refOf(link));
  if (!unchanged(base, fetched)) throw new Error("Onshape has changes you don't have. Pull first, then push");
  const baseP = base.local, baseVarIds = base.local.varIds ?? {};
  const plan = planPush(local, baseP, link, baseVarIds);
  const osIdOf = new Map(local.features.filter((f) => f.osId).map((f) => [f.id, f.osId]));
  const warnings = [...nat.warnings, ...plan.warnings];
  const byIdAll = new Map(local.features.map((f) => [f.id, f]));
  const before = bodiesBefore(local.features);
  const ev = makeEvaluator({ ...(local.variables ?? {}), ...(local.configs?.[local.config] ?? {}) });
  const ctx = { warnings, osIdOf: (id) => osIdOf.get(id), feature: (id) => byIdAll.get(id), features: local.features, bodiesAt: (id) => before.get(id), ev };
  const describe = [...nat.changed, ...plan.ops.map((o) => o.label)];
  if (dryRun) {
    for (const o of plan.ops) if (o.kind === "feature" && o.op !== "delete") { const os = featureToOs(o.feature, { ...ctx, osIdOf: (id) => osIdOf.get(id) ?? `(new ${id})` }); if (!os) o.skipped = true; }
    return { status: "preview", converted: nat.changed, ops: plan.ops.map((o) => ({ op: o.op, label: o.label, skipped: !!o.skipped })), warnings };
  }
  if (!plan.ops.length) return { status: "up-to-date" };
  const varIds = { ...baseVarIds, ...(link.varIds ?? {}) };
  const errors = [];
  let applied = 0, skippedFeatures = 0;
  const note = (res, label) => { const st = res?.featureState; if (st && st.featureStatus && st.featureStatus !== "OK") errors.push(`${label}: Onshape says ${st.featureStatus}${st.featureError ? ` (${st.featureError})` : ""}`); };
  const byId = new Map(local.features.map((f) => [f.id, f]));
  for (const o of plan.ops.filter((x) => x.op !== "delete")) {
    if (o.kind === "variable") {
      if (o.op === "add") { const r = await client.addFeature(refOf(link), o.os); varIds[o.name] = r.feature?.featureId; note(r, o.label); } else { await client.updateFeature(refOf(link), o.osId ?? varIds[o.name], o.os); }
      applied++; continue;
    }
    const os = featureToOs(o.feature, ctx);
    if (!os) { skippedFeatures++; continue; }
    if (o.op === "add") { const r = await client.addFeature(refOf(link), os); const fid = r.feature?.featureId; if (fid) { osIdOf.set(o.id, fid); byId.get(o.id).osId = fid; } note(r, o.label); }
    else { const r = await client.updateFeature(refOf(link), o.osId, os); note(r, o.label); }
    applied++;
  }
  for (const o of plan.ops.filter((x) => x.op === "delete")) {
    const fid = o.osId ?? (o.kind === "variable" ? varIds[o.name] : null);
    if (fid) { await client.deleteFeature(refOf(link), fid); applied++; }
    if (o.kind === "variable") delete varIds[o.name];
  }
  if (applied === 0 && skippedFeatures > 0) return { status: "nothing-sent", skipped: skippedFeatures, warnings, errors, describe };
  let named = 0;
  if (plan.ops.some((o) => o.kind === "feature" && o.op !== "delete")) {
    try { named = await nameOnshapeParts(client, refOf(link), local.features); } catch (e) { if (e.status !== 404) warnings.push(`Couldn't name the Onshape parts: ${e.message}`); }
  }
  const after = await client.getFeatures(refOf(link));
  const saved = { ...local, features: local.features, onshape: { ...link, varIds } };
  writePart(dir, rel, saved);
  writeBase(dir, rel, snapshot(after, saved));
  return { status: "pushed", applied, named, skipped: skippedFeatures, warnings, errors, describe };
}

/** Send a part to a brand new Part Studio (in an existing document link, or a new document). */
export async function linkNewPartStudio(dir, client, rel, { url, documentName } = {}) {
  const part = readPart(dir, rel);
  // cadSlop only ever writes into the Part Studio you point it at; it never creates documents.
  if (!url) throw new Error("Paste the link of the Onshape Part Studio to send to. cadSlop never creates new documents.");
  const ref = parseOnshapeUrl(url);
  const fetched = await client.getFeatures(ref);
  if (fetched.features.length) throw new Error("That Part Studio already has features in it. Import it instead, or give a link to an empty one.");
  writePart(dir, rel, { ...part, onshape: { did: ref.did, wvm: ref.wvm ?? "w", wid: ref.wid, eid: ref.eid, varIds: {} } });
  writeBase(dir, rel, { microversion: null, features: [], local: { variables: {}, features: [], varIds: {} } });
  return ref;
}

export const onshapeUrl = (link, base = "https://cad.onshape.com") => `${base}/documents/${link.did}/${link.wvm ?? "w"}/${link.wid}/e/${link.eid}`;
export function linkInfo(dir, rel) {
  try { const p = readPart(dir, rel); return p.onshape?.did ? { linked: true, ...p.onshape, hasBase: !!readBase(dir, rel) } : { linked: false }; } catch { return { linked: false }; }
}

/**
 * Build (or rebuild) an Onshape Assembly tab from the part's linked Part Studio: every part is inserted at the position
 * it has in the Part Studio, then fixed, so the assembly matches the CAD and its BOM lists every part.
 * The assembly tab id is remembered in the part's `onshape.asm` so re-running refreshes the same tab.
 */
export async function pushAssembly(dir, client, rel, { name } = {}) {
  const part = readPart(dir, rel), link = requireLink(part);
  if (link.wvm && link.wvm !== "w") throw new Error("This part is linked to an Onshape version, which is read-only. Link a workspace to build an assembly");
  const els = await client.listElements(link.did, link.wid);
  const asmName = name || `${part.name ?? slug(rel)} assembly`;
  let asm = els.find((e) => e.id === link.asm && e.elementType === "ASSEMBLY") ?? els.find((e) => e.elementType === "ASSEMBLY" && e.name === asmName);
  if (!asm) {
    // Reuse an untouched default "Assembly 1"-style tab before making a new one.
    for (const e of els.filter((x) => x.elementType === "ASSEMBLY").slice(0, 3)) {
      const a = await client.getAssembly({ ...link, eid: e.id });
      if (!(a.rootAssembly?.instances ?? []).length) { asm = e; break; }
    }
  }
  if (!asm) asm = await client.createAssembly(link.did, link.wid, asmName);
  const aref = { did: link.did, wvm: "w", wid: link.wid, eid: asm.id };
  // Replace the instances that came from this Part Studio (other instances in the assembly are left alone).
  const before = await client.getAssembly(aref);
  const ours = (before.rootAssembly?.instances ?? []).filter((i) => i.elementId === link.eid);
  for (const i of ours) await client.deleteInstance(aref, i.id);
  await client.insertPartStudio(aref, link);
  const after = await client.getAssembly(aref);
  const inst = (after.rootAssembly?.instances ?? []).filter((i) => i.elementId === link.eid);
  // Fix every instance where it landed (the Part Studio positions), so dragging in Onshape can't scatter the robot.
  const occ = inst.map((i) => ({ btType: "BTMIndividualOccurrenceQuery-626", path: [i.id] }));
  if (occ.length) {
    try {
      await client.addAssemblyFeature(aref, { btType: "BTMAssemblyFeature-1173", featureType: "fixedGroup", name: "Fix from Part Studio", suppressed: false, returnAfterSubfeatures: false,
        parameters: [{ btType: "BTMParameterQueryList-148", parameterId: "occurrences", queries: occ }] });
    } catch { /* group/fix is a convenience; the instances are already placed */ }
  }
  writePart(dir, rel, { ...part, onshape: { ...link, asm: asm.id } });
  return { status: "assembled", instances: inst.length, name: asm.name ?? asmName, url: `https://cad.onshape.com/documents/${link.did}/w/${link.wid}/e/${asm.id}` };
}

const strings = (v, out = []) => { if (typeof v === "string") out.push(v); else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out); return out; };
/**
 * Name each Onshape part after the cadSlop feature that created it ("Flywheel", "Left mecanum wheels 2"), so the
 * Parts list and the assembly BOM read like the design. Parts someone renamed in Onshape keep their name.
 */
export async function nameOnshapeParts(client, ref, features) {
  const named = features.filter((f) => f.osId && f.name && ["extrude", "revolve", "loft", "sweep"].includes(f.type));
  if (!named.length) return 0;
  const ids = named.map((f) => `"${f.osId}"`).join(", ");
  const script = `function(context is Context, queries) {
    var out = [];
    for (var fid in [${ids}]) {
      for (var b in evaluateQuery(context, qCreatedBy(makeId(fid), EntityType.BODY)))
        if (!isQueryEmpty(context, qBodyType(qOwnerBody(b), BodyType.SOLID))) out = append(out, fid ~ "|" ~ transientQueriesToStrings(b));
    }
    return out;
  }`;
  const res = await client.evalFeatureScript(ref, script);
  const byFeature = new Map();
  for (const s of strings(res.result ?? res)) { const m = s.match(/^([^|]+)\|(.+)$/); if (m) { if (!byFeature.has(m[1])) byFeature.set(m[1], []); byFeature.get(m[1]).push(m[2]); } }
  // read every part's name at once (4 at a time), then rename only the ones that need it
  const wanted = [];
  for (const f of named) {
    const pids = [...new Set(byFeature.get(f.osId) ?? [])];
    for (const [i, pid] of pids.entries()) wanted.push({ f, pid, want: pids.length > 1 ? `${f.name} ${i + 1}` : f.name });
  }
  const metas = new Array(wanted.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => { for (let i = next++; i < wanted.length; i = next++) metas[i] = await client.getPartMetadata(ref, wanted[i].pid); }));
  let count = 0;
  for (const [i, { f, pid, want }] of wanted.entries()) {
    const prop = (metas[i].properties ?? []).find((p) => p.name === "Name");
    if (!prop || prop.value === want) continue;
    if (!/^Part \d+$/.test(prop.value ?? "") && !String(prop.value).startsWith(f.name)) continue; // renamed by someone in Onshape
    await client.setPartMetadata(ref, pid, [{ propertyId: prop.propertyId, value: want }]);
    count++;
  }
  return count;
}

/**
 * Upload a STEP file into the linked Onshape document, let Onshape translate it (assemblies kept), and insert the result
 * into the part's Onshape assembly, moved `offset` mm along X so it lands beside what's already there.
 */
export async function addStepToAssembly(dir, client, rel, filePath, { offset = 0, onProgress = () => {} } = {}) {
  const part = readPart(dir, rel), link = requireLink(part);
  if (!link.asm) throw new Error("Build the Onshape assembly first (Onshape → Build Onshape assembly)");
  const name = path.basename(filePath).replace(/\.(step|stp)(-\d+)?$/i, "") + ".step";
  const before0 = new Set((await client.listElements(link.did, link.wid)).map((e) => e.id));
  onProgress(`Uploading ${name}`);
  const tr = await client.translateFile(link.did, link.wid, { name, bytes: fs.readFileSync(filePath) });
  const tid = tr.translationId ?? tr.id;
  let st = tr.translationId ? { requestState: "ACTIVE" } : tr;
  st = await client.waitTranslation(tid, st, { onState: (s) => onProgress(`Onshape is translating ${name} (${s})`) });
  if (st.requestState !== "DONE") throw new Error(`Onshape couldn't translate ${name}: ${st.failureReason ?? st.requestState}`);
  const els = await client.listElements(link.did, link.wid);
  const made = els.filter((e) => ((st.resultElementIds ?? []).includes(e.id) || !before0.has(e.id)) && !["BLOB", "BILLOFMATERIALS"].includes(e.elementType));
  // Prefer the top-level assembly Onshape made from the file; otherwise the part studio.
  const stem = name.replace(/\.step$/i, "");
  const top = made.find((e) => e.elementType === "ASSEMBLY" && e.name === stem) ?? made.find((e) => e.elementType === "ASSEMBLY") ?? made.find((e) => e.elementType === "PARTSTUDIO");
  if (!top) throw new Error("Onshape translated the file but made nothing that can go in an assembly");
  const aref = { did: link.did, wvm: "w", wid: link.wid, eid: link.asm };
  const before = new Set(((await client.getAssembly(aref)).rootAssembly?.instances ?? []).map((i) => i.id));
  const src = { did: link.did, eid: top.id };
  if (top.elementType === "ASSEMBLY") await client.insertAssembly(aref, src); else await client.insertPartStudioElement(aref, src);
  const added = ((await client.getAssembly(aref)).rootAssembly?.instances ?? []).filter((i) => !before.has(i.id));
  if (offset && added.length) {
    const m = offset / 1000;
    await client.transformOccurrences(aref, { isRelative: true, occurrences: added.map((i) => ({ path: [i.id] })), transform: [1, 0, 0, m, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  }
  return { status: "added", name, tabs: made.map((e) => `${e.name} (${e.elementType.toLowerCase()})`), instances: added.length, url: `https://cad.onshape.com/documents/${link.did}/w/${link.wid}/e/${link.asm}` };
}

const fileSafe = (n) => String(n || "onshape").trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "onshape";
/** Export an Onshape assembly as STEP into imports/ and make a part that shows it (geometry only, not linked). */
async function importAssemblyAsStep(dir, client, ref, name, onProgress) {
  const slugName = fileSafe(name);
  const rel = `parts/${slugName}.part.json`;
  if (fs.existsSync(path.join(dir, rel))) throw new Error(`parts/${slugName}.part.json already exists. Pick another name`);
  onProgress("Asking Onshape to export the assembly as STEP");
  const tr = await client.exportStep(ref, "ASSEMBLY");
  let st = tr;
  st = await client.waitTranslation(tr.id, st, { onState: (s) => onProgress(`Onshape is exporting (${s})`) });
  if (st.requestState !== "DONE" || !st.resultExternalDataIds?.length) throw new Error(`Onshape couldn't export the assembly: ${st.failureReason ?? st.requestState}`);
  const bytes = await client.downloadExternal(ref.did, st.resultExternalDataIds[0]);
  fs.mkdirSync(path.join(dir, "imports"), { recursive: true });
  const file = `imports/${slugName}.step`;
  fs.writeFileSync(path.join(dir, file), bytes);
  writePart(dir, rel, { name, variables: {}, features: [{ id: "im1", type: "import", name: `${name} (from Onshape)`, file, mode: "new" }] });
  return { rel, warnings: ["Assemblies come in as STEP geometry (not editable features). To edit in cadSlop, import a Part Studio link instead."], features: 1 };
}

/**
 * Send the finished 3D model into the part's linked Onshape document as a STEP file. Onshape translates it into a new
 * Part Studio tab (named after the part); the document's other tabs are never touched.
 */
export async function uploadModelAsStep(dir, client, rel, filePath, { name, assembly = false, onProgress = () => {} } = {}) {
  const part = readPart(dir, rel), link = requireLink(part);
  const stem = (name || part.name || slug(rel)).replace(/[^\w. -]+/g, "-");
  const before = new Set((await client.listElements(link.did, link.wid)).map((e) => e.id));
  onProgress(`Uploading ${stem}.step`);
  const tr = await client.translateFile(link.did, link.wid, { name: `${stem}.step`, bytes: fs.readFileSync(filePath) });
  const tid = tr.translationId ?? tr.id;
  let st = tr.translationId ? { requestState: "ACTIVE" } : tr;
  st = await client.waitTranslation(tid, st, { onState: (s) => onProgress(`Onshape is translating (${s})`) });
  if (st.requestState !== "DONE") throw new Error(`Onshape couldn't translate the model: ${st.failureReason ?? st.requestState}`);
  const made = (await client.listElements(link.did, link.wid)).filter((e) => !before.has(e.id) && !["BLOB", "BILLOFMATERIALS"].includes(e.elementType));
  const tabs = made.map((e) => `${e.name} (${e.elementType.toLowerCase().replace("partstudio", "part studio")})`);
  // Optionally also make an Assembly tab (new, in the same document) holding every uploaded part where it sits.
  const studio = made.find((e) => e.elementType === "PARTSTUDIO");
  if (assembly && studio) {
    onProgress("Building the assembly");
    const asm = await client.createAssembly(link.did, link.wid, `${stem} assembly`);
    const aref = { did: link.did, wvm: "w", wid: link.wid, eid: asm.id };
    await client.insertPartStudio(aref, { did: link.did, eid: studio.id });
    const inst = ((await client.getAssembly(aref)).rootAssembly?.instances ?? []).filter((i) => i.elementId === studio.id);
    if (inst.length) {
      try { await client.addAssemblyFeature(aref, { btType: "BTMAssemblyFeature-1173", featureType: "fixedGroup", name: "Fix from Part Studio", suppressed: false, returnAfterSubfeatures: false,
        parameters: [{ btType: "BTMParameterQueryList-148", parameterId: "occurrences", queries: inst.map((i) => ({ btType: "BTMIndividualOccurrenceQuery-626", path: [i.id] })) }] }); } catch { /* convenience only */ }
    }
    tabs.push(`${asm.name ?? `${stem} assembly`} (assembly, ${inst.length} parts)`);
  }
  return { status: "uploaded", tabs, url: `https://cad.onshape.com/documents/${link.did}/w/${link.wid}` };
}
