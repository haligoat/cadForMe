// cadSlop version control: a content-addressed, git-like store kept in <project>/.cadslop
//   objects/blobs/<sha1>        file contents
//   objects/commits/<sha1>.json { tree: {path: blobSha}, parents, message, author, time }
//   refs/heads/<branch>         commit sha
//   refs/remotes/origin/<br>    last fetched remote tip
//   HEAD                        current branch name
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mergeParts } from "./partmerge.js";
import { formatPart as defaultFormat } from "../kernel/format.js";

const META = ".cadslop";
export const sha1 = (data) => crypto.createHash("sha1").update(data).digest("hex");
const P = (dir, ...p) => path.join(dir, META, ...p);
const mk = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });
const writeFile = (p, d) => { mk(p); fs.writeFileSync(p, d); };
const readText = (p) => fs.readFileSync(p, "utf8").trim();
const exists = (p) => fs.existsSync(p);

const BRANCH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export function checkBranchName(name) {
  if (!BRANCH_RE.test(name) || name.includes("..") || name.endsWith(".lock") || name.endsWith("/")) throw new Error(`Invalid branch name "${name}"`);
}
const HASH_RE = /^[0-9a-f]{40}$/;
const checkHash = (h) => { if (!HASH_RE.test(h)) throw new Error(`Bad object id "${h}"`); return h; };
function safeRel(rel) {
  const n = path.posix.normalize(rel.split(path.sep).join("/"));
  if (n.startsWith("..") || path.isAbsolute(n) || n.split("/").some((s) => s === META)) throw new Error(`Unsafe path "${rel}"`);
  return n;
}

export const isRepo = (dir) => exists(P(dir, "HEAD"));

export function initRepo(dir, { author = { name: "me" }, branch = "main" } = {}) {
  if (isRepo(dir)) throw new Error("Project is already a cadSlop repository");
  checkBranchName(branch);
  fs.mkdirSync(dir, { recursive: true });
  writeFile(P(dir, "HEAD"), branch);
  fs.mkdirSync(P(dir, "objects", "blobs"), { recursive: true });
  fs.mkdirSync(P(dir, "objects", "commits"), { recursive: true });
  fs.mkdirSync(P(dir, "refs", "heads"), { recursive: true });
  writeConfig(dir, { author, remote: null });
}

export const readConfig = (dir) => JSON.parse(fs.readFileSync(P(dir, "config.json"), "utf8"));
export const writeConfig = (dir, c) => writeFile(P(dir, "config.json"), JSON.stringify(c, null, 2));
export function setConfig(dir, patch) { writeConfig(dir, { ...readConfig(dir), ...patch }); }

// ---------- objects ----------
export function writeBlob(dir, buf) {
  const h = sha1(buf);
  const p = P(dir, "objects", "blobs", h);
  if (!exists(p)) writeFile(p, buf);
  return h;
}
export const hasBlob = (dir, h) => exists(P(dir, "objects", "blobs", checkHash(h)));
export const readBlob = (dir, h) => fs.readFileSync(P(dir, "objects", "blobs", checkHash(h)));
export const hasCommit = (dir, h) => exists(P(dir, "objects", "commits", `${checkHash(h)}.json`));
export const readCommitRaw = (dir, h) => fs.readFileSync(P(dir, "objects", "commits", `${checkHash(h)}.json`), "utf8");
export function readCommit(dir, h) { return { id: h, ...JSON.parse(readCommitRaw(dir, h)) }; }
export function writeCommit(dir, commit) {
  const sorted = { ...commit, tree: Object.fromEntries(Object.keys(commit.tree).sort().map((k) => [k, commit.tree[k]])) };
  const text = JSON.stringify(sorted);
  const h = sha1(text);
  if (!hasCommit(dir, h)) writeFile(P(dir, "objects", "commits", `${h}.json`), text);
  return h;
}
/** Store an object received from a remote after verifying its hash. */
export function importObject(dir, kind, h, data) {
  checkHash(h);
  if (kind === "blob") { if (sha1(data) !== h) throw new Error(`Corrupt blob ${h}`); writeBlob(dir, data); return; }
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
  if (sha1(text) !== h) throw new Error(`Corrupt commit ${h}`);
  const c = JSON.parse(text);
  if (!c.tree || !Array.isArray(c.parents)) throw new Error(`Malformed commit ${h}`);
  Object.keys(c.tree).forEach(safeRel);
  writeFile(P(dir, "objects", "commits", `${h}.json`), text);
}

// ---------- refs ----------
const headPath = (dir, b) => P(dir, "refs", "heads", ...b.split("/"));
const remotePath = (dir, b) => P(dir, "refs", "remotes", "origin", ...b.split("/"));
export const currentBranch = (dir) => readText(P(dir, "HEAD"));
export const getBranch = (dir, b) => (exists(headPath(dir, b)) ? readText(headPath(dir, b)) : null);
export const setBranch = (dir, b, h) => { checkBranchName(b); writeFile(headPath(dir, b), h); };
export const getRemoteTip = (dir, b) => (exists(remotePath(dir, b)) ? readText(remotePath(dir, b)) : null);
export const setRemoteTip = (dir, b, h) => { checkBranchName(b); writeFile(remotePath(dir, b), h); };
export const headCommit = (dir) => getBranch(dir, currentBranch(dir));

