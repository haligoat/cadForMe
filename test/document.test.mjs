import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OnshapeClient, parseDocumentUrl } from "../src/onshape/client.js";
import { linkNewPartStudio, pushToOnshape } from "../src/onshape/sync.js";
import { importDocument, createRelease, listReleases } from "../src/onshape/document.js";
import { formatPart, parsePart } from "../src/kernel/format.js";
import { connectOnshape, disconnectOnshape, loadKeys, importReport } from "../src/cli/core.js";

const DID = "a".repeat(24), WID = "b".repeat(24), E1 = "1".repeat(24), E2 = "2".repeat(24), E3 = "3".repeat(24);
const link = (e) => `https://cad.onshape.com/documents/${DID}/w/${WID}/e/${e}`;

/** In-memory Onshape document: two Part Studios, an Assembly, versions. */
function fake() {
  const studios = new Map([[E1, []], [E2, []]]); const versions = []; let n = 0, micro = 1;
  const f = async (url, { method = "GET", headers, body } = {}) => {
    assert.ok(headers.Authorization.startsWith("Basic "));
    const p = new URL(url).pathname.replace("/api/v9", ""); let m;
    const json = (status, data) => ({ status, ok: status < 300, text: async () => JSON.stringify(data) });
    if (p === "/users/sessioninfo") return json(200, { name: "Test User" });
    if (p === `/documents/${DID}`) return json(200, { id: DID, name: "Robot", defaultWorkspace: { id: WID } });
    if (p === `/documents/d/${DID}/w/${WID}/elements`) return json(200, [{ id: E1, name: "Chassis", elementType: "PARTSTUDIO" }, { id: E2, name: "Arm", elementType: "PARTSTUDIO" }, { id: E3, name: "Robot assembly", elementType: "ASSEMBLY" }]);
    if (p === `/documents/d/${DID}/versions`) {
      if (method === "POST") { const b = JSON.parse(body); const v = { id: `v${++n}`.padEnd(24, "0"), name: b.name, description: b.description, createdAt: new Date().toISOString() }; versions.push({ ...v, bodyWorkspace: b.workspaceId }); return json(200, v); }
      return json(200, versions);
    }
    if (!(m = p.match(/^\/partstudios\/d\/\w+\/\w\/\w+\/e\/(\w+)\/features(?:\/featureid\/(.+))?$/))) return json(404, { message: "no route " + p });
    const list = studios.get(m[1]); if (!list) return json(404, { message: "no element" });
    if (method === "GET") return json(200, { features: list, sourceMicroversion: `m${micro}`, featureStates: {} });
    const { feature } = JSON.parse(body ?? "{}");
    if (method === "POST" && !m[2]) { const x = { ...feature, featureId: `F${++n}` }; list.push(x); micro++; return json(200, { feature: x, featureState: { featureStatus: "OK" } }); }
    return json(404, { message: "unsupported" });
  };
  return { fetch: f, studios, versions };
}
const client = (fk) => new OnshapeClient({ accessKey: "ak", secretKey: "sk", fetch: fk.fetch });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cadforme-doc-")); fs.mkdirSync(path.join(d, "parts")); return d; };
const bracket = (name, w) => ({ name, variables: { w }, features: [
  { id: "a", type: "box", name: "Plate", position: [0, 0, 0], w: "w", d: 20, h: 5 },
  { id: "h", type: "cylinder", name: "Hole (cutter)", position: [0, 0, -1], r: 2, h: 7 },
  { id: "s", type: "boolean", name: "Hole", a: 0, b: 1, op: "subtract" },
] });

test("document links parse with or without a tab", () => {
  assert.deepEqual(parseDocumentUrl(link(E1)), { did: DID, wvm: "w", wid: WID, eid: E1 });
  assert.deepEqual(parseDocumentUrl(`https://cad.onshape.com/documents/${DID}`), { did: DID, wvm: undefined, wid: undefined, eid: undefined });
  assert.throws(() => parseDocumentUrl("https://example.com/x"), /document link/);
});

