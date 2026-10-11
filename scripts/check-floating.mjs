// Floating-parts audit for ~/cadSlop/test: every body must be connected to the frame through a chain of parts that touch
// (distance under 0.05 mm). Starts from the side plates and reports every body it can't reach. Usage: node scripts/check-floating.mjs
import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const p0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const GONE = new Set(p0.features.filter((f) => f.type === "deleteBody").flatMap((f) => [].concat(f.body)));
const part = { ...p0, features: p0.features.filter((f) => f.type !== "deleteBody") };
const files = {};
for (const f of part.features) {
  if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file));
  if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part));
}
const built = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const nm = (i) => { const f = part.features.find((g) => g.id === built.owners[i]); return f && String(f.id).startsWith("tx") ? f.name : `robot #${i}`; };
const bodies = built.bodies, N = bodies.length, B = bodies.map((s) => s.boundingBox.bounds), TOL = 0.05;
const near = (a, c) => [0, 1, 2].every((q) => a[0][q] <= c[1][q] + TOL && c[0][q] <= a[1][q] + TOL);
const adj = Array.from({ length: N }, () => []);
for (let i = 0; i < N; i++) {
  if (GONE.has(i)) continue;
  for (let j = i + 1; j < N; j++) {
    if (GONE.has(j) || !near(B[i], B[j])) continue;
    let d = 1; try { d = R.measureDistanceBetween(bodies[i], bodies[j]); } catch { d = 0; }   // can't tell: assume touching
    if (d < TOL) { adj[i].push(j); adj[j].push(i); }
  }
}
const seen = new Set([7, 0]), queue = [7, 0];
while (queue.length) { const i = queue.shift(); for (const j of adj[i]) if (!seen.has(j)) { seen.add(j); queue.push(j); } }
const floating = []; for (let i = 0; i < N; i++) if (!GONE.has(i) && !seen.has(i)) floating.push(i);
// group floating bodies that touch each other (one floating assembly = one problem)
const groups = [], done = new Set();
for (const i of floating) { if (done.has(i)) continue; const g = [i], q = [i]; done.add(i); while (q.length) { const k = q.shift(); for (const j of adj[k]) if (!done.has(j) && !seen.has(j)) { done.add(j); g.push(j); q.push(j); } } groups.push(g); }
console.log(`bodies ${N - GONE.size}, connected to the frame ${seen.size}, floating ${floating.length} in ${groups.length} group(s)`);
for (const g of groups) console.log(`  FLOATING: ${[...new Set(g.map(nm))].slice(0, 6).join(" | ")}${g.length > 6 ? ` (+${g.length - 6} more)` : ""}`);
