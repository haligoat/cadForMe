// Fastener check for ~/cadSlop/test: every M4 screw (scripts/screws.json, written by add-transfer-hardware.mjs) is a real screw + nut.
// For each one: the shank (Ø3.9) must pass through clear holes in everything it clamps, the head (Ø7.6 x 3) must have room on the
// head side, and the nut (Ø8.2 x 3.5) on the nut side, unless it sits in a captive nut pocket. Usage: node scripts/check-fasteners.mjs
import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const part0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const GONE = new Set(part0.features.filter((f) => f.type === "deleteBody").flatMap((f) => [].concat(f.body)));
const part = { ...part0, features: part0.features.filter((f) => f.type !== "deleteBody") };
const files = {};
for (const f of part.features) {
  if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file));
  if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part));
}
const built = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const byId = new Map(part.features.map((f) => [f.id, f]));
const name = (i) => { const f = byId.get(built.owners[i]); return f && String(f.id).startsWith("tx") ? f.name : `robot #${i}`; };
const live = built.bodies.map((_, i) => i).filter((i) => !GONE.has(i));
const B = built.bodies.map((b) => b.boundingBox.bounds);
const screws = JSON.parse(fs.readFileSync(new URL("./screws.json", import.meta.url), "utf8"));

// a cylinder along the screw's axis from t0 to t1: what it runs into (mm³ each)
function hits(sc, t0, t1, d) {
  const k = "xyz".indexOf(sc.axis ?? "y"), lo = Math.min(t0, t1), hi = Math.max(t0, t1); if (hi - lo < 0.05) return [];
  const c0 = [sc.x ?? 0, sc.y ?? 0, sc.z ?? 0]; c0[k] = lo; const dir = [0, 0, 0]; dir[k] = 1;
  const box = [0, 1, 2].map((a) => (a === k ? [lo, hi] : [c0[a] - d / 2, c0[a] + d / 2])), out = [];
  for (const i of live) { const q = B[i]; if (![0, 1, 2].every((a) => q[0][a] < box[a][1] && box[a][0] < q[1][a])) continue;
    if (/proof of fit/.test(name(i))) continue;
    const c = R.makeCylinder(d / 2, hi - lo, c0, dir); let v = 0, r = null;
    try { r = built.bodies[i].clone().intersect(c); v = R.measureVolume(r); } catch { v = -1; } finally { try { r?.delete(); } catch { /* freed */ } }
    if (v > 0.3 || v < 0) out.push(`${name(i).slice(0, 48)} (${v < 0 ? "?" : v.toFixed(1)} mm3)`); }
  return out;
}
let bad = 0;
for (const s of screws) {
  const shank = hits(s, s.face + s.dir * 0.05, s.nutAt - s.dir * 0.05, 3.9);
  const head = hits(s, s.face - s.dir * 0.1, s.face - s.dir * 3.1, 7.6);
  const nut = s.captive ? [] : hits(s, s.nutAt + s.dir * 0.1, s.nutAt + s.dir * 3.6, 8.2);
  const problems = [shank.length && `shank blocked by ${shank.join(", ")}`, head.length && `no room for the head: ${head.join(", ")}`, nut.length && `no room for the nut: ${nut.join(", ")}`].filter(Boolean);
  if (problems.length) { bad++; console.log(`BAD ${s.name} at ${s.axis ?? "y"}-axis ${[s.x, s.y, s.z].filter((v) => v !== undefined).join(", ")}: ${problems.join(" | ")}`); }
}
console.log(`screws ${screws.length}, ok ${screws.length - bad}, problems ${bad}`);
