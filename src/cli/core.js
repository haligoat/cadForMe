// What the terminal command and the MCP server share: finding the project, reading parts, the design check (DRC, with
// the same per-part cache the app uses), image references, import names, and running Onshape commands through the app
// (the Onshape keys live in the app's Keychain entry, so those go through a windowless Electron run).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DEFAULT_RULES, drcKey, drcSteps } from "../kernel/drcinfo.js";
import { importName, hasAutoName, conventionalName } from "../kernel/stepnames.js";
import { formatPart, parsePart } from "../kernel/format.js";
import * as repo from "../vcs/repo.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_PROJECT = path.join(ROOT, "designs");
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic)$/i;

/** A project folder ready to open: created with a parts/ folder and version history if it's new. */
export function ensureProject(dir = DEFAULT_PROJECT) {
  dir = path.resolve(dir);
  fs.mkdirSync(path.join(dir, "parts"), { recursive: true });
  if (!repo.isRepo(dir)) repo.initRepo(dir, { author: { name: gitName() } });
  return dir;
}
function gitName() { try { return execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim() || "me"; } catch { return process.env.USER ?? "me"; } }

export function listParts(dir, rel = "", out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) listParts(dir, r, out);
    else if (e.name.endsWith(".part.json")) out.push(r);
  }
  return out.sort();
}

/** Resolve "bracket", "bracket.part.json" or "parts/bracket.part.json" to a part path inside the project. */
export function resolvePart(dir, name) {
  const all = listParts(dir);
  const want = String(name).replace(/\\/g, "/");
  const hit = all.find((p) => p === want) ?? all.find((p) => p === `parts/${want}`) ?? all.find((p) => path.basename(p, ".part.json") === want.replace(/\.part\.json$/, ""));
  if (!hit) throw new Error(`No part "${name}" in ${dir}. Parts: ${all.join(", ") || "none yet"}`);
  return hit;
}
const inside = (dir, rel) => { const f = path.resolve(dir, rel); if (!f.startsWith(path.resolve(dir) + path.sep)) throw new Error(`${rel} is outside the project`); return f; };
export const readPart = (dir, rel) => parsePart(fs.readFileSync(inside(dir, rel), "utf8"));
export function writePart(dir, rel, part) {
  if (!part || !Array.isArray(part.features)) throw new Error("A part needs a features list");
  fs.mkdirSync(path.dirname(inside(dir, rel)), { recursive: true });
  fs.writeFileSync(inside(dir, rel), formatPart(part));
}

/** Bytes of every file a part pulls in (imported STEP files, inserted parts, recursively), like the app's filesFor. */
export function filesFor(dir, part, out = {}, depth = 0) {
  for (const f of part.features ?? []) {
    if (f.suppressed) continue;
    try {
      if (f.type === "import" && f.file && !out[f.file]) out[f.file] = new Uint8Array(fs.readFileSync(inside(dir, f.file)));
      else if (f.type === "insert" && f.part && !out[f.part] && depth < 6) { out[f.part] = new Uint8Array(fs.readFileSync(inside(dir, f.part))); filesFor(dir, JSON.parse(Buffer.from(out[f.part]).toString("utf8")), out, depth + 1); }
    } catch { /* missing file: the build reports it */ }
  }
  return out;
}

// ---------- design check ----------
const sha1 = async (bytes) => crypto.createHash("sha1").update(bytes).digest("hex");
const cacheFile = (dir) => path.join(dir, ".cadforme", "drc.json");
const readCache = (dir) => { try { return JSON.parse(fs.readFileSync(cacheFile(dir), "utf8")); } catch { return { parts: {} }; } };
const writeCache = (dir, c) => { fs.mkdirSync(path.dirname(cacheFile(dir)), { recursive: true }); fs.writeFileSync(cacheFile(dir), JSON.stringify(c, null, 2)); };

let kernel = null;
async function loadKernel() {
  kernel ??= (async () => {
    const req = createRequire(path.join(ROOT, "package.json"));
    const opencascade = (await import(req.resolve("replicad-opencascadejs"))).default;
    const geometry = await import("../kernel/geometry.js");
    const { initSolver } = await import("../kernel/sketch2.js");
    const { runDrc } = await import("../kernel/drc.js");
    // the wasm files aren't in the packages' exports, so read them straight from node_modules
    const mod = (p) => path.join(ROOT, "node_modules", p);
    geometry.init(await opencascade({ wasmBinary: fs.readFileSync(mod("replicad-opencascadejs/dist/replicad_single.wasm")) }));
    await initSolver(fs.readFileSync(mod("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm")));
    return { ...geometry, runDrc };
  })();
  return kernel;
}

