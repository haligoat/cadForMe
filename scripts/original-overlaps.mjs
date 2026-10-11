// One-time: overlap volume of every pair of bodies in the original imported robot (no "tx" features), so check-hardware.mjs can
// tell overlaps that were already in the model from new ones. Writes scripts/original-overlaps.json. Usage: node scripts/original-overlaps.mjs
import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const part = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
part.features = part.features.filter((f) => !String(f.id).startsWith("tx") && f.type !== "deleteBody");
const files = {}; for (const f of part.features) if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file));
const b = buildPart(part, { imports: await loadImports(part, files) }).bodies;
const B = b.map((s) => s.boundingBox.bounds), out = {};
for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
  if (![0, 1, 2].every((q) => B[i][0][q] < B[j][1][q] - 0.05 && B[j][0][q] < B[i][1][q] - 0.05)) continue;
  let v = 0, r = null; try { r = b[i].clone().intersect(b[j].clone()); v = R.measureVolume(r); } catch { v = 0; } finally { try { r?.delete(); } catch {} }
  if (v > 0.5) out[`${i}-${j}`] = Math.round(v * 10) / 10;
}
fs.writeFileSync(new URL("./original-overlaps.json", import.meta.url), JSON.stringify(out));
console.log("pairs", Object.keys(out).length);
