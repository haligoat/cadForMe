// Hole alignment audit for ~/cadSlop/test: for each part bolted to a side plate, how far each of its holes is from the nearest hole
// in that plate (in the final model), plus the gap between their faces. Usage: node scripts/check-alignment.mjs
import fs from "node:fs";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const p0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const part = { ...p0, features: p0.features.filter((f) => f.type !== "deleteBody") };
const files = {}; for (const f of part.features) { if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file)); if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part)); }
const b = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) }).bodies;
const holes = (i, yFace) => { const m = new Map(); for (const e of b[i].edges) { if (e.geomType !== "CIRCLE") continue; const bb = e.boundingBox.bounds; const w = [0,1,2].map((k) => bb[1][k] - bb[0][k]); if (w[1] > 0.3) continue; const c = [0,1,2].map((k) => (bb[0][k] + bb[1][k]) / 2); const d = Math.max(w[0], w[2]); if (d < 3 || d > 16) continue; if (yFace !== undefined && Math.abs(c[1] - yFace) > 1.5) continue; m.set(`${c[0].toFixed(2)},${c[2].toFixed(2)},${d.toFixed(1)}`, [c[0], c[2], d]); } return [...m.values()]; };
const PLATES = { B: { body: 7, inner: -53.8 }, A: { body: 0, inner: 355.2 } };
const parts = [["drive channel #11", 11, "B"], ["drive channel #24", 24, "A"], ["drive pod B spacer #272", 272, "B"], ["drive pod B spacer #346", 346, "B"], ["drive pod A spacer #34", 34, "A"], ["drive pod A spacer #497", 497, "A"], ["intake bearing block #21", 21, "B"], ["intake bearing block #5", 5, "A"], ["tower channel #10", 10, "B"], ["tower channel #2", 2, "A"]];
for (const [nm, i, side] of parts) {
  const P = PLATES[side], ph = holes(P.body), bb = b[i].boundingBox.bounds;
  const face = side === "B" ? bb[0][1] : bb[1][1], gap = side === "B" ? face - P.inner : P.inner - face;
  const hs = holes(i, face);
  const offs = hs.map(([x, z, d]) => { let best = null; for (const [px, pz, pd] of ph) { if (Math.abs(pd - d) > 1.2 && !(pd >= 4 && d >= 3.5)) continue; const dd = Math.hypot(px - x, pz - z); if (!best || dd < best) best = dd; } return best; }).filter((v) => v !== null && v < 3);
  const worst = offs.length ? Math.max(...offs) : null;
  console.log(`${nm.padEnd(26)} face gap ${gap.toFixed(2)} mm | holes matched ${offs.length}/${hs.length} | worst hole offset ${worst === null ? "-" : worst.toFixed(2) + " mm"}`);
}
const sh = b[13].boundingBox.bounds, sc = [(sh[0][0] + sh[1][0]) / 2, (sh[0][2] + sh[1][2]) / 2];
const bh = (pl) => holes(pl).filter((h) => h[2] > 14 && h[2] < 15).map(([x, z]) => Math.hypot(x - sc[0], z - sc[1])).sort((a, c) => a - c)[0];
console.log(`intake shaft vs bearing holes: side B ${bh(7)?.toFixed(2)} mm, side A ${bh(0)?.toFixed(2)} mm off centre`);
