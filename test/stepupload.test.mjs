import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importStepAssembly, tabFolders } from "../src/onshape/document.js";

const DID = "d".repeat(24), WID = "c".repeat(24);
const URL_ = `https://cad.onshape.com/documents/${DID}/w/${WID}/e/${"e".repeat(24)}`;

/** A fake Onshape client: a team document with some tabs and folders; translating adds the given tabs. */
function fakeClient({ existing = ["Robot", "Shooter"], adds = ["Robot (1)", "Drive pod", "Robot (1) parts"], folders = [{ name: "Imports", nodeId: "N1" }], placeInFolder = false } = {}) {
  let n = 0; const id = () => String(++n).padStart(24, "0");
  const els = existing.map((name) => ({ id: id(), name, elementType: "ASSEMBLY" }));
  const calls = []; let polls = 0; const groups = folders.map((f) => ({ btType: "BTElementGroup-1458", groupName: f.name, nodeId: f.nodeId, groups: [] }));
  return {
    calls, els,
    getDocument: async () => ({ defaultWorkspace: { id: WID } }),
    listElements: async () => els.map((e) => ({ ...e })),
    translateFile: async (did, wid, { name, options }) => { calls.push(["translate", name, options]); return { translationId: "T1" }; },
    getTranslation: async () => {
      if (++polls < 2) return { requestState: "ACTIVE" };
      if (!els.some((e) => e.name === adds[0])) for (const a of adds) {
        const e = { id: id(), name: a, elementType: a.endsWith("parts") ? "PARTSTUDIO" : "ASSEMBLY" }; els.push(e);
        if (placeInFolder) groups[0].groups.push({ btType: "BTDocumentElementReference-2484", elementId: e.id });
      }
      return { requestState: "DONE" };
    },
    req: async (method, p, body) => {
      calls.push([method, p, body]);
      if (p.endsWith("/contents")) return { folders: { btType: "BTElementGroup-1458", groups } };
      const m = p.match(/\/e\/(\w+)$/);
      if (p.startsWith("/metadata") && method === "GET") return { properties: [{ name: "Name", propertyId: "NAMEPROP", value: els.find((e) => e.id === m[1]).name }] };
      if (p.startsWith("/metadata") && method === "POST") { els.find((e) => e.id === m[1]).name = body.properties[0].value; return {}; }
      throw new Error(`unexpected ${method} ${p}`);
    },
  };
}
const setup = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepup-")); const f = path.join(dir, "robot-assembly.step"); fs.writeFileSync(f, "ISO-10303-21;"); return { dir, f }; };

test("upload keeps appearances, drops (1) suffixes only where the plain name is free, and logs the tabs", async () => {
  const { dir, f } = setup(); const c = fakeClient();
  const r = await importStepAssembly(dir, c, URL_, f, { pollMs: 0 });
  assert.deepEqual(c.calls[0], ["translate", "robot-assembly.step", { importAppearances: true }]);
  assert.deepEqual(r.renamed, [{ from: "Robot (1) parts", to: "Robot parts" }], "\"Robot\" is taken by the team's tab, \"Robot parts\" is free");
  assert.equal(r.tabs.length, 3);
  assert.match(r.url, new RegExp(`/e/${r.tabs[0].eid}$`), "links the top-level assembly");
  const log = JSON.parse(fs.readFileSync(path.join(dir, "onshape-import.json"), "utf8"));
  assert.equal(log.length, 1); assert.equal(log[0].tabs.length, 3);
  await importStepAssembly(dir, fakeClient({ adds: ["Other"] }), URL_, f, { pollMs: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "onshape-import.json"), "utf8")).length, 2, "later uploads are appended");
});

test("a folder is passed to Onshape by its node id, and the report says whether the tabs landed in it", async () => {
  const { dir, f } = setup();
  let c = fakeClient();
  let r = await importStepAssembly(dir, c, URL_, f, { folder: "imports", pollMs: 0 });
  assert.equal(c.calls.find((x) => x[0] === "translate")[2].locationGroupId, "N1");
  assert.deepEqual(r.folder, { name: "Imports", placed: 0 });
  c = fakeClient({ placeInFolder: true });
  r = await importStepAssembly(dir, c, URL_, f, { folder: "Imports", pollMs: 0 });
  assert.equal(r.folder.placed, 3);
  await assert.rejects(importStepAssembly(dir, fakeClient(), URL_, f, { folder: "Nope", pollMs: 0 }), /No tab folder "Nope".*create it in Onshape/i);
  assert.deepEqual((await tabFolders(fakeClient(), DID, WID)).map((x) => x.name), ["Imports"]);
});

test("version links are refused and failed translations are reported", async () => {
  const { dir, f } = setup();
  await assert.rejects(importStepAssembly(dir, fakeClient(), `https://cad.onshape.com/documents/${DID}/v/${WID}/e/${"e".repeat(24)}`, f, { pollMs: 0 }), /version/);
  const c = fakeClient(); c.getTranslation = async () => ({ requestState: "FAILED", failureReason: "bad file" });
  await assert.rejects(importStepAssembly(dir, c, URL_, f, { pollMs: 0 }), /couldn't translate.*bad file/);
});

import { OnshapeClient, OnshapeError } from "../src/onshape/client.js";
test("a long Onshape rate limit is reported with how long to wait, not retried", async () => {
  let calls = 0;
  const f = async () => { calls++; return { status: 429, ok: false, headers: new Map([["retry-after", "74757"]]), text: async () => JSON.stringify({ message: "Too many requests." }) }; };
  const c = new OnshapeClient({ accessKey: "a", secretKey: "b", fetch: f });
  await assert.rejects(c.req("GET", "/partstudios/x"), (e) => e instanceof OnshapeError && e.status === 429 && e.retryAfter === 74757 && /21 hours/.test(e.message));
  assert.equal(calls, 1, "no pointless retries");
});
test("a short rate limit is waited out and retried", async () => {
  let calls = 0;
  const f = async () => (++calls < 2 ? { status: 429, ok: false, headers: new Map([["retry-after", "0"]]), text: async () => "{}" } : { status: 200, ok: true, headers: new Map(), text: async () => "{\"ok\":true}" });
  const c = new OnshapeClient({ accessKey: "a", secretKey: "b", fetch: f });
  assert.deepEqual(await c.req("GET", "/x"), { ok: true }); assert.equal(calls, 2);
});
