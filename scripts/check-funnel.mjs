// Funnel check: what each funnel side intersects, and whether it touches the side plate and the new transfer plate.
import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const p0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const GONE = new Set(p0.features.filter((f) => f.type === "deleteBody").flatMap((f) => [].concat(f.body)));
const part = { ...p0, features: p0.features.filter((f) => f.type !== "deleteBody") };
const files = {}; for (const f of part.features) { if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file)); if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part)); }
const b = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const nm = (i) => { const f = part.features.find((g) => g.id === b.owners[i]); return f && String(f.id).startsWith("tx") ? f.name : `robot #${i}`; };
const B = b.bodies.map((s) => s.boundingBox.bounds), near = (a, c) => [0, 1, 2].every((q) => a[0][q] <= c[1][q] + 0.05 && c[0][q] <= a[1][q] + 0.05);
for (const side of ["A", "B"]) {
  const i = b.bodies.findIndex((_, k) => nm(k).startsWith(`Funnel side ${side}`));
  const hits = [], touch = [];
  b.bodies.forEach((s, j) => { if (j === i || GONE.has(j) || !near(B[i], B[j])) return;
    let d = 1; try { d = R.measureDistanceBetween(b.bodies[i], s); } catch { d = 0; }
    if (d >= 0.05) return; let v = 0; try { v = R.measureVolume(b.bodies[i].clone().intersect(s.clone())); } catch { v = -1; }
    (v > 0.5 ? hits : touch).push(`${nm(j)}${v > 0.5 ? ` (${v.toFixed(0)} mm3)` : ""}`); });
  console.log(`FUNNEL ${side}: volume ${R.measureVolume(b.bodies[i]).toFixed(0)} mm3`);
  console.log(`FUNNEL ${side}: intersects ${hits.length}: ${hits.join(" | ") || "-"}`);
  console.log(`FUNNEL ${side}: touches: ${touch.join(" | ") || "-"}`);
}
