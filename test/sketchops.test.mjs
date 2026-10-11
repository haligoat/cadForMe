import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initKernel } from "./helpers.mjs";
import { initSolver, solveSketch, loopsOf } from "../src/kernel/sketch2.js";
import { trim, fillet, mirror, offset } from "../src/kernel/sketchops.js";
import { makeEvaluator } from "../src/kernel/expr.js";
import { buildPart, measure } from "../src/kernel/geometry.js";

before(async () => { await initKernel(); await initSolver(fs.readFileSync(new URL("../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url))); });
const ev = makeEvaluator({});
const near = (a, b, t = 1e-3) => assert.ok(Math.abs(a - b) < t, `${a} vs ${b}`);
const P = (id, x, y) => ({ id, t: "point", x, y });
const L = (id, a, b) => ({ id, t: "line", a, b });
const rect = () => ({ geom: [P("p1", 0, 0), P("p2", 20, 0), P("p3", 20, 10), P("p4", 0, 10), L("l1", "p1", "p2"), L("l2", "p2", "p3"), L("l3", "p3", "p4"), L("l4", "p4", "p1")], cons: [] });
const solved = (s) => solveSketch(s, ev);
const area = (g) => { const { loops } = loopsOf(g); return loops.reduce((a, l) => a + Math.abs(l.pts.reduce((s, p, i) => s + (p[0] * l.pts[(i + 1) % l.pts.length][1] - l.pts[(i + 1) % l.pts.length][0] * p[1]), 0)) / 2, 0); };

test("fillet rounds a corner and stays solvable", () => {
  const s = rect(); fillet(s, "p3", 3);
  const r = solved(s); assert.ok(r.ok && !r.conflicting.length, JSON.stringify(r.conflicting));
  assert.equal(loopsOf(r.geom).loops.length, 1);
  near(area(r.geom), 200 - (9 - (Math.PI * 9) / 4), 0.3);
  assert.throws(() => fillet(rect(), "p1", 50), /too big/);
  assert.throws(() => fillet(rect(), "nope", 3));
});

test("trim a line back to the nearest crossing", () => {
  const s = { geom: [P("a", 0, 0), P("b", 30, 0), L("h", "a", "b"), P("c", 10, -5), P("d", 10, 5), L("v1", "c", "d"), P("e", 20, -5), P("f", 20, 5), L("v2", "e", "f")], cons: [] };
  const mid = JSON.parse(JSON.stringify(s)); trim(mid, "h", [15, 0]);
  const lines = mid.geom.filter((g) => g.t === "line" && g.id.startsWith("l") || g.id === "h");
  const hs = mid.geom.filter((g) => g.t === "line" && ["h", "l1"].includes(g.id));
  assert.equal(hs.length, 2); // split into two pieces; the middle (10..20) is gone
  const r = solved(mid); assert.ok(r.ok);
  const xs = hs.flatMap((l) => [l.a, l.b]).map((id) => r.geom.find((g) => g.id === id).x).sort((x, y) => x - y);
  near(xs[0], 0); near(xs[1], 10, 0.01); near(xs[2], 20, 0.01); near(xs[3], 30);
  const end = JSON.parse(JSON.stringify(s)); trim(end, "h", [25, 0]);
  const h = end.geom.find((g) => g.id === "h"); assert.ok(h.t === "line"); assert.equal(end.geom.filter((g) => g.t === "line").length, 3);
  const lone = { geom: [P("a", 0, 0), P("b", 5, 0), L("h", "a", "b")], cons: [] }; trim(lone, "h", [2, 0]);
  assert.equal(lone.geom.some((g) => g.id === "h"), false);
});

test("trim a circle into an arc", () => {
  const s = { geom: [P("c", 0, 0), { id: "k", t: "circle", c: "c", r: 10 }, P("a", -20, 5), P("b", 20, 5), L("ln", "a", "b")], cons: [] };
  trim(s, "k", [0, 10]);
  assert.equal(s.geom.some((g) => g.id === "k"), false);
  const arc = s.geom.find((g) => g.t === "arc"); assert.ok(arc);
  const r = solved(s); assert.ok(r.ok);
});

test("mirror keeps copies symmetric", () => {
  const s = { geom: [P("o1", 0, -10), P("o2", 0, 10), L("axis", "o1", "o2"), P("a", 5, 0), P("b", 15, 0), P("c", 15, 8), L("l1", "a", "b"), L("l2", "b", "c")], cons: [{ id: "k1", t: "vertical", a: "axis" }] };
  mirror(s, ["l1", "l2"], "axis");
  assert.equal(s.geom.filter((g) => g.t === "line").length, 5);
  const r = solved(s); assert.ok(r.ok && !r.conflicting.length);
  const pts = r.geom.filter((g) => g.t === "point").map((p) => [p.x, p.y]);
  assert.ok(pts.some(([x, y]) => Math.abs(x + 15) < 0.01 && Math.abs(y - 8) < 0.01));
  assert.throws(() => mirror(rect(), ["l1"], "p1"));
});

test("offset a loop and a circle", () => {
  const s = rect(); offset(s, ["l1", "l2", "l3", "l4"], 2);
  const r = solved(s); assert.ok(r.ok);
  const loops = loopsOf(r.geom).loops; assert.equal(loops.length, 2);
  const areas = loops.map((l) => Math.abs(l.pts.reduce((a, p, i) => a + (p[0] * l.pts[(i + 1) % 4][1] - l.pts[(i + 1) % 4][0] * p[1]), 0)) / 2).sort((a, b) => a - b);
  near(areas[0], 200, 0.5); near(areas[1], 24 * 14, 0.5); // outward by 2
  const inn = rect(); offset(inn, ["l1", "l2", "l3", "l4"], -2); const ri = solved(inn);
  near(Math.min(...loopsOf(ri.geom).loops.map((l) => Math.abs(l.pts.reduce((a, p, i) => a + (p[0] * l.pts[(i + 1) % 4][1] - l.pts[(i + 1) % 4][0] * p[1]), 0)) / 2)), 16 * 6, 0.5);
  const c = { geom: [P("c", 0, 0), { id: "k", t: "circle", c: "c", r: 5 }], cons: [] }; offset(c, ["k"], 3);
  assert.equal(c.geom.filter((g) => g.t === "circle").length, 2);
  assert.throws(() => offset(rect(), ["l1"], 1), /closed loop/);
});

test("ellipse sketches extrude", () => {
  const sk = { id: "s", type: "sketch", plane: "XY", geom: [P("c", 0, 0), P("f", 6, 0), { id: "e", t: "ellipse", c: "c", f: "f", r: 8 }], cons: [{ id: "k", t: "fix", a: "c" }] };
  const r = buildPart({ features: [sk, { id: "x", type: "extrude", sketch: "s", distance: 2 }] });
  assert.deepEqual(r.errors, {});
  const a = Math.sqrt(64 + 36); near(measure(r.bodies)[0].volume, Math.PI * a * 8 * 2, 1.5);
});