function listRefs(base) {
  const out = [];
  const walk = (d, prefix) => {
    if (!exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  walk(base, "");
  return out.sort();
}
export const listBranches = (dir) => listRefs(P(dir, "refs", "heads"));
export const listRemoteBranches = (dir) => listRefs(P(dir, "refs", "remotes", "origin"));

// ---------- working tree ----------
function walkWorking(dir, rel = "", out = {}) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkWorking(dir, r, out);
    else if (e.isFile()) out[r] = fs.readFileSync(path.join(dir, r));
  }
  return out;
}

const treeOfCommit = (dir, h) => (h ? readCommit(dir, h).tree : {});

export function status(dir) {
  const branch = currentBranch(dir);
  const head = getBranch(dir, branch);
  const tree = treeOfCommit(dir, head);
  const work = walkWorking(dir);
  const changes = [];
  for (const [p, buf] of Object.entries(work)) {
    if (!(p in tree)) changes.push({ path: p, status: "added" });
    else if (sha1(buf) !== tree[p]) changes.push({ path: p, status: "modified" });
  }
  for (const p of Object.keys(tree)) if (!(p in work)) changes.push({ path: p, status: "deleted" });
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const tip = getRemoteTip(dir, branch);
  const sync = tip && head ? aheadBehind(dir, head, tip) : { ahead: head ? 1 : 0, behind: 0 };
  return { branch, head, changes, clean: changes.length === 0, remoteTip: tip, ...sync };
}

/** Replace the working tree with `tree`. Files not in either tree (untracked) are kept. */
function checkoutTree(dir, tree, prevTree = {}) {
  for (const p of Object.keys(prevTree)) {
    if (!(p in tree)) { fs.rmSync(path.join(dir, safeRel(p)), { force: true }); pruneEmpty(dir, p); }
  }
  for (const [p, h] of Object.entries(tree)) writeFile(path.join(dir, safeRel(p)), readBlob(dir, h));
}
function pruneEmpty(dir, rel) {
  let d = path.dirname(path.join(dir, rel));
  while (d !== dir && exists(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); d = path.dirname(d); }
}

export function commit(dir, { message, author } = {}) {
  if (!message?.trim()) throw new Error("Write a commit message");
  const st = status(dir);
  if (st.clean) throw new Error("Nothing to commit");
  const tree = {};
  for (const [p, buf] of Object.entries(walkWorking(dir))) tree[p] = writeBlob(dir, buf);
  const h = writeCommit(dir, {
    tree, parents: st.head ? [st.head] : [], message: message.trim(),
    author: author ?? readConfig(dir).author, time: new Date().toISOString(),
  });
  setBranch(dir, st.branch, h);
  return h;
}

// ---------- history ----------
export function log(dir, from = headCommit(dir), limit = 200) {
  const out = []; const seen = new Set(); const queue = from ? [from] : [];
  while (queue.length && out.length < limit) {
    queue.sort((a, b) => readCommit(dir, b).time.localeCompare(readCommit(dir, a).time));
    const h = queue.shift();
    if (seen.has(h) || !hasCommit(dir, h)) continue;
    seen.add(h);
    const c = readCommit(dir, h);
    out.push({ id: h, message: c.message, author: c.author, time: c.time, parents: c.parents });
    queue.push(...c.parents);
  }
  return out;
}

export function ancestors(dir, h) {
  const seen = new Set(); const stack = h ? [h] : [];
  while (stack.length) {
    const x = stack.pop();
    if (seen.has(x) || !hasCommit(dir, x)) continue;
    seen.add(x);
    stack.push(...readCommit(dir, x).parents);
  }
  return seen;
}
export const isAncestor = (dir, a, b) => ancestors(dir, b).has(a);

export function mergeBase(dir, a, b) {
  const A = ancestors(dir, a);
  const queue = [b]; const seen = new Set();
  while (queue.length) {
    const h = queue.shift();
    if (seen.has(h) || !hasCommit(dir, h)) continue;
    seen.add(h);
    if (A.has(h)) return h;
    queue.push(...readCommit(dir, h).parents);
  }
  return null;
}

export function aheadBehind(dir, local, remote) {
  if (!local || !remote || local === remote) return { ahead: 0, behind: 0 };
  const L = ancestors(dir, local), R = ancestors(dir, remote);
  return { ahead: [...L].filter((x) => !R.has(x)).length, behind: [...R].filter((x) => !L.has(x)).length };
}

// ---------- branches ----------
export function createBranch(dir, name, { from = headCommit(dir), switchTo = true } = {}) {
  checkBranchName(name);
  if (getBranch(dir, name)) throw new Error(`Branch "${name}" already exists`);
  if (!from) throw new Error("Make a first commit before creating branches");
  setBranch(dir, name, from);
  if (switchTo) {
    if (from === headCommit(dir)) writeFile(P(dir, "HEAD"), name);
    else { try { switchBranch(dir, name); } catch (e) { fs.rmSync(headPath(dir, name), { force: true }); throw e; } }
  }
}

