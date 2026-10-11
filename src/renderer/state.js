// Application state: the open project/part, undo/redo, autosave, geometry builds, and version-control status.
import { formatPart, parsePart } from "../kernel/format.js";
import { FEATURES, defaultsFor } from "./features.js";
import { debounce, toast } from "./ui.js";
import { initSolver } from "../kernel/sketch2.js";
import { isAssembly, solveMates, instances } from "./assembly.js";

fetch("planegcs.wasm").then((r) => r.arrayBuffer()).then(initSolver).then(() => emit()).catch((e) => toast(`Sketch solver failed to load: ${e.message}`, "err"));

export const S = {
  project: null, partPath: null, part: null, rollback: null, selection: null, draft: null,
  sketchEdit: null, pick: null, picks: [], tab: "design", error: null,
  build: { meshes: [], stats: [], errors: {}, variables: {}, busy: false, ms: 0 },
  ghostBuild: null, view: null, showGhost: true,
  undo: [], redo: [], lastCoalesce: null, lastEditAt: 0, lastWritten: null,
  vc: { status: null, log: null, branches: null, sel: null, diff: null, busy: false },
  settings: { author: { name: "", email: "" }, recent: [], hasToken: false },
  hint: "", showPlanes: false, hidden: new Set(), measure: null, section: null, sel: null,
};

const subs = new Set(), buildSubs = new Set();
export const onChange = (f) => { subs.add(f); return () => subs.delete(f); };
export const onBuild = (f) => { buildSubs.add(f); return () => buildSubs.delete(f); };
let pending = false;
export function emit() { if (pending) return; pending = true; queueMicrotask(() => { pending = false; subs.forEach((f) => f()); }); }

