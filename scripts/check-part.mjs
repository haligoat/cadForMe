// Checks a multi-body part: build errors, sketch solve status (DOF / conflicts / drift), overall size, and
// pairwise interference between bodies. Usage: node scripts/check-part.mjs <project dir> <parts/x.part.json>
import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { initSolver, solveSketch } from "../src/kernel/sketch2.js";
import { buildPart, measure } from "../src/kernel/geometry.js";
import { makeEvaluator } from "../src/kernel/expr.js";

const [dir, rel] = process.argv.slice(2);
await initKernel(); await initSolver(fs.readFileSync("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"));
const part = JSON.parse(fs.readFileSync(`${dir}/${rel}`, "utf8"));
const ev = makeEvaluator(part.variables);
let bad = 0;
for (const f of part.features.filter((x) => x.type === "sketch")) {
  const r = solveSketch(f, ev);
  const drift = Math.max(0, ...r.geom.filter((g) => g.t === "point").map((g) => { const o = f.geom.find((q) => q.id === g.id); return Math.hypot(g.x - o.x, g.y - o.y); }));
  if (r.dof || !r.ok || r.conflicting.length || drift > 0.01 || Object.keys(r.errors).length) { bad++; console.log(`SKETCH ${f.name}: dof=${r.dof} ok=${r.ok} conflicting=${r.conflicting} drift=${drift.toFixed(3)} ${JSON.stringify(r.errors)}`); }
}
console.log(`sketches: ${part.features.filter((x) => x.type === "sketch").length}, not fully defined/clean: ${bad}`);
const r = buildPart(part);
console.log("build errors:", JSON.stringify(r.errors));
const m = measure(r.bodies, part.material?.density);
const lo = [0, 1, 2].map((i) => Math.min(...m.map((x) => x.bounds[0][i]))), hi = [0, 1, 2].map((i) => Math.max(...m.map((x) => x.bounds[1][i])));
console.log(`bodies: ${r.bodies.length}; overall X ${lo[0].toFixed(1)}..${hi[0].toFixed(1)}  Y ${lo[1].toFixed(1)}..${hi[1].toFixed(1)}  Z ${lo[2].toFixed(1)}..${hi[2].toFixed(1)}  size ${hi.map((h, i) => (h - lo[i]).toFixed(1)).join(" x ")} mm`);
const overlaps = [];
for (let i = 0; i < r.bodies.length; i++) for (let j = i + 1; j < r.bodies.length; j++) {
  const a = m[i].bounds, b = m[j].bounds;
  if ([0, 1, 2].some((k) => a[1][k] <= b[0][k] + 1e-6 || b[1][k] <= a[0][k] + 1e-6)) continue;
  try { const x = r.bodies[i].clone().intersect(r.bodies[j].clone()); const v = R.measureVolume(x); if (v > 0.5) overlaps.push(`${i}×${j}: ${v.toFixed(1)} mm³`); } catch (e) { overlaps.push(`${i}×${j}: intersect failed`); }
}
console.log(overlaps.length ? `INTERFERENCE:\n  ${overlaps.join("\n  ")}` : "no interference");
