// push / pull / clone between a local cadSlop repo and a remote.
import fs from "node:fs";
import {
  initRepo, readConfig, setConfig, status, currentBranch, headCommit, getBranch, setBranch,
  hasCommit, readCommit, readCommitRaw, readBlob, hasBlob, importObject, ancestors, isAncestor,
  setRemoteTip, getRemoteTip, merge, sha1, switchBranch, filesAt,
} from "./repo.js";
import { RemoteConflict } from "./remote.js";

const seenPacks = (dir) => new Set(readConfig(dir).packs ?? []);
const markPack = (dir, id) => setConfig(dir, { packs: [...seenPacks(dir), id] });

/** Download new packs and update origin/* tips. */
export async function fetchRemote(dir, remote) {
  const have = seenPacks(dir);
  let got = 0;
  for (const id of await remote.listPacks()) {
    if (have.has(id)) continue;
    const buf = await remote.getPack(id);
    if (sha1(buf) !== id) throw new Error(`Pack ${id} is corrupt`);
    const pack = JSON.parse(buf.toString("utf8"));
    for (const [h, b64] of Object.entries(pack.blobs ?? {})) importObject(dir, "blob", h, Buffer.from(b64, "base64"));
    for (const [h, text] of Object.entries(pack.commits ?? {})) importObject(dir, "commit", h, text);
    markPack(dir, id);
    got++;
  }
  const branches = await remote.listBranches();
  for (const [b, tip] of Object.entries(branches)) if (hasCommit(dir, tip)) setRemoteTip(dir, b, tip);
  return { packs: got, branches };
}

export async function push(dir, remote) {
  const branch = currentBranch(dir);
  const head = headCommit(dir);
  if (!head) throw new Error("Nothing to push yet. Make a commit first");
  const remoteTip = await remote.getRef(branch);
  if (remoteTip === head) return { status: "up-to-date" };
  if (remoteTip && (!hasCommit(dir, remoteTip) || !isAncestor(dir, remoteTip, head))) {
    throw new RemoteConflict("The remote has changes you don't have. Pull first, then push");
  }
  const known = remoteTip ? ancestors(dir, remoteTip) : new Set();
  const knownBlobs = new Set();
  for (const c of known) Object.values(readCommit(dir, c).tree).forEach((b) => knownBlobs.add(b));
  const commits = {}; const blobs = {};
  for (const c of ancestors(dir, head)) {
    if (known.has(c)) continue;
    commits[c] = readCommitRaw(dir, c);
    for (const b of Object.values(readCommit(dir, c).tree)) {
      if (!knownBlobs.has(b) && hasBlob(dir, b)) blobs[b] = readBlob(dir, b).toString("base64");
    }
  }
  const buf = Buffer.from(JSON.stringify({ version: 1, commits, blobs }));
  const id = sha1(buf);
  await remote.putPack(id, buf);
  await remote.setRef(branch, head, remoteTip);
  markPack(dir, id);
  setRemoteTip(dir, branch, head);
  return { status: "pushed", commits: Object.keys(commits).length };
}

export async function pull(dir, remote, { resolutions } = {}) {
  const st = status(dir);
  if (!st.clean) throw new Error("You have uncommitted changes. Commit them before pulling");
  await fetchRemote(dir, remote);
  const tip = getRemoteTip(dir, st.branch);
  if (!tip) return { status: "no-remote-branch" };
  return merge(dir, tip, { resolutions, label: `origin/${st.branch}` });
}

/** Create a local project from a remote. `dir` must be empty or missing. */
export async function clone(dir, remote, remoteSpec, { branch, author } = {}) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error("Pick an empty folder to clone into");
  const branches = await remote.listBranches();
  const names = Object.keys(branches);
  if (!names.length) throw new Error("That remote is empty. Push a project to it first");
  const pick = branch ?? (names.includes("main") ? "main" : names[0]);
  if (!branches[pick]) throw new Error(`Remote has no branch "${pick}"`);
  initRepo(dir, { author, branch: pick });
  setConfig(dir, { remote: remoteSpec });
  await fetchRemote(dir, remote);
  setBranch(dir, pick, branches[pick]);
  for (const [p, buf] of Object.entries(filesAt(dir, branches[pick]))) {
    const full = `${dir}/${p}`;
    fs.mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(full, buf);
  }
  return { branch: pick };
}

export { switchBranch };
