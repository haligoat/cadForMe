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
import { OnshapeClient, parseDocumentUrl } from "../onshape/client.js";
import * as onshape from "../onshape/sync.js";
import * as odoc from "../onshape/document.js";
import * as keystore from "../onshape/keystore.js";
import { McpConnection, McpOnshapeClient, mcpServerConfig } from "../onshape/mcp.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Every project is a folder in projects/ (parts/, exports/, optional image-references/). The one in use is remembered in
// projects/.current so the terminal, the MCP server and the window all land on the same project.
export const PROJECTS_DIR = path.join(ROOT, "projects");
const CURRENT_FILE = path.join(PROJECTS_DIR, ".current");
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic)$/i;
export const projectSlug = (s) => String(s).trim().replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "project";

/** "bracket" -> projects/bracket; a path (with a slash, or absolute) is used as is; nothing -> the current project. */
export function projectDir(nameOrPath) {
  if (!nameOrPath) return currentProject();
  const s = String(nameOrPath);
  return path.isAbsolute(s) || /[\\/]/.test(s) || s === "." || s === ".." ? path.resolve(s) : path.join(PROJECTS_DIR, projectSlug(s));
}
export function currentProject() {
  let name; try { name = fs.readFileSync(CURRENT_FILE, "utf8").trim(); } catch { /* none yet */ }
  return name ? projectDir(name) : path.join(PROJECTS_DIR, "default");
}
/** Remember a project as the current one (only folders inside projects/ are remembered). */
export function setCurrentProject(dir) {
  const rel = path.relative(PROJECTS_DIR, path.resolve(dir));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return;
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(CURRENT_FILE, `${rel}\n`);
}
export function listProjects() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const cur = currentProject();
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => { const dir = path.join(PROJECTS_DIR, e.name); return { name: e.name, dir, parts: fs.existsSync(path.join(dir, "parts")) ? listParts(dir).length : 0, current: dir === cur }; });
}
/** A new project folder in projects/, made current. */
export function createProject(name) {
  if (!name) throw new Error("A new project needs a name");
  const dir = projectDir(projectSlug(name));
  if (fs.existsSync(dir)) throw new Error(`Project "${path.basename(dir)}" already exists`);
  ensureProject(dir);
  setCurrentProject(dir);
  return dir;
}

/** A project folder ready to open: just a folder with parts/ (no git, no history store; Onshape holds the history). */
export function ensureProject(dir = currentProject()) {
  dir = path.resolve(dir);
  fs.mkdirSync(path.join(dir, "parts"), { recursive: true });
  return dir;
}

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

/** First run after a clone: install the dependencies (needs only Node + internet once). Output goes to stderr. */
export function ensureDeps() {
  if (fs.existsSync(path.join(ROOT, "node_modules", "replicad-opencascadejs"))) return;
  process.stderr.write("cadForMe: first run, installing dependencies (about a minute)...\n");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: ["ignore", process.stderr, process.stderr] });
}

