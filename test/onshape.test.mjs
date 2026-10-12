import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OnshapeClient, parseOnshapeUrl } from "../src/onshape/client.js";
import { toOsExpr, fromOsExpr, onshapeToPart, featureToOs, variableToOs } from "../src/onshape/map.js";
import { importFromOnshape, pullFromOnshape, pushToOnshape, linkNewPartStudio } from "../src/onshape/sync.js";
import { formatPart, parsePart } from "../src/kernel/format.js";

const DID = "a".repeat(24), WID = "b".repeat(24), EID = "c".repeat(24);
const URL_ = `https://cad.onshape.com/documents/${DID}/w/${WID}/e/${EID}`;

/** In-memory Onshape: documents, part studios and their feature lists. */
function fakeOnshape() {
  const studios = new Map([[EID, []]]); let micro = 1, n = 0; const calls = [];
  const fetch = async (url, { method = "GET", headers, body } = {}) => {
    assert.ok(headers.Authorization.startsWith("Basic "));
    const u = new URL(url); const p = u.pathname.replace("/api/v9", ""); calls.push(`${method} ${p}`);
    const json = (status, data) => ({ status, ok: status < 300, text: async () => JSON.stringify(data) });
    let m;
    if (method === "POST" && p === "/documents") return json(200, { id: "d".repeat(24), defaultWorkspace: { id: "e".repeat(24) } });
    if (method === "POST" && (m = p.match(/^\/partstudios\/d\/\w+\/w\/\w+$/))) { const id = `f${++n}`.padEnd(24, "0"); studios.set(id, []); return json(200, { id }); }
    if (!(m = p.match(/^\/partstudios\/d\/(\w+)\/(\w)\/(\w+)\/e\/(\w+)\/features(?:\/featureid\/(.+))?$/))) return json(404, { message: "no route" });
    const list = studios.get(m[4]); if (!list) return json(404, { message: "no element" });
    const fid = m[5] && decodeURIComponent(m[5]);
    if (method === "GET") return json(200, { features: list, sourceMicroversion: `m${micro}`, featureStates: {} });
    const { feature } = JSON.parse(body ?? "{}");
    if (method === "POST" && !fid) { const f = { ...feature, featureId: `F${++n}`, namespace: "" }; list.push(f); micro++; return json(200, { feature: f, featureState: { featureStatus: "OK" }, sourceMicroversion: `m${micro}` }); }
    const i = list.findIndex((f) => f.featureId === fid); if (i < 0) return json(404, { message: "no feature" });
    if (method === "POST") { list[i] = { ...feature, featureId: fid, namespace: "" }; micro++; return json(200, { feature: list[i], featureState: { featureStatus: "OK" } }); }
    list.splice(i, 1); micro++; return json(200, {});
  };
  return { fetch, studios, calls, edit: (eid, fn) => { fn(studios.get(eid)); micro++; } };
}
const client = (fake) => new OnshapeClient({ accessKey: "ak", secretKey: "sk", fetch: fake.fetch });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cadslop-os-")); fs.mkdirSync(path.join(d, "parts")); return d; };
const read = (d) => parsePart(fs.readFileSync(path.join(d, "parts/b.part.json"), "utf8"));
const write = (d, p) => fs.writeFileSync(path.join(d, "parts/b.part.json"), formatPart(p));

