import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as repo from "../src/vcs/repo.js";
import { push, pull, clone } from "../src/vcs/sync.js";
import { FolderRemote, GitHubRemote, RemoteConflict } from "../src/vcs/remote.js";
import { formatPart, parsePart } from "../src/kernel/format.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cadslop-"));
const partPath = (d) => path.join(d, "parts", "bracket.part.json");
const readPart = (d) => parsePart(fs.readFileSync(partPath(d), "utf8"));
const writePart = (d, p) => { fs.mkdirSync(path.dirname(partPath(d)), { recursive: true }); fs.writeFileSync(partPath(d), formatPart(p)); };
const seed = { variables: { w: 40 }, features: [{ id: "a", type: "extrude", distance: 10 }, { id: "b", type: "fillet", radius: 2 }] };

function newProject(name = "alice") {
  const d = tmp();
  repo.initRepo(d, { author: { name } });
  writePart(d, seed);
  repo.commit(d, { message: "first" });
  return d;
}

test("status, commit, history, branches", () => {
  const d = newProject();
  assert.ok(repo.status(d).clean);
  writePart(d, { ...seed, variables: { w: 50 } });
  assert.deepEqual(repo.status(d).changes, [{ path: "parts/bracket.part.json", status: "modified" }]);
  assert.throws(() => repo.createBranch(d, "bad name"));
  repo.commit(d, { message: "wider" });
  assert.equal(repo.log(d).length, 2);
  repo.createBranch(d, "alice/new-intake");
  writePart(d, { ...seed, variables: { w: 99 } });
  assert.throws(() => repo.switchBranch(d, "main"), /uncommitted/);
  repo.commit(d, { message: "w99" });
  repo.switchBranch(d, "main");
  assert.equal(readPart(d).variables.w, 50);
  repo.switchBranch(d, "alice/new-intake");
  assert.equal(readPart(d).variables.w, 99);
  assert.throws(() => repo.commit(d, { message: "x" }), /Nothing/);
});

test("team flow: clone, parallel edits, push rejected, pull merges, conflicts resolve", async () => {
  const remoteDir = tmp();
  const remote = new FolderRemote(remoteDir);
  const alice = newProject("alice");
  repo.setConfig(alice, { remote: `folder:${remoteDir}` });
  assert.equal((await push(alice, remote)).status, "pushed");
  assert.equal((await push(alice, remote)).status, "up-to-date");

  const bobDir = path.join(tmp(), "proj");
  await clone(bobDir, remote, `folder:${remoteDir}`, { author: { name: "bob" } });
  assert.equal(readPart(bobDir).variables.w, 40);

  // both edit different things
  const a = readPart(alice); a.features[0].distance = 20; writePart(alice, a); repo.commit(alice, { message: "alice: longer extrude" });
  const b = readPart(bobDir); b.features[1].radius = 4; b.variables.w = 45; writePart(bobDir, b); repo.commit(bobDir, { message: "bob: bigger fillet" });

  await push(alice, remote);
  await assert.rejects(push(bobDir, remote), (e) => e instanceof RemoteConflict || /Pull first/.test(e.message));
  const res = await pull(bobDir, remote);
  assert.equal(res.status, "merged");
  const merged = readPart(bobDir);
  assert.equal(merged.features[0].distance, 20);
  assert.equal(merged.features[1].radius, 4);
  assert.equal(merged.variables.w, 45);
  assert.equal((await push(bobDir, remote)).status, "pushed");

  // same variable edited on both sides -> conflict, then resolution
  await pull(alice, remote);
  const a2 = readPart(alice); a2.variables.w = 100; writePart(alice, a2); repo.commit(alice, { message: "alice w=100" });
  const b2 = readPart(bobDir); b2.variables.w = 200; writePart(bobDir, b2); repo.commit(bobDir, { message: "bob w=200" });
  await push(alice, remote);
  const c = await pull(bobDir, remote);
  assert.equal(c.status, "conflicts");
  assert.equal(readPart(bobDir).variables.w, 200); // untouched until resolved
  const key = c.conflicts[0].key;
  const done = await pull(bobDir, remote, { resolutions: { [key]: "theirs" } });
  assert.equal(done.status, "merged");
  assert.equal(readPart(bobDir).variables.w, 100);
  assert.equal(repo.readCommit(bobDir, repo.headCommit(bobDir)).parents.length, 2);
  assert.ok(repo.status(bobDir).clean);
});

test("rejects corrupt/malicious remote objects", () => {
  const d = newProject();
  assert.throws(() => repo.importObject(d, "blob", "a".repeat(40), Buffer.from("nope")), /Corrupt/);
  const evil = JSON.stringify({ tree: { "../../escape": "a".repeat(40) }, parents: [], message: "x" });
  assert.throws(() => repo.importObject(d, "commit", repo.sha1(evil), evil), /Unsafe/);
});

test("GitHub remote against a fake contents API", async () => {
  const files = new Map(); let n = 0;
  const fakeFetch = async (url, { method = "GET", headers, body } = {}) => {
    const u = new URL(url);
    assert.ok(headers.Authorization.startsWith("Bearer "));
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.*)$/);
    const json = (status, data) => ({ status, ok: status < 300, json: async () => data, arrayBuffer: async () => Buffer.from(data) });
    if (!m) return json(files.size ? 200 : 404, {});
    const p = decodeURIComponent(m[2]);
    if (method === "PUT") {
      const { content, sha } = JSON.parse(body);
      const cur = files.get(p);
      if (cur && cur.sha !== sha) return json(sha ? 409 : 422, {});
      const sh = `sha${++n}`; files.set(p, { content, sha: sh });
      return json(cur ? 200 : 201, { content: { sha: sh } });
    }
    if (files.has(p)) {
      const f = files.get(p);
      return headers.Accept.includes("raw") ? json(200, Buffer.from(f.content, "base64")) : json(200, { content: f.content, sha: f.sha });
    }
    const kids = [...files.keys()].filter((k) => k.startsWith(`${p}/`));
    if (!kids.length) return json(404, {});
    return json(200, kids.map((k) => ({ name: k.slice(p.length + 1), type: "file", url: `https://api.github.com/repos/o/r/contents/${k}` })));
  };
  const mkRemote = () => new GitHubRemote({ repo: "o/r", token: "t", fetch: fakeFetch });
  const alice = newProject();
  assert.equal((await push(alice, mkRemote())).status, "pushed");
  const bobDir = path.join(tmp(), "p");
  await clone(bobDir, mkRemote(), "github:o/r", { author: { name: "bob" } });
  assert.equal(readPart(bobDir).variables.w, 40);
  const b = readPart(bobDir); b.variables.w = 7; writePart(bobDir, b); repo.commit(bobDir, { message: "bob" });
  const a = readPart(alice); a.variables.w = 8; writePart(alice, a); repo.commit(alice, { message: "alice" });
  await push(bobDir, mkRemote());
  await assert.rejects(push(alice, mkRemote()), /Pull first|pushed/);
});

test("branch from an older commit checks out that commit", () => {
  const d = newProject();
  const first = repo.headCommit(d);
  writePart(d, { ...seed, variables: { w: 77 } });
  repo.commit(d, { message: "second" });
  repo.createBranch(d, "old", { from: first });
  assert.equal(repo.currentBranch(d), "old");
  assert.equal(readPart(d).variables.w, 40);
});