// ---------- geometry worker ----------
let worker = null;
const waiting = new Map(); let nextId = 1;
/** (Re)start the geometry engine. A crashed engine (out of wasm memory) is replaced; anything still waiting on it fails. */
function startWorker() {
  if (worker) { worker.terminate(); for (const [, w] of waiting) w.rej(new Error("The geometry engine was restarted")); waiting.clear(); }
  worker = new Worker("worker.js");
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id); if (!w) return;
    if (data.progress) { w.onProgress?.(data.progress); return; }
    waiting.delete(data.id); data.ok ? w.res(data.result) : w.rej(new Error(data.error));
  };
  worker.onerror = (e) => toast(`Geometry engine error: ${e.message}`, "err");
}
startWorker();
// messages the engine gives once its memory is corrupt; every later build would fail the same way until it is restarted
const ENGINE_CRASH = /table index is out of bounds|memory access out of bounds|unreachable|has been deleted|Aborted\(|couldn't be loaded/i;
const fileCache = new Map();
export const forgetFile = (rel) => fileCache.delete(rel);
async function filesFor(part, out = {}, depth = 0) {
  for (const f of part.features ?? []) {
    if (f.suppressed) continue;
    if (f.type === "import" && f.file && !out[f.file]) {
      if (!fileCache.has(f.file)) { try { fileCache.set(f.file, await window.cad.invoke("fs:readBinary", f.file)); } catch { continue; } }
      out[f.file] = fileCache.get(f.file);
    } else if (f.type === "insert" && f.part && !out[f.part] && depth < 6) {
      try {
        const bytes = await window.cad.invoke("fs:readBinary", f.part); // always fresh: the inserted part may have been edited
        out[f.part] = bytes;
        await filesFor(JSON.parse(new TextDecoder().decode(bytes)), out, depth + 1);
      } catch { /* shown as the feature's error */ }
    }
  }
  return out;
}
const send = (type, part, upTo, files) => new Promise((res, rej) => { const id = nextId++; waiting.set(id, { res, rej }); worker.postMessage({ id, type, part, upTo, files }); });
const ask = async (type, part, upTo) => send(type, part, upTo, await filesFor(part));
/** Files a part pulls in (inserted parts, imported STEP), for cache keys. */
export const partFiles = (part) => filesFor(part);
/** DRC one part in the geometry engine; onProgress gets { label, index, total, frac? }. */
export function drcInWorker(part, files, rules, onProgress) {
  return new Promise((res, rej) => { const id = nextId++; waiting.set(id, { res, rej, onProgress }); worker.postMessage({ id, type: "drc", part, files, rules }); });
}
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
/** Build with an on-disk cache: the key covers the part, the rollback position and every imported/inserted file's bytes. */
async function buildCached(part, upTo) {
  const files = await filesFor(part);
  const enc = new TextEncoder(), parts = [enc.encode(JSON.stringify({ v: 2, part, upTo: upTo ?? null }))];
  for (const k of Object.keys(files).sort()) parts.push(enc.encode(k), new Uint8Array(await crypto.subtle.digest("SHA-1", files[k])));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const key = hex(await crypto.subtle.digest("SHA-1", all));
  try { const hit = await cacheGet(key); if (hit) return { ...hit, cached: true }; } catch { /* no cache: build */ }
  let result = await send("build", part, upTo, files);
  if (Object.values(result.errors ?? {}).some((m) => ENGINE_CRASH.test(String(m)))) {   // crashed engine: fresh one, build again
    startWorker();
    result = await send("build", part, upTo, files);
  }
  if (!Object.keys(result.errors ?? {}).length) cachePut(key, result).catch(() => {});
  return result;
}
// finished builds live in IndexedDB (big binary results stay in this window; the newest 4 are kept)
let cacheDb = null;
const openCache = () => cacheDb ??= new Promise((res, rej) => { const r = indexedDB.open("cadslop-buildcache", 1); r.onupgradeneeded = () => r.result.createObjectStore("builds"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = async (mode, fn) => { const db = await openCache(); return new Promise((res, rej) => { const t = db.transaction("builds", mode); const out = fn(t.objectStore("builds")); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); }); };
const cacheGet = (key) => tx("readwrite", (st) => { const g = st.get(key); g.onsuccess = () => { if (g.result) st.put({ ...g.result, at: Date.now() }, key); }; return g; }).then((v) => v?.result ?? null);
async function cachePut(key, result) {
  await tx("readwrite", (st) => st.put({ result, at: Date.now() }, key));
  const all = []; await tx("readonly", (st) => { const c = st.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { all.push([cur.key, cur.value.at]); cur.continue(); } }; });
  const old = all.sort((a, b) => b[1] - a[1]).slice(4);
  if (old.length) await tx("readwrite", (st) => old.forEach(([k]) => st.delete(k)));
}

let buildSeq = 0;
export async function rebuild() {
  const seq = ++buildSeq;
  const doc = S.view ? S.view.part : S.part;
  if (!doc) { S.build = { meshes: [], stats: [], errors: {}, variables: {}, busy: false, ms: 0 }; S.ghostBuild = null; buildSubs.forEach((f) => f()); emit(); return; }
  S.build.busy = true; emit();
  const t0 = performance.now();
  try {
    const upTo = S.view ? undefined : S.rollback ?? undefined;
    const [main, ghost] = await Promise.all([buildCached(doc, upTo), S.view && S.showGhost && S.part ? ask("build", S.part) : null]);
    if (seq !== buildSeq) return;
    S.build = { ...main, busy: false, ms: Math.round(performance.now() - t0) };
    S.ghostBuild = ghost;
  } catch (e) {
    if (seq !== buildSeq) return;
    S.build = { ...S.build, busy: false, errors: { _: e.message } };
  }
  buildSubs.forEach((f) => f());
  emit();
}
export const scheduleBuild = debounce(rebuild, 70);

/** The finished 3D model as STEP bytes (what Onshape can take when the features themselves can't be sent). */
export async function modelStepBytes() { return ask("stepNew", S.part); }

export async function exportPart(kind) {
  const doc = S.view ? S.view.part : S.part;
  if (!doc) return;
  try {
    const { bytes } = await ask(kind, doc);
    const name = (doc.name || S.partPath?.split("/").pop()?.replace(".part.json", "") || "part").replace(/[^\w.-]+/g, "_");
    const saved = await window.cad.invoke("export:save", { name: kind === "drawing" ? `${name}_drawing` : name, ext: kind === "drawing" ? "svg" : kind, bytes });
    if (saved) toast(`Exported ${saved}`, "ok");
  } catch (e) { toast(e.message, "err"); }
}

// ---------- projects & parts ----------
export async function loadSettings() { S.settings = await window.cad.invoke("settings:get"); emit(); }

export async function setProject(info) {
  S.project = info; S.partPath = null; S.part = null; S.view = null; S.error = null; resetSession();
  await loadSettings();
  const first = info.parts[0];
  // Like a new Onshape document: an empty project starts with one empty Part Studio, so the tools work straight away.
  if (first) await loadPart(first); else await createPart("Part Studio 1");
  scanKinds();
  await refreshVcs(); await refreshLog();
}
function resetSession() { S.undo = []; S.redo = []; S.rollback = null; S.selection = null; S.sketchEdit = null; S.pick = null; S.draft = null; S.picks = []; }

export async function loadPart(rel) {
  try {
    const text = await window.cad.invoke("fs:read", rel);
    S.view = null; S.partPath = rel; S.part = parsePart(text); S.lastWritten = text; S.error = null; resetSession();
  } catch (e) { toast(`Couldn't open ${rel}: ${e.message}`, "err"); return; }
  rebuild(); emit();
}

export async function refreshParts() {
  if (!S.project) return;
  S.project.parts = await window.cad.invoke("fs:list");
  if (S.partPath && !S.project.parts.includes(S.partPath)) { S.partPath = null; S.part = null; rebuild(); }
  emit();
}

export async function createPart(name, { assembly = false } = {}) {
  const slug = name.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "part";
  const rel = `parts/${slug}.part.json`;
  if (S.project.parts.includes(rel)) { toast(`There's already a part called ${slug}`, "err"); return; }
  await window.cad.invoke("fs:write", rel, formatPart({ name: name.trim(), ...(assembly ? { kind: "assembly" } : {}), variables: {}, features: [] }));
  S.kinds = { ...(S.kinds ?? {}), [rel]: assembly ? "assembly" : "part" };
  await refreshParts(); await loadPart(rel); scheduleVcs();
}

export async function deletePart(rel) {
  await window.cad.invoke("fs:delete", rel);
  if (S.partPath === rel) { S.part = null; S.partPath = null; resetSession(); rebuild(); }
  await refreshParts(); scheduleVcs();
}

// ---------- editing ----------
export function edit(mut, { coalesce } = {}) {
  if (S.view) { toast("You're viewing an old version (read-only). Go back to the current version to edit", "err"); return false; }
  if (!S.part) return false;
  const before = JSON.stringify(S.part);
  const next = structuredClone(S.part);
  mut(next);
  if (isAssembly(next)) S.mateProblems = solveMates(next);
  const after = JSON.stringify(next);
  if (before === after) return false;
  const now = Date.now();
  if (!(coalesce && S.lastCoalesce === coalesce && now - S.lastEditAt < 1500)) { S.undo.push(before); if (S.undo.length > 200) S.undo.shift(); }
  S.lastCoalesce = coalesce ?? null; S.lastEditAt = now; S.redo.length = 0;
  S.part = next; scheduleSave(); scheduleBuild(); emit();
  return true;
}
export function undo() { step(S.undo, S.redo); }
export function redo() { step(S.redo, S.undo); }
function step(from, to) {
  if (!from.length || S.view) return;
  to.push(JSON.stringify(S.part));
  S.part = JSON.parse(from.pop()); S.lastCoalesce = null;
  if (S.selection && !S.part.features.some((f) => f.id === S.selection)) S.selection = null;
  scheduleSave(); scheduleBuild(); emit();
}

export const saveNow = async () => {
  if (!S.part || !S.partPath || S.view) return;
  const text = formatPart(S.part);
  if (text === S.lastWritten) return;
  S.lastWritten = text;
  try { await window.cad.invoke("fs:write", S.partPath, text); scheduleVcs(); }
  catch (e) { toast(`Couldn't save: ${e.message}`, "err"); }
};
const scheduleSave = debounce(saveNow, 350);

/** The bridge for edits made outside the app (an AI, a text editor, a git-style pull). */
export async function onExternalChange(rel) {
  forgetFile(rel);
  if (rel === S.partPath && !S.view) {
    try {
      const text = await window.cad.invoke("fs:read", rel);
      if (text === S.lastWritten) return;
      const part = parsePart(text);
      S.undo.push(JSON.stringify(S.part)); S.redo.length = 0;
      S.part = part; S.lastWritten = text; S.error = null;
      if (S.selection && !part.features.some((f) => f.id === S.selection)) S.selection = null;
      toast(`${rel} changed on disk. Reloaded`);
      rebuild();
    } catch (e) {
      S.error = `${rel} can't be read: ${e.message}. Showing the last good version`;
    }
  }
  if (rel.endsWith(".part.json")) refreshParts();
  scheduleVcs(); emit();
}

// ---------- features ----------
/** Variables with the active configuration applied (matches the kernel). */
export const effVars = (part = S.part) => ({ ...(part?.variables ?? {}), ...(part?.configs?.[part?.config] ?? {}) });
export const featIndex = (id) => S.part?.features.findIndex((f) => f.id === id) ?? -1;
export const feature = (id) => S.part?.features.find((f) => f.id === id);

function uniqueId(part, type) {
  const base = { sketch: "sk", extrude: "ex", revolve: "rv", fillet: "fl", chamfer: "ch", shell: "sh", hole: "ho", linearPattern: "lp", circularPattern: "cp", mirror: "mi", box: "bx", cylinder: "cy", sphere: "sp", transform: "tr", boolean: "bo", deleteBody: "db", gear: "ge", coil: "co", insert: "in", plane: "pl", loft: "lo", sweep: "sw", split: "sp", import: "im" }[type] ?? "f";
  const used = new Set(part.features.map((f) => f.id));
  let n = 1; while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}
function niceName(part, type) {
  const n = part.features.filter((f) => f.type === type).length + 1;
  return `${FEATURES[type].label} ${n}`;
}
export function usedSketches(part = S.part) { return new Set(part.features.filter((f) => f.sketch).map((f) => f.sketch)); }

const uniqueName = (p, base) => { let n = 1; while (p.features.some((f) => f.name === `${base} <${n}>`)) n++; return `${base} <${n}>`; };
/** Which project files are assemblies (for icons and the Insert list). */
export async function scanKinds() {
  const kinds = {};
  for (const rel of S.project?.parts ?? []) { try { kinds[rel] = parsePart(await window.cad.invoke("fs:read", rel)).kind === "assembly" ? "assembly" : "part"; } catch { kinds[rel] = "part"; } }
  S.kinds = kinds; emit();
}
/** Overlapping volume between instances / bodies (runs in the geometry worker). */
export const checkInterference = () => ask("interference", S.part);

export function addFeature(type, extra = {}) {
  if (!S.part) { toast("Open or create a part first", "err"); return null; }
  const used = usedSketches();
  // Only sketches with something drawn in them are worth extruding/revolving (empty ones would just error).
  const drawn = (f) => (f.geom ?? []).some((g) => g.t !== "point" && !g.construction) || (f.entities ?? []).length > 0;
  const sketches = S.part.features.filter((f) => f.type === "sketch" && !f.suppressed && drawn(f)).map((f) => f.id);
  const ctx = { sketches, unusedSketches: sketches.filter((s) => !used.has(s)), bodies: S.build.stats.length };
  if ((type === "loft" || type === "sweep") && sketches.length < 2) { toast(`A ${type} needs two sketches${type === "sweep" ? " (a profile and a path)" : ""}`, "err"); return null; }
  if ((type === "extrude" || type === "revolve") && !sketches.length) { toast(S.part.features.some((f) => f.type === "sketch") ? "Draw a shape in your sketch first, then extrude it" : "Make a sketch first (Sketch tool), then extrude it", "err"); return null; }
  let id = null;
  edit((p) => {
    id = uniqueId(p, type);
    const at = S.rollback === null ? p.features.length : S.rollback + 1;
    const f = { id, type, name: niceName(p, type), ...defaultsFor(type, ctx), ...extra };
    if (isAssembly(p) && type === "insert") {
      // Assembly instance: placed with position + 3D rotation; the first one is fixed (like Onshape's first insert)
      for (const k of ["rotate", "axis", "origin", "scale"]) delete f[k];
      Object.assign(f, { position: f.position ?? [0, 0, 0], orient: [0, 0, 0], mode: "new", fixed: !instances(p).length });
      if (!f.part) f.part = S.project.parts.find((r) => r !== S.partPath && S.kinds?.[r] !== "assembly") ?? S.project.parts.find((r) => r !== S.partPath) ?? "";
      if (f.part) f.name = uniqueName(p, String(f.part).split("/").pop().replace(".part.json", "").replace(/[-_]+/g, " "));
    }
    p.features.splice(at, 0, f);
    S.rollback = S.rollback === null ? null : at;
  });
  S.selection = id; S.draft = id; S.sketchEdit = type === "sketch" ? id : null; S.picks = [];
  S.pick = type === "fillet" || type === "chamfer" ? { kind: "edges", id } : type === "shell" ? { kind: "faces", id } : type === "hole" ? { kind: "point", id } : null;
  emit();
  return id;
}

export function deleteFeature(id) {
  edit((p) => { p.features = p.features.filter((f) => f.id !== id); });
  if (S.selection === id) { S.selection = null; S.pick = null; S.sketchEdit = null; S.draft = null; }
  if (S.rollback !== null) S.rollback = Math.min(S.rollback, S.part.features.length - 1);
  emit();
}
export function duplicateFeature(id) {
  let nid = null;
  edit((p) => {
    const i = p.features.findIndex((f) => f.id === id); if (i < 0) return;
    const copy = structuredClone(p.features[i]); delete copy.osId;
    nid = uniqueId(p, copy.type); copy.id = nid; copy.name = `${p.features[i].name ?? p.features[i].type} copy`;
    p.features.splice(i + 1, 0, copy);
  });
  if (nid) { S.selection = nid; emit(); }
}
export function moveFeature(from, to) {
  if (from === to) return;
  edit((p) => { const [f] = p.features.splice(from, 1); p.features.splice(to, 0, f); });
}
export const setFeature = (id, patch, coalesce) => edit((p) => { Object.assign(p.features.find((f) => f.id === id) ?? {}, patch); }, { coalesce: coalesce ?? `f:${id}:${Object.keys(patch).join(",")}` });
export function select(id) { S.selection = id; S.pick = null; S.sketchEdit = null; S.draft = null; S.picks = []; if (id && feature(id)?.type === "sketch") S.sketchEdit = null; emit(); }
export function setRollback(i) { S.rollback = i; rebuild(); emit(); }

// ---------- version control ----------
// (no git here: Onshape versions are the history; see releases.js)
export async function refreshVcs() {}
export async function refreshLog() {}
export const scheduleVcs = debounce(() => { refreshVcs(); }, 500);

/** Show an older commit's version of the open part, read-only, with the current work ghosted on top. */
export async function viewCommit(id) {
  if (!S.partPath) return;
  try {
    const text = await window.cad.invoke("vcs:fileAt", id, S.partPath);
    if (text === null) { toast("This part didn't exist in that version", "err"); return; }
    await saveNow();
    S.view = { id, part: parsePart(text) }; S.selection = null; S.sketchEdit = null; S.pick = null;
    rebuild(); emit();
  } catch (e) { toast(e.message, "err"); }
}
export function exitView() { S.view = null; rebuild(); emit(); }

export async function reloadAfterVcsChange() {
  await refreshParts();
  if (S.partPath && S.project.parts.includes(S.partPath)) {
    const text = await window.cad.invoke("fs:read", S.partPath);
    try { S.part = parsePart(text); S.lastWritten = text; S.undo = []; S.redo = []; S.error = null; } catch (e) { S.error = e.message; }
  } else if (S.project.parts[0]) await loadPart(S.project.parts[0]);
  S.view = null; S.selection = null; S.rollback = null;
  rebuild(); await refreshVcs(); await refreshLog();
}
