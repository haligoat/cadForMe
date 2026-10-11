import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initKernel } from "./helpers.mjs";
import { buildPart, measure, meshBodies, exportSTEP } from "../src/kernel/geometry.js";
import { makeEvaluator } from "../src/kernel/expr.js";

before(initKernel);
const vol = (r) => measure(r.bodies).map((m) => m.volume);
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);

test("expressions & units", () => {
  const ev = makeEvaluator({ w: 40, t: "w/10", big: "2 in" });
  assert.equal(ev("t*2"), 8);
  near(ev("big"), 50.8);
  assert.equal(ev("sin(30)*10 + 2^3"), 13);
  assert.throws(() => makeEvaluator({ a: "b", b: "a" })("a"));
});

const base = (extra = [], vars = { w: 40, t: 5 }) => ({
  variables: vars,
  features: [
    { id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rect", w: "w", h: 20 }] },
    { id: "e1", type: "extrude", sketch: "s1", distance: "t" },
    ...extra,
  ],
});

test("extrude rect uses variables", () => {
  const r = buildPart(base());
  assert.deepEqual(r.errors, {});
  near(vol(r)[0], 40 * 20 * 5);
});

test("sketch subtract makes a hole", () => {
  const p = base();
  p.features[0].entities.push({ type: "circle", r: 3, cx: 0, cy: 0, op: "subtract" });
  near(vol(buildPart(p))[0], 40 * 20 * 5 - Math.PI * 9 * 5, 0.02);
});

test("cut extrude through", () => {
  const p = base([
    { id: "s2", type: "sketch", plane: "XY", offset: 5, entities: [{ type: "circle", r: 4 }] },
    { id: "e2", type: "extrude", sketch: "s2", distance: 5, flip: true, mode: "cut" },
  ]);
  const r = buildPart(p);
  assert.deepEqual(r.errors, {});
  near(vol(r)[0], 4000 - Math.PI * 16 * 5, 0.02);
});

test("symmetric extrude centres on the plane", () => {
  const p = base(); p.features[1].symmetric = true; p.features[1].distance = 10;
  const m = measure(buildPart(p).bodies)[0];
  near(m.bounds[0][2], -5); near(m.bounds[1][2], 5);
});

test("fillet by edge reference", () => {
  const p = base([{ id: "f1", type: "fillet", radius: 2, edges: [{ p: [20, 0, 5] }] }]);
  const r = buildPart(p);
  assert.deepEqual(r.errors, {});
  assert.ok(vol(r)[0] < 4000);
});

test("shell by face reference", () => {
  const p = base([{ id: "sh", type: "shell", thickness: 1, faces: [{ p: [0, 0, 5], n: [0, 0, 1] }] }]);
  const r = buildPart(p);
  assert.deepEqual(r.errors, {});
  assert.ok(vol(r)[0] < 4000 * 0.5);
});

test("hole, counterbore", () => {
  const p = base([{ id: "h", type: "hole", position: [10, 0, 5], normal: [0, 0, 1], diameter: 4, depth: 5, style: "counterbore", cboreDiameter: 8, cboreDepth: 2 }]);
  const r = buildPart(p);
  assert.deepEqual(r.errors, {});
  assert.ok(vol(r)[0] < 4000 - 50);
});

test("revolve", () => {
  const p = { features: [
    { id: "s", type: "sketch", plane: "XZ", entities: [{ type: "rect", w: 5, h: 10, cx: 5, cy: 5 }] },
    { id: "r", type: "revolve", sketch: "s", axis: "Y", angle: 360 },
  ] };
  const r = buildPart(p);
  assert.deepEqual(r.errors, {});
  near(vol(r)[0], Math.PI * 50 * 10, 0.02);
});

test("patterns & mirror", () => {
  const lin = buildPart(base([{ id: "lp", type: "linearPattern", direction: [0, 1, 0], distance: 30, count: 3, merge: false }]));
  assert.equal(lin.bodies.length, 3);
  const circ = buildPart({ features: [
    { id: "b", type: "box", w: 4, d: 4, h: 4, position: [20, 0, 0] },
    { id: "cp", type: "circularPattern", count: 4, axis: [0, 0, 1], merge: false },
  ] });
  assert.equal(circ.bodies.length, 4);
  const mir = buildPart(base([{ id: "m", type: "mirror", normal: [1, 0, 0], origin: [30, 0, 0], merge: false }]));
  assert.equal(mir.bodies.length, 2);
  near(measure(mir.bodies)[1].bounds[0][0], 40, 0.02);
});

test("booleans & primitives", () => {
  const r = buildPart({ features: [
    { id: "a", type: "box", w: 10, d: 10, h: 10 },
    { id: "b", type: "cylinder", r: 2, h: 20, position: [0, 0, -5] },
    { id: "bo", type: "boolean", a: 0, b: 1, op: "subtract" },
  ] });
  assert.deepEqual(r.errors, {});
  assert.equal(r.bodies.length, 1);
  near(vol(r)[0], 1000 - Math.PI * 4 * 10, 0.02);
});

test("errors are isolated per feature", () => {
  const r = buildPart(base([{ id: "bad", type: "fillet", radius: 1, edges: [{ p: [999, 999, 999] }] }, { id: "x", type: "nope" }]));
  assert.ok(r.errors.bad && r.errors.x);
  assert.equal(r.bodies.length, 1);
});

test("rollback, suppress, mesh, step", () => {
  const p = base([{ id: "s2", type: "sketch", plane: "XY", entities: [{ type: "circle", r: 3 }] }, { id: "e2", type: "extrude", sketch: "s2", distance: 20 }]);
  assert.equal(measure(buildPart(p, { upTo: 1 }).bodies)[0].size[2], 5);
  p.features[3].suppressed = true;
  assert.equal(measure(buildPart(p).bodies)[0].size[2], 5);
  const m = meshBodies(buildPart(p).bodies)[0];
  assert.ok(m.triangles.length > 0 && m.faceGroups.length === 6);
  assert.ok(exportSTEP(buildPart(p).bodies).size > 500);
});

test("expression evaluator cannot run code", () => {
  const ev = makeEvaluator({ a: 2 });
  for (const bad of ["constructor('x')()", "a.b", "process.exit()", "toString", "__proto__", "1; 2", "`x`"]) assert.throws(() => ev(bad), bad);
  assert.equal(ev("2 * (a + 1) ^ 2 / 3"), 6);
  assert.equal(ev("-a"), -2);
  assert.equal(ev("max(1, a, 0.5)"), 2);
});

test("UI sketch frames match the kernel's planes", async () => {
  const R = await import("replicad");
  const { sketchFrame } = await import("../src/kernel/vec.js");
  const ev = makeEvaluator({});
  for (const name of ["XY", "XZ", "YZ"]) {
    const f = sketchFrame({ plane: name, offset: 3 }, ev);
    const p = R.makePlane(name, 3);
    const near3 = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
    assert.ok(near3(f.x, p.xDir.toTuple()), `${name} x`);
    assert.ok(near3(f.y, p.yDir.toTuple()), `${name} y`);
    assert.ok(near3(f.n, p.zDir.toTuple()), `${name} n`);
    assert.ok(near3(f.origin, p.origin.toTuple()), `${name} origin`);
  }
});

test("import a STEP file as a body", async () => {
  const { loadImports, disposeImports } = await import("../src/kernel/geometry.js");
  const box = buildPart({ features: [{ id: "b", type: "box", w: 10, d: 10, h: 10 }] });
  const bytes = new Uint8Array(await exportSTEP(box.bodies).arrayBuffer());
  const part = { features: [{ id: "i", type: "import", file: "imports/box.step", scale: 2, position: [100, 0, 0] }, { id: "m", type: "import", file: "imports/missing.step" }] };
  const imports = await loadImports(part, { "imports/box.step": bytes });
  const r = buildPart(part, { imports });
  const m = measure(r.bodies)[0];
  assert.ok(Math.abs(m.volume - 8000) < 5, `volume ${m.volume}`);
  assert.ok(Math.abs(m.bounds[0][0] - 90) < 0.01);
  assert.match(r.errors.m, /couldn't be loaded/);
  disposeImports(imports);
});
