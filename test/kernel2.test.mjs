import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initKernel } from "./helpers.mjs";
import { initSolver } from "../src/kernel/sketch2.js";
import { buildPart, measure } from "../src/kernel/geometry.js";

before(async () => { await initKernel(); await initSolver(fs.readFileSync(new URL("../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url))); });
const near = (a, b, t = 0.5) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const rect = (id, w, h, plane = "XY", cx = 0, cy = 0, extra = {}) => {
  const pts = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]].map(([x, y], i) => ({ id: `p${i}`, t: "point", x, y }));
  return { id, type: "sketch", plane, geom: [...pts, ...pts.map((p, i) => ({ id: `l${i}`, t: "line", a: p.id, b: pts[(i + 1) % 4].id }))], cons: [], ...extra };
};
const circle = (id, r, plane = "XY", extra = {}) => ({ id, type: "sketch", plane, geom: [{ id: "c", t: "point", x: 0, y: 0 }, { id: "k", t: "circle", c: "c", r }], cons: [], ...extra });
const vol = (r) => measure(r.bodies).map((m) => m.volume);

test("construction planes: offset, three-point, angle, midplane", () => {
  const part = (plane, extra = []) => ({ features: [...extra, rect("s", 10, 10, plane), { id: "e", type: "extrude", sketch: "s", distance: 2 }] });
  const off = buildPart(part("pl", [{ id: "pl", type: "plane", mode: "offset", from: "XY", distance: 15 }]));
  assert.deepEqual(off.errors, {}); near(measure(off.bodies)[0].bounds[0][2], 15, 0.01);
  const tri = buildPart(part("pl", [{ id: "pl", type: "plane", mode: "threePoint", pts: [[0, 0, 5], [10, 0, 5], [0, 10, 5]] }]));
  assert.deepEqual(tri.errors, {}); near(measure(tri.bodies)[0].bounds[0][2], 5, 0.01);
  const ang = buildPart(part("pl", [{ id: "pl", type: "plane", mode: "angle", from: "XY", axis: [1, 0, 0], point: [0, 0, 0], angle: 90 }]));
  assert.deepEqual(ang.errors, {}); near(measure(ang.bodies)[0].size[2], 10, 0.01); // stood up on edge: 10 tall
  const mid = buildPart(part("pl", [{ id: "pl", type: "plane", mode: "midplane", a: "XY", b: { } && "XY" }]));
  assert.ok(mid.errors.pl === undefined);
  const bad = buildPart(part("nope"));
  assert.match(bad.errors.e ?? bad.errors.s ?? "", /Unknown plane/);
});

test("draft angle tapers an extrude", () => {
  const straight = buildPart({ features: [rect("s", 20, 10), { id: "e", type: "extrude", sketch: "s", distance: 10 }] });
  const drafted = buildPart({ features: [rect("s", 20, 10), { id: "e", type: "extrude", sketch: "s", distance: 10, draft: 5 }] });
  assert.deepEqual(drafted.errors, {});
  assert.ok(vol(drafted)[0] < vol(straight)[0] - 100);
  const m = measure(drafted.bodies)[0]; near(m.size[0], 20, 0.01); near(m.size[2], 10, 0.01);
  const holes = buildPart({ features: [{ ...rect("s", 20, 10), geom: [...rect("s", 20, 10).geom, { id: "hc", t: "point", x: 0, y: 0 }, { id: "hh", t: "circle", c: "hc", r: 2 }] }, { id: "e", type: "extrude", sketch: "s", distance: 10, draft: 5 }] });
  assert.match(holes.errors.e, /without holes/);
});

test("loft between two sketches, sweep along a path", () => {
  const lo = buildPart({ features: [rect("a", 20, 20), rect("b", 10, 10, { }.x ?? "XY", 0, 0, { offset: 20 }), { id: "l", type: "loft", sketches: ["a", "b"] }] });
  assert.deepEqual(lo.errors, {});
  near(vol(lo)[0], (20 * 20 + 10 * 10 + Math.sqrt(20 * 20 * 10 * 10)) * 20 / 3, 40); // frustum
  const path = { id: "pa", type: "sketch", plane: "XZ", geom: [{ id: "a", t: "point", x: 0, y: 0 }, { id: "b", t: "point", x: 0, y: 30 }, { id: "c", t: "point", x: 20, y: 30 }, { id: "l1", t: "line", a: "a", b: "b" }, { id: "l2", t: "line", a: "b", b: "c" }], cons: [] };
  const sw = buildPart({ features: [circle("pr", 2), path, { id: "s", type: "sweep", profile: "pr", path: "pa" }] });
  assert.deepEqual(sw.errors, {});
  near(vol(sw)[0], Math.PI * 4 * 50, 15); // area * path length (30 + 20)
});

test("split a body with a plane", () => {
  const base = [{ id: "b", type: "box", w: 20, d: 20, h: 20 }];
  const both = buildPart({ features: [...base, { id: "sp", type: "split", body: 0, origin: [0, 0, 10], normal: [0, 0, 1] }] });
  assert.deepEqual(both.errors, {}); assert.equal(both.bodies.length, 2);
  vol(both).forEach((v) => near(v, 4000, 5));
  const above = buildPart({ features: [...base, { id: "sp", type: "split", body: 0, origin: [0, 0, 5], normal: [0, 0, 1], keep: "above" }] });
  assert.equal(above.bodies.length, 1); near(vol(above)[0], 20 * 20 * 15, 5);
});

test("countersink hole, scale, twist, configurations", () => {
  const plain = buildPart({ features: [{ id: "b", type: "box", w: 20, d: 20, h: 10 }, { id: "h", type: "hole", position: [0, 0, 10], normal: [0, 0, 1], diameter: 4, through: true }] });
  const csk = buildPart({ features: [{ id: "b", type: "box", w: 20, d: 20, h: 10 }, { id: "h", type: "hole", position: [0, 0, 10], normal: [0, 0, 1], diameter: 4, through: true, style: "countersink", csinkDiameter: 8, csinkAngle: 90 }] });
  assert.deepEqual(csk.errors, {}); assert.ok(vol(csk)[0] < vol(plain)[0] - 15);
  const scaled = buildPart({ features: [{ id: "b", type: "box", w: 10, d: 10, h: 10 }, { id: "t", type: "transform", body: 0, scale: 2 }] });
  near(vol(scaled)[0], 8000, 5);
  const tw = buildPart({ features: [rect("s", 10, 10), { id: "e", type: "extrude", sketch: "s", distance: 20, twist: 90 }] });
  assert.deepEqual(tw.errors, {}); near(vol(tw)[0], 2000, 40);
  const cfgPart = { variables: { w: 10 }, configs: { Big: { w: 30 } }, features: [{ id: "b", type: "box", w: "w", d: 10, h: 10 }] };
  near(vol(buildPart(cfgPart))[0], 1000, 1);
  near(vol(buildPart({ ...cfgPart, config: "Big" }))[0], 3000, 1);
});

test("insert parts: assemblies with per-instance variable overrides", async () => {
  const { collectParts } = await import("../src/kernel/geometry.js");
  const wheel = { variables: { r: 10, w: 5 }, features: [{ id: "c", type: "cylinder", r: "r", h: "w", direction: [0, 1, 0] }] };
  const axle = { variables: {}, features: [{ id: "b", type: "box", w: 2, d: 40, h: 2 }] };
  const files = { "parts/wheel.part.json": JSON.stringify(wheel), "parts/axle.part.json": JSON.stringify(axle) };
  const asm = { variables: { big: 20 }, features: [
    { id: "i1", type: "insert", part: "parts/axle.part.json" },
    { id: "i2", type: "insert", part: "parts/wheel.part.json", position: [0, 20, 0], vars: { r: 10 }, mode: "new" },
    { id: "i3", type: "insert", part: "parts/wheel.part.json", position: [0, -25, 0], vars: { r: "big" }, mode: "new" },
  ] };
  const parts = collectParts(asm, files);
  assert.equal(parts.size, 2);
  const r = buildPart(asm, { parts });
  assert.deepEqual(r.errors, {}); assert.equal(r.bodies.length, 3);
  const v = vol(r); near(v[1], Math.PI * 100 * 5, 2); near(v[2], Math.PI * 400 * 5, 4); // override from the parent's variable
  const missing = buildPart({ features: [{ id: "i", type: "insert", part: "parts/nope.part.json" }] }, { parts: new Map() });
  assert.match(missing.errors.i, /couldn't be loaded/);
  const selfRef = { features: [{ id: "i", type: "insert", part: "parts/me.part.json" }] };
  const loop = buildPart(selfRef, { parts: new Map([["parts/me.part.json", selfRef]]) });
  assert.match(loop.errors.i, /too deeply|error/);
});

test("engineering drawing sheet", async () => {
  const { makeDrawing } = await import("../src/kernel/geometry.js");
  const r = buildPart({ features: [{ id: "b", type: "box", w: 60, d: 30, h: 12 }, { id: "c", type: "cylinder", r: 4, h: 40, position: [10, 0, -10], mode: "cut" }] });
  const svg = makeDrawing(r.bodies, { name: "Test <plate>", material: "Aluminum 6061", mass: 52.3 });
  assert.match(svg, /^<svg/); assert.match(svg, /FRONT/); assert.match(svg, /ISOMETRIC/); assert.match(svg, /Test &lt;plate&gt;/); assert.match(svg, /60/); assert.match(svg, /Mass 52.30 g/);
  assert.ok((svg.match(/<path /g) ?? []).length >= 8); // visible + hidden per view
  fs.mkdirSync(new URL("../.scratch/", import.meta.url), { recursive: true });
  fs.writeFileSync(new URL("../.scratch/drawing.svg", import.meta.url), svg);
  assert.throws(() => makeDrawing([]), /Nothing to draw/);
});

test("gear, coil, two-direction pattern", () => {
  const g = buildPart({ features: [{ id: "g", type: "gear", module: 2, teeth: 20, thickness: 5, bore: 8 }] });
  assert.deepEqual(g.errors, {}); const m = measure(g.bodies)[0];
  near(m.size[0], 44, 0.1); near(m.volume, Math.PI * (20 ** 2 - 4 ** 2) * 5, 250);
  const big = buildPart({ features: [{ id: "g", type: "gear", module: 1, teeth: 60, thickness: 3 }] }); assert.deepEqual(big.errors, {}); // root above the base circle
  assert.match(buildPart({ features: [{ id: "g", type: "gear", teeth: 3 }] }).errors.g, /at least 6/);
  const c = buildPart({ features: [{ id: "c", type: "coil", radius: 10, pitch: 5, height: 30, wire: 2 }] });
  assert.deepEqual(c.errors, {}); near(vol(c)[0], 1187, 25);
  assert.match(buildPart({ features: [{ id: "c", type: "coil", pitch: 2, wire: 3 }] }).errors.c, /thinner/);
  const grid = buildPart({ features: [{ id: "b", type: "box", w: 4, d: 4, h: 4 }, { id: "p", type: "linearPattern", direction: [1, 0, 0], distance: 10, count: 3, direction2: [0, 1, 0], distance2: 10, count2: 2, merge: false }] });
  assert.equal(grid.bodies.length, 6);
});

test("standard parts library builds every size", async () => {
  const { CATALOG, SIZES, BEARINGS, socketScrew, hole } = await import("../src/kernel/standard.js");
  for (const size of SIZES) for (const item of CATALOG.filter((c) => ["screw", "nut", "washer"].includes(c.id))) {
    const r = buildPart(item.build({ size, length: 20 }));
    assert.deepEqual(r.errors, {}, `${item.id} ${size}`); assert.equal(r.bodies.length, 1, `${item.id} ${size}`);
  }
  for (const code of BEARINGS) { const r = buildPart(CATALOG.find((c) => c.id === "bearing").build({ code })); assert.deepEqual(r.errors, {}); }
  const gear = buildPart(CATALOG.find((c) => c.id === "gear").build({ module: 1.5, teeth: 24, thickness: 6, bore: 8 })); assert.deepEqual(gear.errors, {});
  const m5 = measure(buildPart(socketScrew("M5", 20)).bodies)[0];
  near(m5.size[2], 5 + 20, 0.05); near(m5.size[0], 8.5, 0.05);        // head height + length, head diameter
  const vHead = Math.PI * 4.25 ** 2 * 5, vShank = Math.PI * 2.5 ** 2 * 20; assert.ok(m5.volume < vHead + vShank && m5.volume > vHead + vShank - 80); // minus the hex socket
  assert.equal(hole.clearance.M5, 5.5);
});