export function switchBranch(dir, name) {
  const target = getBranch(dir, name);
  if (!target) throw new Error(`No branch "${name}"`);
  const st = status(dir);
  if (!st.clean) throw new Error("You have uncommitted changes. Commit them before switching branches");
  checkoutTree(dir, treeOfCommit(dir, target), treeOfCommit(dir, st.head));
  writeFile(P(dir, "HEAD"), name);
}

export function deleteBranch(dir, name) {
  if (name === currentBranch(dir)) throw new Error("Can't delete the branch you're on");
  if (!getBranch(dir, name)) throw new Error(`No branch "${name}"`);
  fs.rmSync(headPath(dir, name), { force: true });
}

/** Restore the working files to a commit's state, discarding uncommitted edits to tracked files. */
export function discardChanges(dir) {
  const st = status(dir);
  const tree = treeOfCommit(dir, st.head);
  for (const c of st.changes) if (c.status === "added") fs.rmSync(path.join(dir, c.path), { force: true });
  checkoutTree(dir, tree, {});
}

export function filesAt(dir, h) {
  const tree = treeOfCommit(dir, h);
  return Object.fromEntries(Object.entries(tree).map(([p, b]) => [p, readBlob(dir, b)]));
}

export function changesBetween(dir, a, b) {
  const ta = treeOfCommit(dir, a), tb = treeOfCommit(dir, b);
  const out = [];
  for (const p of new Set([...Object.keys(ta), ...Object.keys(tb)])) {
    if (!(p in ta)) out.push({ path: p, status: "added" });
    else if (!(p in tb)) out.push({ path: p, status: "deleted" });
    else if (ta[p] !== tb[p]) out.push({ path: p, status: "modified" });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

// ---------- merge ----------
const isPart = (p) => p.endsWith(".part.json");
const parse = (buf) => { const j = JSON.parse(buf.toString("utf8")); j.variables ??= {}; j.features ??= []; return j; };

/**
 * Merge `theirs` (a commit id) into the current branch.
 * Returns {status: "up-to-date" | "fast-forward" | "merged" | "conflicts", ...}.
 * On "conflicts" nothing is changed; call again with `resolutions` {key: "ours"|"theirs"}.
 */
export async function merge(dir, theirs, { resolutions = {}, label = theirs.slice(0, 7) } = {}) {
  const st = status(dir);
  if (!st.clean) throw new Error("You have uncommitted changes. Commit them before merging");
  const ours = st.head;
  if (!ours) { setBranch(dir, st.branch, theirs); checkoutTree(dir, treeOfCommit(dir, theirs)); return { status: "fast-forward" }; }
  if (ours === theirs || isAncestor(dir, theirs, ours)) return { status: "up-to-date" };
  if (isAncestor(dir, ours, theirs)) {
    checkoutTree(dir, treeOfCommit(dir, theirs), treeOfCommit(dir, ours));
    setBranch(dir, st.branch, theirs);
    return { status: "fast-forward", commit: theirs };
  }
  const base = mergeBase(dir, ours, theirs);
  const tb = treeOfCommit(dir, base), to = treeOfCommit(dir, ours), tt = treeOfCommit(dir, theirs);
  const result = {}; const conflicts = [];
  const text = (h) => (h ? readBlob(dir, h).toString("utf8") : null);

  for (const p of new Set([...Object.keys(tb), ...Object.keys(to), ...Object.keys(tt)])) {
    const b = tb[p], o = to[p], t = tt[p];
    if (o === t) { if (o) result[p] = o; continue; }
    if (b === o) { if (t) result[p] = t; continue; }
    if (b === t) { if (o) result[p] = o; continue; }
    // both sides changed this file differently
    if (isPart(p) && o && t) {
      try {
        const r = mergeParts(b ? parse(readBlob(dir, b)) : null, parse(readBlob(dir, o)), parse(readBlob(dir, t)),
          Object.fromEntries(Object.entries(resolutions).filter(([k]) => k.startsWith(`${p}::`)).map(([k, v]) => [k.slice(p.length + 2), v])));
        r.conflicts.forEach((c) => conflicts.push({ ...c, path: p, key: `${p}::${c.key}` }));
        if (!r.conflicts.length) result[p] = writeBlob(dir, Buffer.from(defaultFormat(r.merged)));
        continue;
      } catch { /* fall through to whole-file conflict */ }
    }
    const key = `${p}::file`;
    const c = resolutions[key];
    if (c === "ours") { if (o) result[p] = o; }
    else if (c === "theirs") { if (t) result[p] = t; }
    else conflicts.push({ path: p, key, label: `File ${p}`, base: text(b), ours: text(o), theirs: text(t) });
  }
  if (conflicts.length) return { status: "conflicts", conflicts };

  const h = writeCommit(dir, {
    tree: result, parents: [ours, theirs], message: `Merge ${label} into ${st.branch}`,
    author: readConfig(dir).author, time: new Date().toISOString(),
  });
  checkoutTree(dir, result, to);
  setBranch(dir, st.branch, h);
  return { status: "merged", commit: h };
}