test("keys are checked with Onshape, saved to the keys file, and never returned", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cadforme-home-")); process.env.CADFORME_KEYS_FILE = path.join(home, "apikeys.json");
  delete process.env.ONSHAPE_ACCESS_KEY; delete process.env.ONSHAPE_SECRET_KEY;
  const real = globalThis.fetch; globalThis.fetch = fake().fetch;
  try {
    assert.equal(loadKeys(), null);
    await assert.rejects(connectOnshape({ accessKey: "only-one" }), /Both the access key and the secret key/);
    const r = await connectOnshape({ accessKey: "AK123", secretKey: "SK456" });
    assert.equal(r.user, "Test User"); assert.ok(!JSON.stringify(r).includes("SK456"));
    assert.equal(loadKeys().secretKey, "SK456");
    assert.equal(fs.statSync(path.join(home, "apikeys.json")).mode & 0o077, 0, "owner-only file");
    disconnectOnshape();
    assert.equal(loadKeys(), null, "disconnect forgets the keys");
  } finally { globalThis.fetch = real; delete process.env.CADFORME_KEYS_FILE; }
});

test("importing a document brings in every Part Studio and the assembly, with all features", async () => {
  const fk = fake(), src = tmp();
  for (const [name, e, w] of [["Chassis", E1, 40], ["Arm", E2, 60]]) {
    fs.writeFileSync(path.join(src, "parts", `${name}.part.json`), formatPart(bracket(name, w)));
    await linkNewPartStudio(src, client(fk), `parts/${name}.part.json`, { url: link(e) });
    const r = await pushToOnshape(src, client(fk), `parts/${name}.part.json`); assert.deepEqual(r.errors, []);
  }
  // an Onshape-only feature the importer can't edit must still come in, as a placeholder
  fk.studios.get(E2).push({ btType: "BTMFeature-134", featureType: "loft", name: "Smooth loft", featureId: "FLOFT", parameters: [] });
  const dst = tmp();
  const r = await importDocument(dst, client(fk), `https://cad.onshape.com/documents/${DID}`, { assemblies: false });
  assert.equal(r.document, "Robot");
  assert.deepEqual(r.results.map((x) => [x.element, x.status]), [["Chassis", "imported"], ["Arm", "imported"]]);
  const chassis = parsePart(fs.readFileSync(path.join(dst, "parts/Chassis.part.json"), "utf8"));
  assert.deepEqual(chassis.variables, { w: 40 });
  assert.ok(chassis.features.some((f) => f.type === "sketch") && chassis.features.some((f) => f.type === "extrude"));
  assert.equal(chassis.onshape.eid, E1);
  const arm = r.results[1];
  assert.deepEqual(arm.placeholders, ["Smooth loft"]); assert.ok(arm.editable >= 2);
  assert.match(importReport(r), /Onshape-only kept as placeholders/);
  const again = await importDocument(dst, client(fk), link(E1), { assemblies: false });
  assert.equal(again.results[0].status, "skipped");
});

test("releases are named Onshape versions that describe what changed", async () => {
  const fk = fake(), dir = tmp();
  fs.writeFileSync(path.join(dir, "parts/Chassis.part.json"), formatPart(bracket("Chassis", 40)));
  await linkNewPartStudio(dir, client(fk), "parts/Chassis.part.json", { url: link(E1) });
  await pushToOnshape(dir, client(fk), "parts/Chassis.part.json");
  const first = await createRelease(dir, client(fk), "v1");
  assert.equal(first.name, "v1"); assert.ok(first.changes.some((l) => /new \(/.test(l)));
  const p = parsePart(fs.readFileSync(path.join(dir, "parts/Chassis.part.json"), "utf8"));
  p.variables.w = 55;
  fs.writeFileSync(path.join(dir, "parts/Chassis.part.json"), formatPart(p));
  const second = await createRelease(dir, client(fk), "");
  assert.equal(second.name, "Release 2");
  assert.deepEqual(second.changes, ["parts/Chassis.part.json:", "  variable w: 40 -> 55"]);
  assert.equal(fk.versions.length, 2); assert.match(fk.versions[1].description, /variable w: 40 -> 55/);
  assert.deepEqual((await listReleases(dir, client(fk))).map((r) => r.name).sort(), ["Release 2", "v1"]);
});