/** Switch on the pre-commit check that keeps API keys out of git (git hooks don't come with a clone). */
export function ensureHooks() {
  try {
    if (!fs.existsSync(path.join(ROOT, ".git"))) return;
    let cur = ""; try { cur = execFileSync("git", ["config", "core.hooksPath"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* unset */ }
    if (cur !== "scripts/hooks") execFileSync("git", ["config", "core.hooksPath", "scripts/hooks"], { cwd: ROOT, stdio: "ignore" });
  } catch { /* no git: nothing to protect */ }
}

let kernel = null;
async function loadKernel() {
  ensureDeps();
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
  ensureDeps();
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

// ---------- Onshape (keys, import, push, pull, releases) ----------
// Keys live in apikeys.json at the repo root (owner-only, gitignored, blocked by the pre-commit check), or in the
// ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY environment variables. The window reads the same file (src/onshape/keystore.js).
export { keysFile } from "../onshape/keystore.js";
export const loadKeys = keystore.loadOnshapeKeys;

/** Check the keys with Onshape, then save them. Returns the account name (never the keys). */
export async function connectOnshape({ accessKey, secretKey, baseUrl }) {
  const keys = { accessKey: String(accessKey ?? "").trim(), secretKey: String(secretKey ?? "").trim(), baseUrl: String(baseUrl || "https://cad.onshape.com").trim() };
  if (!keys.accessKey || !keys.secretKey) throw new Error("Both the access key and the secret key are needed. Onshape shows the secret only once when you create the API key; if it wasn't saved, create a new key (dev-portal.onshape.com -> API keys)");
  const who = await new OnshapeClient(keys).req("GET", "/users/sessioninfo");   // rejects wrong keys before anything is saved
  return { user: who?.name ?? who?.email ?? "", saved: keystore.saveOnshapeKeys(keys) };
}
export const disconnectOnshape = keystore.clearOnshapeKeys;
/**
 * The Onshape connection. Through the Onshape MCP server when .mcp.json lists one ("onshape"), so no keys are needed here
 * and cadForMe only sends its modelling to the document; otherwise the saved API keys. CADFORME_ONSHAPE=keys|mcp forces one.
 */
let mcpClient = null;
export function onshapeMode() {
  const want = process.env.CADFORME_ONSHAPE;
  if (want === "keys" || want === "mcp") return want;
  return mcpServerConfig() ? "mcp" : "keys";
}
export function osClient() {
  const k = loadKeys();
  if (onshapeMode() === "mcp") {
    const cfg = mcpServerConfig();
    if (!cfg) throw new Error("No Onshape MCP server is set up. Add an \"onshape\" server to .mcp.json (see README), or use API keys (cadforme connect)");
    return (mcpClient ??= new McpOnshapeClient(new McpConnection(cfg), { fallback: k ? new OnshapeClient(k) : null }));
  }
  if (!k) throw new Error("Onshape isn't connected. Set up the Onshape MCP server (README), or give me the API access key and secret key (onshape_connect), or set ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY");
  return new OnshapeClient(k);
}
/** Sign in through the Onshape MCP server (opens a browser). method: "api_key" (paste a key pair; the server keeps it) or "oauth". */
export async function onshapeLogin({ method = "api_key", onProgress = () => {} } = {}) {
  const c = osClient();
  if (!c.viaMcp) throw new Error("Signing in is done by the Onshape MCP server; there isn't one set up. Use cadforme connect for API keys");
  const body = (r) => r.json?.result ?? r.json ?? {};
  let r = await c.conn.call("onshape_login", { method, wait_seconds: 5 });
  if (r.isError || r.json?.ok === false) throw new Error(String(r.json?.error ?? r.text));
  const url = body(r).open_this_url;
  onProgress(`Finish the sign-in in your browser${url ? `. If no window opened, go to ${url}` : ""}`);
  for (let i = 0; i < 12; i++) {   // up to ~6 minutes
    r = await c.conn.call("onshape_login_status", { wait_seconds: 30 });
    if (r.isError || r.json?.ok === false) throw new Error(String(r.json?.error ?? r.text));
    if (String(body(r).status).toLowerCase() !== "pending") break;
    onProgress("Waiting for you to finish in the browser…");
  }
  const st = await c.conn.call("onshape_auth_status", { verify: false });   // only done when the server really holds a credential
  if (!body(st).configured) throw new Error("The sign-in wasn't finished (no key was saved). Run cadforme login again and paste the key pair in the browser page");
  return body(st);
}
/** Stop the MCP server process (command-line runs call this when they finish). */
export function closeOnshape() { mcpClient?.close(); mcpClient = null; }

export const importOnshape = (dir, url, opts) => odoc.importDocument(dir, osClient(), url, opts);
export const uploadStepAssembly = (dir, file, url, opts) => odoc.importStepAssembly(dir, osClient(), url, path.resolve(dir, file), opts);
export function uploadReport(r) {
  const kinds = {}; for (const t of r.tabs) kinds[t.type] = (kinds[t.type] ?? 0) + 1;
  return [`Imported ${r.file}: ${Object.entries(kinds).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")}`, r.url,
    ...(r.renamed.length ? [`Renamed: ${r.renamed.map((x) => `${x.from} -> ${x.to}`).join(", ")}`] : []),
    ...(r.folder ? [r.folder.placed ? `${r.folder.placed} tabs placed in folder "${r.folder.name}"` : `Onshape didn't put the tabs in folder "${r.folder.name}"; drag them in from the tab manager (the API can't move tabs)`] : [])].join("\n");
}
/** Import an Onshape document into its own project, projects/<document name>, and make that project current. */
export async function importOnshapeProject(url, opts) {
  const client = osClient();
  const doc = await client.getDocument(parseDocumentUrl(url).did);
  const dir = ensureProject(projectDir(projectSlug(doc.name || "onshape-import")));
  setCurrentProject(dir);
  return { project: dir, ...(await odoc.importDocument(dir, client, url, opts)) };
}
export const pushPart = (dir, rel, { preview = false } = {}) => onshape.pushToOnshape(dir, osClient(), rel, { dryRun: preview });
export const pullPart = (dir, rel) => onshape.pullFromOnshape(dir, osClient(), rel);
export const makeRelease = (dir, name) => odoc.createRelease(dir, osClient(), name);
export const releases = (dir) => odoc.listReleases(dir, osClient());
export const linkedParts = odoc.linkedParts;

/** Text summary of an import. */
export function importReport(r) {
  const lines = [`${r.document || "Document"}: ${r.results.filter((x) => x.status === "imported").length} of ${r.results.length} imported`];
  if (r.project) lines.push(`Project: ${r.project}`);
  for (const x of r.results) {
    if (x.status === "imported") {
      lines.push(`  ✓ ${x.element} -> ${x.rel}: ${x.features} features${x.kind === "ASSEMBLY" ? " (assembly, geometry only)" : ` (${x.editable} editable${x.placeholders.length ? `, ${x.placeholders.length} Onshape-only kept as placeholders` : ""})`}`);
      for (const n of x.placeholders.slice(0, 8)) lines.push(`      placeholder: ${n}`);
      if (x.placeholders.length > 8) lines.push(`      ...and ${x.placeholders.length - 8} more`);
    } else lines.push(`  ${x.status === "skipped" ? "-" : "✗"} ${x.element}: ${x.reason}`);
  }
  return lines.join("\n");
}
