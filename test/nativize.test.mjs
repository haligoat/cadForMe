import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initKernel } from "./helpers.mjs";
import { initSolver } from "../src/kernel/sketch2.js";
import { buildPart, measure } from "../src/kernel/geometry.js";
import { nativizePart } from "../src/onshape/nativize.js";
import { bodiesBefore } from "../src/onshape/bodies.js";

before(async () => { await initKernel(); await initSolver(fs.readFileSync(new URL("../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url))); });

const summary = (part) => {
  const r = buildPart(part);
  assert.deepEqual(r.errors, {});
  return measure(r.bodies).map((m, i) => ({ volume: m.volume, bounds: r.bodies[i].boundingBox.bounds.flat() }));
};
const same = (a, b) => {
  assert.equal(a.length, b.length, "body count");
  a.forEach((x, i) => {
    assert.ok(Math.abs(x.volume - b[i].volume) < 0.05, `volume ${x.volume} vs ${b[i].volume}`);
    x.bounds.forEach((v, k) => assert.ok(Math.abs(v - b[i].bounds[k]) < 1e-3, `bounds ${x.bounds} vs ${b[i].bounds}`));
  });
};

// A bracket written the "primitive" way: blocks, cutters, booleans, a tilted cutter.
const bracket = {
  name: "Bracket",
  variables: { wall: 5, hole: 4.4 },
  features: [
    { id: "base", type: "box", name: "Base", position: [20, 0, -5], w: 40, d: 30, h: "wall", mode: "new" },
    { id: "up", type: "box", name: "Upright", position: [2.5, 0, -40], w: "wall", d: 30, h: 40, mode: "new" },
    { id: "u1", type: "boolean", name: "L", a: 0, b: 1, op: "union" },
    { id: "rib", type: "box", name: "Rib blank", position: [20, 0, -35], w: 30, d: 4, h: 30, mode: "new" },
    { id: "diag", type: "box", name: "Rib diagonal (cutter)", position: [-30, 0, -60], w: 60, d: 8, h: 120, mode: "new" },
    { id: "t1", type: "transform", name: "Tilt diagonal", body: 2, rotate: 45, axis: [0, 1, 0], origin: [0, 0, 0], translate: [20, 0, -20] },
    { id: "i1", type: "boolean", name: "Rib", a: 1, b: 2, op: "intersect" },
    { id: "u2", type: "boolean", name: "Add rib", a: 0, b: 1, op: "union" },
    { id: "h1", type: "cylinder", name: "Hole 1 (cutter)", position: [15, -8, -6], direction: [0, 0, 1], r: "hole/2", h: 7, mode: "new" },
    { id: "s1", type: "boolean", name: "Hole 1", a: 0, b: 1, op: "subtract" },
    { id: "h2", type: "cylinder", name: "Hole 2 (cutter)", position: [30, 8, -6], direction: [0, 0, 1], r: "hole/2", h: 7, mode: "new" },
    { id: "s2", type: "boolean", name: "Hole 2", a: 0, b: 1, op: "subtract" },
    { id: "h3", type: "cylinder", name: "Side hole (cutter)", position: [-1, 0, -20], direction: [1, 0, 0], r: "hole/2", h: 7, mode: "new" },
    { id: "s3", type: "boolean", name: "Side hole", a: 0, b: 1, op: "subtract" },
  ],
};

test("boxes and cylinders become sketch + extrude with exactly the same geometry", () => {
  const { part, changed, warnings } = nativizePart(bracket);
  assert.deepEqual(warnings, []);
  same(summary(bracket), summary(part));
  assert.ok(!part.features.some((f) => f.type === "box" || f.type === "cylinder" || f.type === "plane"), "no primitives and no construction planes left");
  assert.ok(!part.features.some((f) => f.id === "t1"), "the tilt is built into the cutter's sketch");
  assert.equal(changed.length, 7);
  // Variables survive as sketch dimensions and extrude depths, so editing them still drives the part.
  assert.equal(part.features.find((f) => f.id === "base").distance, "wall");
  assert.equal(part.features.find((f) => f.id === "h1sk").cons.find((c) => c.k === "radius").v, "hole/2");
  // Offsets live on the sketch (Onshape gets them as the extrude's start offset).
  assert.equal(part.features.find((f) => f.id === "upsk").offset, -40);
});

test("cutters subtracted straight away become cuts, and same-plane cuts share one sketch", () => {
  const { part } = nativizePart(bracket);
  const cuts = part.features.filter((f) => f.type === "extrude" && f.mode === "cut");
  assert.deepEqual(cuts.map((f) => f.id), ["h1", "h3"]);
  assert.equal(cuts[0].name, "Hole 1 (+1 more)");
  assert.equal(part.features.find((f) => f.id === cuts[0].sketch).geom.filter((g) => g.t === "circle").length, 2);
  assert.deepEqual(part.features.filter((f) => f.type === "boolean").map((f) => f.id), ["u1", "i1", "u2"]);
  // Changing a variable still gives the same part both ways.
  same(summary({ ...bracket, variables: { wall: 6, hole: 5 } }), summary({ ...part, variables: { wall: 6, hole: 5 } }));
});

test("running it twice changes nothing more", () => {
  const once = nativizePart(bracket).part;
  const twice = nativizePart(once);
  assert.deepEqual(twice.part, once);
  assert.deepEqual(twice.changed, []);
});

test("a cutter used after other bodies appear keeps its boolean; tilted cylinders stay as they are", () => {
  const part = { variables: {}, features: [
    { id: "a", type: "box", position: [0, 0, 0], w: 10, d: 10, h: 10 },
    { id: "b", type: "box", position: [30, 0, 0], w: 10, d: 10, h: 10 },
    { id: "c", type: "cylinder", position: [0, 0, -1], direction: [0, 0, 1], r: 2, h: 12 },
    { id: "s", type: "boolean", a: 0, b: 2, op: "subtract" },
    { id: "t", type: "cylinder", position: [30, 0, 0], direction: [1, 1, 0], r: 1, h: 5 },
  ] };
  const { part: out, warnings } = nativizePart(part);
  same(summary(part), summary(out));
  assert.ok(out.features.some((f) => f.id === "s" && f.type === "boolean"));
  assert.equal(out.features.find((f) => f.id === "c").mode, "new");
  assert.equal(out.features.find((f) => f.id === "t").type, "cylinder");
  assert.equal(warnings.length, 1);
});

test("body bookkeeping follows booleans, copies, deletes, and gives up on merges by touch", () => {
  const at = bodiesBefore([
    { id: "a", type: "box" }, { id: "b", type: "box" }, { id: "u", type: "boolean", a: 0, b: 1, op: "union" },
    { id: "c", type: "transform", body: 0, copy: true, translate: [5, 0, 0] }, { id: "d", type: "deleteBody", body: 0 },
    { id: "e", type: "extrude", sketch: "x" },
  ]);
  assert.deepEqual(at.get("c").map((e) => e.from), [["a", "b", "u"]]);
  assert.deepEqual(at.get("d").map((e) => e.from), [["a", "b", "u"], ["c"]]);
  assert.deepEqual(at.get("e").map((e) => e.from), [["c"]]);
  assert.equal(at.final, null, "an add that merges by touching can't be followed");
});
