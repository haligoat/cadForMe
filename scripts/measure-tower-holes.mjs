// Writes scripts/tower-holes.json: every M4 hole on the moved tower channels' plate faces that has no plate hole exactly under it
import fs from "node:fs";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const p0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const part = { ...p0, features: p0.features.filter((f) => f.type !== "deleteBody" && !/New M4 hole in side plate for the moved tower/.test(f.name ?? "")) };
const files = {}; for (const f of part.features) { if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file)); if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part)); }
const b = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) }).bodies;
const holes = (i, yFace) => { const m = new Map(); for (const e of b[i].edges) { if (e.geomType !== "CIRCLE") continue; const bb = e.boundingBox.bounds; const w = [0,1,2].map((k) => bb[1][k] - bb[0][k]); if (w[1] > 0.3) continue; const c = [0,1,2].map((k) => (bb[0][k] + bb[1][k]) / 2); const d = Math.max(w[0], w[2]); if (d < 3.6 || d > 4.6) continue; if (yFace !== undefined && Math.abs(c[1] - yFace) > 1.5) continue; m.set(`${c[0].toFixed(2)},${c[2].toFixed(2)}`, [+c[0].toFixed(2), +c[2].toFixed(2)]); } return [...m.values()]; };
const out = {};
for (const [ch, pl, side] of [[10, 7, "B"], [2, 0, "A"]]) {
  const bb = b[ch].boundingBox.bounds, face = side === "B" ? bb[0][1] : bb[1][1];
  const ph = holes(pl), hs = holes(ch, face);
  // the tower's bolt holes: its face holes on the side plate's 8 mm grid rows that the original design used (z ≈ -56, -8, 88)
  const bolt = hs.filter(([x, z]) => [-56, -8, 88].some((r) => Math.abs(z - r) < 1.5));
  const exact = bolt.filter(([x, z]) => ph.some(([px, pz]) => Math.hypot(px - x, pz - z) < 0.05));
  const need = bolt.filter(([x, z]) => !ph.some(([px, pz]) => Math.hypot(px - x, pz - z) < 0.05) && !ph.some(([px, pz]) => Math.hypot(px - x, pz - z) < 4.5));
  out[pl] = need;
  console.log(`TOWER ${ch}: bolt holes ${bolt.length}, already on a plate hole ${exact.length}, new holes (clear of old ones) ${need.length}:`, JSON.stringify(need));
}
fs.writeFileSync(new URL("./tower-holes.json", import.meta.url), JSON.stringify(out));
