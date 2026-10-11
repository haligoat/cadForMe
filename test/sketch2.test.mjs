import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initKernel } from "./helpers.mjs";
import { initSolver, solveSketch, loopsOf } from "../src/kernel/sketch2.js";
import { makeEvaluator } from "../src/kernel/expr.js";

before(async () => { await initKernel(); await initSolver(fs.readFileSync(new URL("../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url))); });
const ev = makeEvaluator({ w: 40 });
const near = (a, b, t = 1e-4) => assert.ok(Math.abs(a - b) < t, `${a} vs ${b}`);

const rect = () => ({ geom: [
  { id: "p1", t: "point", x: 0, y: 0 }, { id: "p2", t: "point", x: 31, y: 2 }, { id: "p3", t: "point", x: 29, y: 18 }, { id: "p4", t: "point", x: 1, y: 20 },
  { id: "l1", t: "line", a: "p1", b: "p2" }, { id: "l2", t: "line", a: "p2", b: "p3" }, { id: "l3", t: "line", a: "p3", b: "p4" }, { id: "l4", t: "line", a: "p4", b: "p1" }],
cons: [
  { id: "k1", t: "horizontal", a: "l1" }, { id: "k2", t: "vertical", a: "l2" }, { id: "k3", t: "horizontal", a: "l3" }, { id: "k4", t: "vertical", a: "l4" },
  { id: "k5", t: "fix", a: "p1" }, { id: "d1", t: "dim", k: "length", a: "l1", v: "w" }, { id: "d2", t: "dim", k: "length", a: "l2", v: 20 }] });

test("constraints + dimensions solve a rectangle", () => {
  const r = solveSketch(rect(), ev);
  assert.ok(r.ok); assert.equal(r.dof, 0);
  const p = Object.fromEntries(r.geom.filter((g) => g.t === "point").map((g) => [g.id, g]));
  near(p.p2.x, 40); near(p.p2.y, 0); near(p.p3.x, 40); near(p.p3.y, 20); near(p.p4.x, 0); near(p.p4.y, 20);
  assert.equal(loopsOf(r.geom).loops.length, 1);
});

test("dimension changes drive the geometry; conflicts are reported", () => {
  const sk = rect(); sk.cons.find((c) => c.id === "d1").v = 55;
  near(solveSketch(sk, ev).geom.find((g) => g.id === "p2").x, 55);
  sk.cons.push({ id: "d3", t: "dim", k: "length", a: "l1", v: 10 });
  const bad = solveSketch(sk, ev);
  assert.ok(bad.conflicting.length > 0);
});

test("circle, arc, tangent, and drag", () => {
  const sk = { geom: [
    { id: "c0", t: "point", x: 5, y: 5 }, { id: "ci", t: "circle", c: "c0", r: 3 },
    { id: "ac", t: "point", x: 20, y: 0 }, { id: "as", t: "point", x: 23, y: 0 }, { id: "ae", t: "point", x: 20, y: 3 }, { id: "ar", t: "arc", c: "ac", s: "as", e: "ae" }],
  cons: [{ id: "k1", t: "dim", k: "diameter", a: "ci", v: 12 }, { id: "k2", t: "dim", k: "radius", a: "ar", v: 5 }] };
  const r = solveSketch(sk, ev);
  near(r.geom.find((g) => g.id === "ci").r, 6);
  const as = r.geom.find((g) => g.id === "as"), ac = r.geom.find((g) => g.id === "ac");
  near(Math.hypot(as.x - ac.x, as.y - ac.y), 5, 1e-3);
  const d = solveSketch(rect(), ev, { drag: { p3: [60, 30] } });
  near(d.geom.find((g) => g.id === "p3").x, 60);
});

test("sketch profile extrudes with a hole (nested loop) and arcs", async () => {
  const { buildPart, measure } = await import("../src/kernel/geometry.js");
  const sk = rect(); sk.id = "s1"; sk.type = "sketch";
  sk.geom.push({ id: "hc", t: "point", x: 20, y: 10 }, { id: "hole", t: "circle", c: "hc", r: 4 });
  const part = { variables: { w: 40 }, features: [sk, { id: "e", type: "extrude", sketch: "s1", distance: 5 }] };
  const r = buildPart(part);
  assert.deepEqual(r.errors, {});
  near(measure(r.bodies)[0].volume, (40 * 20 - Math.PI * 16) * 5, 0.5);
});

test("extrude only the chosen regions", async () => {
  const { buildPart, measure } = await import("../src/kernel/geometry.js");
  const rectGeom = (x0, id) => ({ pts: [[x0, 0], [x0 + 10, 0], [x0 + 10, 10], [x0, 10]], id });
  const geom = []; const cons = [];
  for (const [k, x0] of [["a", 0], ["b", 30]]) {
    const ps = [[x0, 0], [x0 + 10, 0], [x0 + 10, 10], [x0, 10]].map(([x, y], i) => ({ id: `${k}p${i}`, t: "point", x, y }));
    geom.push(...ps, ...ps.map((p, i) => ({ id: `${k}l${i}`, t: "line", a: p.id, b: ps[(i + 1) % 4].id })));
  }
  const sk = { id: "s1", type: "sketch", plane: "XY", geom, cons };
  const vol = (regions) => measure(buildPart({ features: [sk, { id: "e", type: "extrude", sketch: "s1", distance: 2, regions }] }).bodies).map((m) => Math.round(m.volume));
  assert.deepEqual(vol(undefined), [400]);
  assert.deepEqual(vol([[35, 5]]), [200]);
  assert.equal(buildPart({ features: [sk, { id: "e", type: "extrude", sketch: "s1", distance: 2, regions: [[200, 200]] }] }).errors.e.includes("no longer exists"), true);
});
