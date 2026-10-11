// Collision check for ~/cadSlop/test: every body made or moved by "tx" features against everything else.
// Skips intended press fits (wheels/bearings/couplers on their shafts) and overlaps that were already in the imported robot
// (scripts/original-overlaps.json, made once by scripts/original-overlaps.mjs). Usage: node scripts/check-hardware.mjs
import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const part0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
// build without the trailing deleteBody so robot body numbers stay the original ones; skip the deleted bodies instead
const GONE = new Set(part0.features.filter((f) => f.type === "deleteBody").flatMap((f) => [].concat(f.body)));
const part = { ...part0, features: part0.features.filter((f) => f.type !== "deleteBody") };
const files = {};
for (const f of part.features) {
  if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file));
  if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part));
}
const built = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const errs = Object.entries(built.errors ?? {}); if (errs.length) console.log("ERRORS", JSON.stringify(errs).slice(0, 500));
const ORIG = JSON.parse(fs.readFileSync(new URL("./original-overlaps.json", import.meta.url), "utf8"));
const origVol = (i, j) => ORIG[`${Math.min(i, j)}-${Math.max(i, j)}`] ?? 0;
const name = (i) => { const f = part.features.find((g) => g.id === built.owners[i]); return f && String(f.id).startsWith("tx") ? f.name : `robot #${i}`; };
const moved = new Set(part.features.filter((f) => f.type === "transform" && String(f.id).startsWith("tx")).flatMap((f) => [].concat(f.body)));
const mine = (i) => i >= 623 || moved.has(i);
const B = built.bodies.map((b) => b.boundingBox.bounds);
const ov = (a, b) => [0, 1, 2].every((q) => a[0][q] < b[1][q] - 0.05 && b[0][q] < a[1][q] - 0.05);
const press = (a, b) => [[a, b], [b, a]].some(([s, t]) => /shaft|robot #13$/i.test(s) && /wheel|bearing (?!plate)|bearing$|coupler/i.test(t) && !/bearing plate/i.test(t)) || (/coupler/i.test(a) && /motor/i.test(b)) || (/motor/i.test(a) && /coupler/i.test(b));
/** Overlap volume (mm³); intersect consumes its inputs, so only the result is freed. -1 if the kernel can't tell. */
function overlap(a, b) {
  for (const [p, q] of [[a, b], [b, a]]) { let r = null; try { r = p.clone().intersect(q.clone()); return R.measureVolume(r); } catch { /* other order */ } finally { try { r?.delete(); } catch { /* freed */ } } }
  return -1;
}
let n = 0;
for (let i = 0; i < built.bodies.length; i++) {
  if (!mine(i) || GONE.has(i)) continue;
  for (let j = 0; j < built.bodies.length; j++) {
    if (j === i || GONE.has(j) || (mine(j) && j < i) || !ov(B[i], B[j]) || press(name(i), name(j))) continue;
    const v = overlap(built.bodies[i], built.bodies[j]);
    if (!(v > 1 || v < 0)) continue;
    if (i < 623 && j < 623 && v <= origVol(i, j) + 1) continue;   // already in the original, not made worse
    n++; console.log("HIT", Math.round(v), "mm3 |", name(i), "<->", name(j));
  }
}
console.log(`bodies ${built.bodies.length - GONE.size}, new collisions ${n}`);