/**
 * Design-check parts. Unchanged parts (same part, files and rules as last time) return their saved result without
 * building. onEvent({ type: "plan"|"start"|"step"|"done", ... }) reports progress with time estimates (ms).
 */
export async function designCheck(dir, rels, { force = false, onEvent = () => {} } = {}) {
  const cache = readCache(dir); cache.parts ??= {};
  const rules = { ...DEFAULT_RULES, ...(cache.rules ?? {}) };
  const msPerFeature = () => cache.msPerFeature ?? 60;
  const jobs = [];
  for (const rel of rels) {
    const part = readPart(dir, rel), files = filesFor(dir, part);
    const key = await drcKey(part, files, rules, sha1), prev = cache.parts[rel];
    const same = !force && prev?.key === key;
    jobs.push({ rel, name: part.name ?? rel, part, files, key, steps: drcSteps(part), skipped: same, result: same ? prev.result : null, ms: same ? prev.ms : null, est: prev?.ms ?? (part.features?.length ?? 0) * msPerFeature() + 400 });
  }
  const todo = jobs.filter((j) => !j.skipped);
  onEvent({ type: "plan", total: jobs.length, todo: todo.length, estimate: todo.reduce((a, j) => a + j.est, 0) });
  if (todo.length) {
    const K = await loadKernel();
    let real = 0, est = 0;
    for (const [n, j] of todo.entries()) {
      const k = est ? Math.min(3, Math.max(0.33, real / est)) : 1;   // how this run is going against its estimates
      const left = todo.slice(n).reduce((a, x) => a + x.est * k, 0);
      onEvent({ type: "start", index: n, count: todo.length, name: j.name, estimate: j.est * k, left });
      const t0 = performance.now();
      const parts = K.collectParts(j.part, j.files);
      const imports = await K.loadImports(j.part, j.files);
      for (const p of parts.values()) for (const [f, s] of await K.loadImports(p, j.files)) imports.set(f, s);
      const tb = performance.now();
      const built = K.buildPart(j.part, { imports, parts });
      const buildMs = Math.round(performance.now() - tb);
      K.disposeImports(imports);
      try {
        j.result = K.runDrc(j.part, built, { rules, onStep: (s) => onEvent({ type: "step", name: j.name, ...s, elapsed: performance.now() - t0, left: Math.max(0, left - (performance.now() - t0)) }) });
        j.result.stats = { ...j.result.stats, buildMs };
      } finally { built.bodies.forEach((b) => { try { b.delete(); } catch { /* freed */ } }); }
      j.ms = Math.round(performance.now() - t0);
      real += j.ms; est += j.est;
      cache.parts[j.rel] = { key: j.key, at: new Date().toISOString(), ms: j.ms, result: j.result };
      const nf = j.part.features?.length ?? 0;
      if (nf) cache.msPerFeature = Math.round(0.7 * msPerFeature() + 0.3 * (j.ms / nf));
      writeCache(dir, cache);
      onEvent({ type: "done", name: j.name, ms: j.ms, status: j.result.status });
    }
  }
  return jobs.map(({ rel, name, skipped, result, ms }) => ({ part: rel, name, skipped, ms, ...result }));
}

/** Plain-text report of design-check results. */
export function drcReport(results) {
  const mark = { pass: "✓", warn: "!", fail: "✗" };
  const lines = [];
  for (const r of results) {
    const s = r.stats;
    lines.push(`${mark[r.status] ?? "?"} ${r.name} (${r.part})${r.skipped ? " - unchanged, last result" : ""}${r.ms ? `, ${(r.ms / 1000).toFixed(1)} s` : ""}`);
    if (s) lines.push(`   ${s.bodies} bod${s.bodies === 1 ? "y" : "ies"}${s.pieces > s.bodies ? ` (${s.pieces} pieces)` : ""}, ${(s.volume / 1000).toFixed(2)} cm³${s.mass !== null && s.mass !== undefined ? `, ${s.mass.toFixed(1)} g` : ""}, ${s.size.map((v) => +v.toFixed(1)).join(" × ")} mm, ${s.features} features, ${s.variables} variables`);
    for (const c of r.checks ?? []) {
      if (c.status === "pass") continue;
      lines.push(`   ${mark[c.status]} ${c.label}: ${c.detail}`);
      for (const it of (c.items ?? []).slice(0, 10)) lines.push(`       - ${it}`);
    }
  }
  return lines.join("\n");
}