const rect = (id = "sk1") => ({ id, type: "sketch", name: "Base", plane: "XY", offset: 0,
  geom: [{ id: "p1", t: "point", x: 0, y: 0 }, { id: "p2", t: "point", x: 40, y: 0 }, { id: "p3", t: "point", x: 40, y: 20 }, { id: "p4", t: "point", x: 0, y: 20 },
    { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" },
    { id: "p5", t: "point", x: 20, y: 10 }, { id: "c1", t: "circle", c: "p5", r: 4 }],
  cons: [{ id: "k1", t: "horizontal", a: "l1" }, { id: "k2", t: "vertical", a: "l2" }, { id: "k3", t: "horizontal", a: "l3" }, { id: "k4", t: "vertical", a: "l4" },
    { id: "d1", t: "dim", k: "length", a: "l1", v: "width" }, { id: "d2", t: "dim", k: "length", a: "l2", v: 20 }, { id: "d3", t: "dim", k: "diameter", a: "c1", v: 8 }] });
const basePart = () => ({ name: "B", variables: { width: 40, t: 5 }, features: [rect(), { id: "ex1", type: "extrude", name: "Plate", sketch: "sk1", distance: "t", mode: "new" }] });

test("expression translation", () => {
  assert.equal(toOsExpr(40), "40 mm"); assert.equal(toOsExpr("width"), "#width");
  assert.equal(toOsExpr("width/2 + 3"), "#width / 2 + 3 mm"); assert.equal(toOsExpr("2 in"), "2 in"); assert.equal(toOsExpr(90, "deg"), "90 deg");
  assert.equal(fromOsExpr("40 mm"), 40); assert.equal(fromOsExpr("1 in"), 25.4); assert.equal(fromOsExpr("#width / 2"), "width / 2"); assert.equal(fromOsExpr("0.5 m"), 500);
  assert.equal(parseOnshapeUrl(URL_).eid, EID); assert.throws(() => parseOnshapeUrl("https://example.com"));
  assert.throws(() => new OnshapeClient({ accessKey: "a", secretKey: "b", baseUrl: "http://cad.onshape.com" }), /https/);
});

test("send a new part to Onshape, then re-import it: geometry survives", async () => {
  const fake = fakeOnshape(), d = tmp(); write(d, basePart());
  await linkNewPartStudio(d, client(fake), "parts/b.part.json", { url: URL_ });
  const dry = await pushToOnshape(d, client(fake), "parts/b.part.json", { dryRun: true });
  assert.deepEqual(dry.ops.map((o) => o.label), ["Add variable width", "Add variable t", 'Add sketch "Base"', 'Add extrude "Plate"']);
  const r = await pushToOnshape(d, client(fake), "parts/b.part.json");
  assert.equal(r.status, "pushed"); assert.deepEqual(r.errors, []);
  const raw = fake.studios.get(EID);
  assert.deepEqual(raw.map((f) => f.featureType), ["assignVariable", "assignVariable", "newSketch", "extrude"]);
  const sk = raw[2];
  assert.equal(sk.entities.length, 5); // 4 lines + circle
  assert.equal(sk.constraints.filter((c) => c.constraintType === "COINCIDENT").length, 4);
  assert.equal(sk.entities[0].geometry.pntX, 0); assert.equal(sk.entities[1].geometry.pntX, 0.04);
  const ex = raw[3];
  assert.equal(ex.parameters.find((p) => p.parameterId === "depth").expression, "#t");
  // regions of that sketch, without the holes
  assert.equal(ex.parameters.find((p) => p.parameterId === "entities").queries[0].queryString, `query=qSketchRegion(makeId("${raw[2].featureId}"), true);`);
  // after push the local part knows its Onshape ids, and nothing is left to push
  assert.ok(read(d).features.every((f) => f.osId));
  assert.equal((await pushToOnshape(d, client(fake), "parts/b.part.json")).status, "up-to-date");
  // import from scratch
  const d2 = tmp();
  const imp = await importFromOnshape(d2, client(fake), URL_, "b");
  const back = parsePart(fs.readFileSync(path.join(d2, imp.rel), "utf8"));
  assert.deepEqual(back.variables, { width: 40, t: 5 });
  const bsk = back.features[0];
  assert.equal(bsk.geom.filter((g) => g.t === "point").length, 5); // corners merged back into 4 + centre
  assert.equal(bsk.geom.filter((g) => g.t === "line").length, 4);
  assert.deepEqual(bsk.cons.filter((c) => c.t === "dim").map((c) => [c.k, c.v]).sort(), [["diameter", 8], ["length", "width"], ["length", 20]].sort());
  assert.equal(back.features[1].distance, "t"); assert.equal(back.features[1].sketch, bsk.id); assert.equal(back.features[1].mode, "new");
  const p2 = bsk.geom.find((g) => g.t === "point" && Math.abs(g.x - 40) < 1e-6 && Math.abs(g.y) < 1e-6); assert.ok(p2);
});

test("unsupported Onshape features are kept as placeholders and never touched", async () => {
  const fake = fakeOnshape(), d = tmp();
  fake.studios.get(EID).push({ btType: "BTMFeature-134", featureType: "fillet", name: "Fillet 1", featureId: "FX1", parameters: [] });
  const imp = await importFromOnshape(d, client(fake), URL_, "b");
  const part = parsePart(fs.readFileSync(path.join(d, imp.rel), "utf8"));
  assert.equal(part.features[0].type, "onshape"); assert.ok(imp.warnings.length === 1);
  part.variables.w = 3; fs.writeFileSync(path.join(d, imp.rel), formatPart(part));
  const dry = await pushToOnshape(d, client(fake), imp.rel, { dryRun: true });
  assert.deepEqual(dry.ops.map((o) => o.label), ["Add variable w"]);
  await pushToOnshape(d, client(fake), imp.rel);
  assert.ok(fake.studios.get(EID).some((f) => f.featureId === "FX1"));
});

test("push edits and deletions; refuses when Onshape moved on; pull merges both sides", async () => {
  const fake = fakeOnshape(), d = tmp(); write(d, basePart());
  await linkNewPartStudio(d, client(fake), "parts/b.part.json", { url: URL_ });
  await pushToOnshape(d, client(fake), "parts/b.part.json");
  // local edit: bigger t and a new extrude; Onshape-side edit: someone changes the width variable
  let p = read(d); p.variables.t = 9; p.features.push({ id: "ex2", type: "extrude", name: "Boss", sketch: "sk1", distance: 3, mode: "add", symmetric: true }); write(d, p);
  fake.edit(EID, (list) => { const v = list.find((f) => f.parameters?.find((x) => x.parameterId === "name")?.value === "width"); v.parameters.find((x) => x.parameterId === "lengthValue").expression = "55 mm"; });
  await assert.rejects(pushToOnshape(d, client(fake), "parts/b.part.json"), /Pull first/);
  const pulled = await pullFromOnshape(d, client(fake), "parts/b.part.json");
  assert.equal(pulled.status, "merged");
  p = read(d);
  assert.equal(p.variables.width, 55); assert.equal(p.variables.t, 9); assert.equal(p.features.length, 3);
  assert.equal((await pullFromOnshape(d, client(fake), "parts/b.part.json")).status, "up-to-date");
  const r = await pushToOnshape(d, client(fake), "parts/b.part.json");
  assert.equal(r.status, "pushed");
  const raw = fake.studios.get(EID);
  assert.equal(raw.find((f) => f.parameters?.find((x) => x.parameterId === "name")?.value === "t").parameters.find((x) => x.parameterId === "lengthValue").expression, "9 mm");
  assert.equal(raw.at(-1).parameters.find((x) => x.parameterId === "endBound").value, "SYMMETRIC");
  // delete locally -> deleted in Onshape
  p = read(d); p.features = p.features.filter((f) => f.id !== "ex2"); write(d, p);
  await pushToOnshape(d, client(fake), "parts/b.part.json");
  assert.equal(fake.studios.get(EID).length, 5 - 1);
});

test("same thing edited on both sides is a conflict you resolve", async () => {
  const fake = fakeOnshape(), d = tmp(); write(d, basePart());
  await linkNewPartStudio(d, client(fake), "parts/b.part.json", { url: URL_ });
  await pushToOnshape(d, client(fake), "parts/b.part.json");
  const p = read(d); p.variables.width = 100; write(d, p);
  fake.edit(EID, (list) => { list.find((f) => f.parameters?.find((x) => x.parameterId === "name")?.value === "width").parameters.find((x) => x.parameterId === "lengthValue").expression = "70 mm"; });
  const res = await pullFromOnshape(d, client(fake), "parts/b.part.json");
  assert.equal(res.status, "conflicts"); assert.equal(res.conflicts[0].key, "variable:width");
  assert.equal(read(d).variables.width, 100);
  const done = await pullFromOnshape(d, client(fake), "parts/b.part.json", { resolutions: { "variable:width": "theirs" } });
  assert.equal(done.status, "merged"); assert.equal(read(d).variables.width, 70);
});

test("sending needs a link and never creates an Onshape document", async () => {
  const fake = fakeOnshape(), d = tmp(); write(d, basePart());
  await assert.rejects(linkNewPartStudio(d, client(fake), "parts/b.part.json", {}), /never creates new documents/);
  assert.ok(!fake.calls.some((c) => c === "POST /documents"), "no document was created");
  assert.equal(read(d).onshape, undefined);
});

test("a push where nothing can be sent says so instead of reporting success", async () => {
  const fake = fakeOnshape(), d = tmp();
  write(d, { name: "step only", variables: {}, features: [{ id: "im1", type: "import", name: "robot", file: "imports/robot.step", mode: "new" }] });
  await linkNewPartStudio(d, client(fake), "parts/b.part.json", { url: URL_ });
  const r = await pushToOnshape(d, client(fake), "parts/b.part.json");
  assert.equal(r.status, "nothing-sent"); assert.equal(r.skipped, 1);
});

test("fillet, chamfer and shell travel to Onshape and back", async () => {
  const fake = fakeOnshape(), d = tmp(); const part = basePart();
  part.features.push({ id: "fl1", type: "fillet", name: "Round", radius: "t/2", edges: [{ p: [20, 0, 5] }, { p: [40, 10, 5] }] },
    { id: "ch1", type: "chamfer", name: "Chamfer", radius: 1, edges: [{ p: [0, 10, 5] }] },
    { id: "sh1", type: "shell", name: "Hollow", thickness: 1.5, faces: [{ p: [10, 10, 5], n: [0, 0, 1] }] });
  write(d, part);
  await linkNewPartStudio(d, client(fake), "parts/b.part.json", { url: URL_ });
  const r = await pushToOnshape(d, client(fake), "parts/b.part.json");
  assert.deepEqual(r.warnings, []);
  const raw = fake.studios.get(EID);
  const fl = raw.find((f) => f.featureType === "fillet");
  assert.match(fl.parameters.find((p) => p.parameterId === "entities").queries[0].queryString, /qContainsPoint\(qEverything\(EntityType\.EDGE\), vector\(0\.02, 0, 0\.005\) \* meter\)/);
  assert.equal(fl.parameters.find((p) => p.parameterId === "radius").expression, "#t / 2");
  assert.deepEqual(raw.slice(-3).map((f) => f.featureType), ["fillet", "chamfer", "shell"]);
  const d2 = tmp(); const imp = await importFromOnshape(d2, client(fake), URL_, "b");
  const back = parsePart(fs.readFileSync(path.join(d2, imp.rel), "utf8"));
  const f2 = back.features.filter((f) => ["fillet", "chamfer", "shell"].includes(f.type));
  assert.equal(f2.length, 3); assert.deepEqual(imp.warnings, []);
  assert.deepEqual(f2[0].edges, [{ p: [20, 0, 5] }, { p: [40, 10, 5] }]); assert.equal(f2[0].radius, "t / 2"); assert.equal(f2[2].thickness, 1.5);
  // an edge picked in Onshape's own UI (opaque ids) stays a placeholder
  fake.edit(EID, (list) => list.push({ btType: "BTMFeature-134", featureType: "fillet", name: "UI fillet", featureId: "FUI", parameters: [{ btType: "BTMParameterQueryList-148", parameterId: "entities", queries: [{ btType: "BTMIndividualQuery-138", deterministicIds: ["JGD"] }] }, { btType: "BTMParameterQuantity-147", parameterId: "radius", expression: "2 mm" }] }));
  const d3 = tmp(); const imp3 = await importFromOnshape(d3, client(fake), URL_, "b");
  assert.equal(parsePart(fs.readFileSync(path.join(d3, imp3.rel), "utf8")).features.at(-1).type, "onshape");
});

test("construction planes and sketches on them map to Onshape and back", () => {
  const ids = { pl1: "FPL1", pl2: "FPL2", sk1: "FSK1" };
  const ctx = { warnings: [], osIdOf: (id) => ids[id] };
  const pl1 = featureToOs({ id: "pl1", type: "plane", name: "Side", from: "YZ", distance: -170 }, ctx);
  assert.equal(pl1.featureType, "cPlane");
  assert.equal(pl1.parameters.find((p) => p.parameterId === "offset").expression, "170 mm");
  assert.equal(pl1.parameters.find((p) => p.parameterId === "oppositeDirection").value, true);
  const pl2 = featureToOs({ id: "pl2", type: "plane", from: "pl1", distance: 20 }, ctx);
  assert.match(pl2.parameters[0].queries[0].queryString, /qCreatedBy\(makeId\("FPL1"\)/);
  const sk = featureToOs({ id: "sk1", type: "sketch", plane: "pl2", geom: [{ id: "p1", t: "point", x: 5, y: 6 }, { id: "c1", t: "circle", c: "p1", r: 4 }],
    cons: [{ id: "d1", t: "dim", k: "x", a: "p1", v: 5 }, { id: "d2", t: "dim", k: "y", a: "p1", v: 6 }, { id: "d3", t: "dim", k: "diameter", a: "c1", v: "shaft" }] }, ctx);
  assert.match(sk.parameters[0].queries[0].queryString, /qCreatedBy\(makeId\("FPL2"\)/);
  assert.deepEqual(sk.constraints.map((c) => c.constraintType), ["FIX", "DIAMETER"]); // x + y -> one FIX
  assert.equal(sk.constraints[1].parameters.find((p) => p.parameterId === "length").expression, "#shaft");
  // and back again
  const raw = [{ ...pl1, featureId: "FPL1" }, { ...pl2, featureId: "FPL2" }, { ...sk, featureId: "FSK1" }];
  const { part } = onshapeToPart(raw);
  assert.deepEqual(part.features.map((f) => f.type), ["plane", "plane", "sketch"]);
  assert.equal(part.features[0].distance, -170);
  assert.equal(part.features[1].from, part.features[0].id);
  assert.equal(part.features[2].plane, part.features[1].id);
  assert.equal(part.features[2].cons.find((c) => c.k === "diameter").v, "shaft");
});

test("variables are sent as Onshape length / angle variables", () => {
  const len = variableToOs("w", 40), ang = variableToOs("tilt", "15 deg");
  assert.equal(len.parameters.find((p) => p.parameterId === "variableType").value, "LENGTH");
  assert.equal(len.parameters.find((p) => p.parameterId === "lengthValue").expression, "40 mm");
  assert.equal(ang.parameters.find((p) => p.parameterId === "variableType").value, "ANGLE");
  assert.equal(onshapeToPart([{ ...len, featureId: "FV" }]).part.variables.w, 40);
});

test("boxes, cylinders, booleans, moves and mirrors go to Onshape as native features and round-trip", async () => {
  const fake = fakeOnshape(), d = tmp();
  write(d, { name: "Mount", variables: { wall: 5 }, features: [
    { id: "a", type: "box", name: "Plate", position: [0, 0, -10], w: 40, d: 20, h: "wall" },
    { id: "b", type: "box", name: "Post", position: [30, 0, 0], w: 6, d: 6, h: 20 },
    { id: "u", type: "boolean", name: "Join", a: 0, b: 1, op: "union" },
    { id: "h", type: "cylinder", name: "Hole (cutter)", position: [0, 0, -11], direction: [0, 0, 1], r: 2, h: 7 },
    { id: "s", type: "boolean", name: "Hole", a: 0, b: 1, op: "subtract" },
    { id: "m", type: "transform", name: "Shift", body: 0, translate: [0, 5, 0] },
    { id: "c", type: "transform", name: "Spare", body: 0, translate: [0, 50, 0], copy: true },
    { id: "r", type: "mirror", name: "Other side", body: 1, normal: [0, 1, 0], origin: [0, 100, 0], merge: false },
    { id: "x", type: "deleteBody", name: "Drop spare", body: 1 },
  ] });
  await linkNewPartStudio(d, client(fake), "parts/b.part.json", { url: URL_ });
  const dry = await pushToOnshape(d, client(fake), "parts/b.part.json", { dryRun: true });
  assert.equal(dry.converted.length, 3);
  assert.ok(dry.ops.every((o) => !o.skipped), JSON.stringify(dry));
  const r = await pushToOnshape(d, client(fake), "parts/b.part.json");
  assert.deepEqual(r.errors, []); assert.equal(r.skipped, 0, JSON.stringify(r.warnings));
  const raw = fake.studios.get(EID);
  assert.deepEqual(raw.map((f) => f.featureType), ["assignVariable", "newSketch", "extrude", "newSketch", "extrude", "booleanBodies", "newSketch", "extrude", "transform", "transform", "cPlane", "mirror", "deleteBodies"]);
  const P = (f, id) => f.parameters.find((p) => p.parameterId === id);
  const [plateEx, postEx, join, holeEx, shift, spare, , mirror, drop] = raw.filter((f) => f.featureType !== "newSketch" && f.featureType !== "assignVariable");
  // sketch offsets travel as start offsets; depths keep their variables
  assert.equal(P(plateEx, "startOffsetDistance").expression, "10 mm"); assert.equal(P(plateEx, "startOffsetOppositeDirection").value, true);
  assert.equal(P(plateEx, "depth").expression, "#wall");
  assert.equal(P(postEx, "startOffset"), undefined);
  // bodies are picked by the features that made them
  const q = (f, id) => P(f, id).queries.map((x) => x.queryString);
  const made = (...fs) => `query=qBodyType(qUnion([${fs.map((f) => `qCreatedBy(makeId("${f.featureId}"), EntityType.BODY)`).join(", ")}]), BodyType.SOLID);`;
  assert.equal(P(join, "operationType").value, "UNION");
  assert.deepEqual(q(join, "tools"), [made(plateEx), made(postEx)]);
  assert.equal(P(holeEx, "operationType").value, "REMOVE");   // cutter + subtract became one cut
  assert.deepEqual(q(shift, "entities"), [made(plateEx, postEx, join)]);
  assert.equal(P(shift, "dy").expression, "5 mm"); assert.equal(P(spare, "makeCopy").value, true);
  assert.deepEqual(q(mirror, "entities"), [made(spare)]);
  assert.equal(P(mirror, "operationType").value, "NEW");
  assert.deepEqual(q(drop, "entities"), [made(spare)]);
  // the part file now holds the native recipe, and a second push has nothing to do
  const local = read(d);
  assert.ok(!local.features.some((f) => f.type === "box" || f.type === "cylinder"));
  assert.ok(local.features.filter((f) => f.type !== "plane").every((f) => f.osId));
  assert.equal((await pushToOnshape(d, client(fake), "parts/b.part.json")).status, "up-to-date");
  // a depth edited in Onshape comes back; untouched booleans and moves keep their cadSlop form
  fake.edit(EID, (list) => { P(list.find((f) => f.featureId === postEx.featureId), "depth").expression = "25 mm"; });
  const pulled = await pullFromOnshape(d, client(fake), "parts/b.part.json");
  assert.equal(pulled.status, "merged");
  const after = read(d);
  assert.equal(after.features.find((f) => f.id === "b").distance, 25);
  assert.equal(after.features.find((f) => f.id === "ask").offset, -10);
  assert.deepEqual(after.features.find((f) => f.id === "u"), local.features.find((f) => f.id === "u"));
  assert.equal(after.features.find((f) => f.id === "m").type, "transform");
});

test("rotations of finished bodies and picks Onshape can't follow are reported, not sent wrong", () => {
  const warnings = [];
  const ctx = { warnings, osIdOf: (id) => `os_${id}`, bodiesAt: () => null, features: [] };
  assert.equal(featureToOs({ id: "t", type: "transform", body: 0, rotate: 30 }, ctx), null);
  assert.equal(featureToOs({ id: "b", type: "boolean", a: 0, b: 1, op: "union" }, ctx), null);
  assert.equal(warnings.length, 2);
  assert.ok(featureToOs({ id: "d", type: "deleteBody", body: "all" }, ctx));
});

test("repeated reads are served from cache, a write clears it, and the daily call count is kept", async () => {
  const { OnshapeClient, apiUsage } = await import("../src/onshape/client.js");
  process.env.CADFORME_USAGE_FILE = `${process.env.TMPDIR ?? "/tmp"}/cadforme-usage-${process.pid}.json`;
  let n = 0;
  const f = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ n: ++n }) });
  const c = new OnshapeClient({ accessKey: "a", secretKey: "b", fetch: f });
  const a = await c.req("GET", "/documents/x"), b = await Promise.all([c.req("GET", "/documents/x"), c.req("GET", "/documents/x")]);
  assert.equal(n, 1); assert.deepEqual(b.map((x) => x.n), [1, 1]); assert.equal(a.n, 1);
  await c.req("POST", "/documents", {});
  assert.equal((await c.req("GET", "/documents/x")).n, 3);
  assert.equal(apiUsage().calls, 3); assert.equal(apiUsage().cached, 2);
});

test("translation progress is never cached, and waiting backs off instead of polling every 2 s", async () => {
  const { OnshapeClient } = await import("../src/onshape/client.js");
  process.env.CADFORME_USAGE_FILE = `${process.env.TMPDIR ?? "/tmp"}/cadforme-usage-${process.pid}.json`;
  let n = 0;
  const f = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ requestState: ++n >= 3 ? "DONE" : "ACTIVE" }) });
  const c = new OnshapeClient({ accessKey: "a", secretKey: "b", fetch: f });
  const st = await c.waitTranslation("t1", { requestState: "ACTIVE" }, { maxMs: 10 });
  assert.equal(st.requestState, "DONE"); assert.equal(n, 3);
});
