import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initKernel } from "./helpers.mjs";
import { initSolver, solveSketch, loopsOf } from "../src/kernel/sketch2.js";
import { parseDXF, dxfToGeom, sketchToDXF } from "../src/kernel/dxf.js";
import { makeEvaluator } from "../src/kernel/expr.js";
import { buildPart, measure } from "../src/kernel/geometry.js";

before(async () => { await initKernel(); await initSolver(fs.readFileSync(new URL("../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url))); });
const dxf = (...rows) => ["0", "SECTION", "2", "ENTITIES", ...rows.flat().map(String), "0", "ENDSEC", "0", "EOF"].join("\r\n");
const line = (x1, y1, x2, y2) => [0, "LINE", 8, "0", 10, x1, 20, y1, 11, x2, 21, y2];

test("import lines + circle from DXF, share corner points, and extrude", () => {
  const text = dxf(line(0, 0, 40, 0), line(40, 0, 40, 20), line(40, 20, 0, 20), line(0, 20, 0, 0), [0, "CIRCLE", 10, 20, 20, 10, 40, 4]);
  const geom = dxfToGeom(parseDXF(text));
  assert.equal(geom.filter((g) => g.t === "point").length, 5); assert.equal(geom.filter((g) => g.t === "line").length, 4);
  const r = solveSketch({ geom, cons: [] }, makeEvaluator({})); assert.ok(r.ok); assert.equal(loopsOf(r.geom).loops.length, 2);
  const part = { features: [{ id: "s", type: "sketch", plane: "XY", geom, cons: [] }, { id: "e", type: "extrude", sketch: "s", distance: 2 }] };
  const b = buildPart(part); assert.deepEqual(b.errors, {});
  assert.ok(Math.abs(measure(b.bodies)[0].volume - (800 - Math.PI * 16) * 2) < 1);
});

test("arcs, bulges (rounded rectangle), inches", () => {
  const rr = dxf([0, "LWPOLYLINE", 90, 4, 70, 1, 10, 0, 20, 0, 42, 0.41421356, 10, 10, 20, 0, 10, 10, 20, 10, 42, 0, 10, 0, 20, 10]);
  const g = dxfToGeom(parseDXF(rr));
  assert.equal(g.filter((x) => x.t === "arc").length, 1); // the bulged corner
  const inch = dxf([0, "CIRCLE", 10, 1, 20, 1, 40, 0.5]).replace("SECTION\r\n2\r\nENTITIES", "SECTION\r\n2\r\nHEADER\r\n9\r\n$INSUNITS\r\n70\r\n1\r\n0\r\nENDSEC\r\n0\r\nSECTION\r\n2\r\nENTITIES");
  const gi = dxfToGeom(parseDXF(inch)); assert.ok(Math.abs(gi.find((x) => x.t === "circle").r - 12.7) < 1e-6);
  const arc = dxfToGeom(parseDXF(dxf([0, "ARC", 10, 0, 20, 0, 40, 5, 50, 0, 51, 90])));
  const r = solveSketch({ geom: arc, cons: [] }, makeEvaluator({})); assert.ok(r.ok);
  assert.throws(() => parseDXF("nonsense"), /ENTITIES/); assert.throws(() => dxfToGeom(parseDXF(dxf())), /No lines/);
});

test("export a sketch to DXF and read it back", () => {
  const src = dxfToGeom(parseDXF(dxf(line(0, 0, 30, 0), line(30, 0, 30, 10), line(30, 10, 0, 0), [0, "CIRCLE", 10, 10, 20, 3, 40, 1.5], [0, "ARC", 10, 50, 20, 0, 40, 6, 50, 30, 51, 150])));
  const out = sketchToDXF(src);
  assert.match(out, /^0\nSECTION/); assert.ok(out.includes("CIRCLE") && out.includes("ARC"));
  const back = dxfToGeom(parseDXF(out));
  assert.equal(back.filter((x) => x.t === "line").length, 3); assert.equal(back.filter((x) => x.t === "arc").length, 1);
  assert.throws(() => sketchToDXF([{ id: "p", t: "point", x: 0, y: 0 }]), /nothing|no lines/i);
});