// ---------- image references ----------
export function refsDir(dir) {
  const own = dir && path.join(dir, "image-references");
  return own && fs.existsSync(own) ? own : path.join(ROOT, "image-references");
}
export function listRefs(dir) {
  const d = refsDir(dir);
  try { return fs.readdirSync(d).filter((n) => IMAGE_EXT.test(n) && !n.startsWith(".")).sort().map((name) => ({ name, key: name.replace(/\.[^.]+$/, ""), path: path.join(d, name), bytes: fs.statSync(path.join(d, name)).size })); }
  catch { return []; }
}
/** An image ready to hand to a model: JPEG, at most 1568 px on the long side (macOS sips does the resizing). */
export function imageForModel(file) {
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "cadforme-"));
  const tmp = path.join(tmpDir, "ref.jpg");
  try {
    execFileSync("sips", ["-Z", "1568", "-s", "format", "jpeg", file, "--out", tmp], { stdio: "ignore" });
    return { mimeType: "image/jpeg", data: fs.readFileSync(tmp).toString("base64") };
  } catch {
    const ext = path.extname(file).slice(1).toLowerCase().replace("jpg", "jpeg");
    return { mimeType: `image/${ext}`, data: fs.readFileSync(file).toString("base64") };
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}

// ---------- import names ----------
/** Conventional names for a part's imports. Only automatic names (file name, id, "import") change unless `all`. */
export function nameImports(dir, rel, { write = false, all = false } = {}) {
  const part = readPart(dir, rel), changes = [];
  for (const f of part.features) {
    if (f.type !== "import" || !f.file || (!all && !hasAutoName(f))) continue;
    let head = "";
    try { const fd = fs.openSync(inside(dir, f.file), "r"); const b = Buffer.alloc(Math.min(8e6, fs.fstatSync(fd).size)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); head = b.toString("latin1"); } catch { /* name from the file name alone */ }
    const name = conventionalName(f, importName(f.file, head));
    if (name !== f.name) { changes.push({ id: f.id, from: f.name ?? null, to: name }); f.name = name; }
  }
  if (write && changes.length) writePart(dir, rel, part);
  return changes;
}

// ---------- the app ----------
export function electronBin() { return createRequire(path.join(ROOT, "package.json"))("electron"); }

/** Rebuild the app bundle when any source file is newer than it. */
export function ensureBuilt() {
  const newest = (d) => { let t = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs); } return t; };
  let built = 0; try { built = fs.statSync(path.join(ROOT, "dist", "index.html")).mtimeMs; } catch { /* never built */ }
  if (newest(path.join(ROOT, "src")) > built) execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

/** Open the window on a project (and a part). detach: keep it open after this process ends. */
export function openGui(dir, { part, detach = false } = {}) {
  ensureBuilt();
  const child = spawn(electronBin(), [ROOT, part ? path.join(dir, part) : dir], { cwd: ROOT, stdio: detach ? "ignore" : "inherit", detached: detach });
  if (detach) child.unref();
  return child;
}

const APP_COMMANDS = new Set(["onshape:preview", "onshape:push", "onshape:pull", "onshape:info", "onshape:assembly"]);
/** Run one of the app's Onshape commands without a window (it uses the keys saved in the app). */
export function appCommand(dir, cmd, ...args) {
  if (!APP_COMMANDS.has(cmd)) return Promise.reject(new Error(`Unknown app command ${cmd}`));
  ensureBuilt();
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin(), [ROOT], { cwd: ROOT, env: { ...process.env, CADFORME_CMD: JSON.stringify({ cmd, project: dir, args }) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", () => {
      const line = out.split("\n").reverse().find((l) => l.startsWith("{\"cadforme\""));
      if (!line) { reject(new Error(`The app didn't answer.${err ? ` ${err.trim().split("\n").slice(-3).join(" ")}` : ""}`)); return; }
      const r = JSON.parse(line);
      r.ok ? resolve(r.result) : reject(new Error(r.error));
    });
  });
}
