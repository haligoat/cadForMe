import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const p0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const part = { ...p0, features: p0.features.filter((f) => f.type !== "deleteBody") };
const files = {}; for (const f of part.features) { if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file)); if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part)); }
const b = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const names = b.bodies.map((_, i) => { const f = part.features.find((g) => g.id === b.owners[i]); return f && String(f.id).startsWith("tx") ? f.name : `robot #${i}`; });
const ORIG = JSON.parse(fs.readFileSync("scripts/original-overlaps.json", "utf8"));
const pairs = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => l.split(" | ")[1].split(" <-> "));
const press = (a, c) => [[a, c], [c, a]].some(([s, t]) => /shaft|robot #13$/i.test(s) && /gecko wheel|bearing [AB] \(goBILDA|coupler/i.test(t));
const real = [];
for (const [a, c] of pairs) {
  if (press(a, c)) continue;
  const i = names.indexOf(a), j = names.indexOf(c); if (i < 0 || j < 0) continue;
  let d = null; try { d = R.measureDistanceBetween(b.bodies[i], b.bodies[j]); } catch {}
  if (d !== null && d >= 0.01) continue;
  let v = null; try { v = R.measureVolume(b.bodies[i].clone().intersect(b.bodies[j].clone())); } catch {}
  const o = /^robot/.test(a) && /^robot/.test(c) ? (ORIG[`${Math.min(i, j)}-${Math.max(i, j)}`] ?? 0) : 0;
  if (v === null || v > o + 1) real.push(`${a} <-> ${c}: distance ${d === null ? "?" : d.toFixed(2)}, overlap ${v === null ? "?" : v.toFixed(1)}${o ? ` (original ${o})` : ""}`);
}
console.log(`checked ${pairs.length}, real/unknown ${real.length}`); for (const r of real) console.log("  " + r);
