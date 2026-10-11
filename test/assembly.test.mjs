import { test } from "node:test";
import assert from "node:assert/strict";
import { solveMates, toLocal, bom, instMatrix } from "../src/renderer/assembly.js";

const close = (a, b, eps = 1e-3) => a.every((x, i) => Math.abs(x - b[i]) < eps);

test("fasten mate puts the moving part's face flat against the fixed part's face", () => {
  // base: a 100x100x20 block, fixed at the origin; its top face is z = 20 (normal +z)
  // cap: a 40x40x10 block placed off to the side, rotated; we mate its bottom face (local z = 0, normal -z) to base top
  const base = { id: "i1", type: "insert", part: "parts/base.part.json", position: [0, 0, 0], orient: [0, 0, 0], fixed: true };
  const cap = { id: "i2", type: "insert", part: "parts/cap.part.json", position: [300, 50, -80], orient: [90, 0, 30] };
  const part = { kind: "assembly", features: [base, cap] };
  const a = toLocal(base, [10, 20, 20], [0, 0, 1]);           // picked on base top
  const capBottomWorld = { p: [300, 50, -80], n: [0, 0, -1] }; // a point/normal on cap (computed from its current placement)
  const m = instMatrix(cap); void m;
  const b = { p: [0, 0, 0], n: [0, 0, -1] };                   // cap bottom in cap's own coordinates
  part.features.push({ id: "m1", type: "mate", kind: "fasten", a: { inst: "i1", ...a }, b: { inst: "i2", ...b }, offset: 2 });
  const problems = solveMates(part);
  assert.equal(problems.length, 0); assert.ok(problems.driven.has("i2"), "cap is placed by the mate");
  // cap's bottom centre lands on the picked point, 2 mm above, and its bottom faces down (local -z -> world -z)
  assert.ok(close(cap.position, [10, 20, 22]), JSON.stringify(cap.position));
  const M = instMatrix(cap); const e = M.elements; // column 2 = local z axis in world
  assert.ok(close([e[8], e[9], e[10]], [0, 0, 1]), "cap stays upright");
  void capBottomWorld;
  // the fixed base never moves
  assert.deepEqual(base.position, [0, 0, 0]);
});

test("mates chain outwards from the fixed part, and unanchored mates are reported", () => {
  const A = { id: "a", type: "insert", part: "parts/x.part.json", position: [0, 0, 0], fixed: true };
  const B = { id: "b", type: "insert", part: "parts/x.part.json", position: [50, 0, 0] };
  const C = { id: "c", type: "insert", part: "parts/x.part.json", position: [90, 0, 0] };
  const X = { id: "x", type: "insert", part: "parts/y.part.json", position: [0, 99, 0] };
  const Y = { id: "y", type: "insert", part: "parts/y.part.json", position: [0, 199, 0] };
  const top = { p: [0, 0, 10], n: [0, 0, 1] }, bottom = { p: [0, 0, 0], n: [0, 0, -1] };
  const part = { kind: "assembly", features: [A, B, C, X, Y,
    { id: "m2", type: "mate", a: { inst: "b", ...top }, b: { inst: "c", ...bottom } },   // listed before its anchor is placed
    { id: "m1", type: "mate", a: { inst: "a", ...top }, b: { inst: "b", ...bottom } },
    { id: "m3", type: "mate", a: { inst: "x", ...top }, b: { inst: "y", ...bottom } }] };  // x and y aren't fixed or connected
  // nothing ties x/y to a fixed part -> but A is fixed so x isn't "first instance"; m3 is reported
  const problems = solveMates(part);
  assert.ok(close(B.position, [0, 0, 10]) && close(C.position, [0, 0, 20]), JSON.stringify([B.position, C.position]));
  assert.equal(problems.length, 1); assert.match(problems[0], /m3/);
});

test("BOM groups instances of the same part studio", () => {
  const part = { kind: "assembly", features: [
    { id: "a", type: "insert", part: "parts/wheel.part.json" }, { id: "b", type: "insert", part: "parts/wheel.part.json" },
    { id: "c", type: "insert", part: "parts/frame.part.json" }, { id: "m", type: "mate" }] };
  const rows = bom(part, { owners: ["a", "b", "c"], stats: [{ mass: 10 }, { mass: 10 }, { mass: 50 }] });
  assert.deepEqual(rows.map((r) => [r.name, r.qty, r.mass]), [["wheel", 2, 10], ["frame", 1, 50]]);
});
