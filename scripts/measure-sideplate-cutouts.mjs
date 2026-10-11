// Plans triangle (truss) cutouts for the robot's side plates (#7 = B, #0 = A) and writes scripts/sideplate-cutouts.json.
// A triangle is kept only if it keeps an 8 mm web to the plate's edge, to every existing hole, and to the footprint of every part
// that touches the plate (measured from the built model). Run after add-transfer-hardware.mjs; then run that again to cut them.
import fs from "node:fs";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const p0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const part = { ...p0, features: p0.features.filter((f) => f.type !== "deleteBody" && !/side plate triangle cutouts/i.test(f.name ?? "")) };
const GONE = new Set(p0.features.filter((f) => f.type === "deleteBody").flatMap((f) => [].concat(f.body)));
const files = {}; for (const f of part.features) { if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file)); if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part)); }
const b = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) }).bodies;
const WEB = 8, GRID = 32, SQ3 = Math.sqrt(3), INSET = WEB / 2;
const out = {};
for (const [pl, faces] of [[7, [-56.8, -53.8]], [0, [355.2, 358.2]]]) {
  const plate = b[pl], pb = plate.boundingBox.bounds;
  // plate outline from a slice: sample the plate's solid on a grid (1 mm) to know where material is
  const holes = []; for (const e of plate.edges) { if (e.geomType !== "CIRCLE") continue; const q = e.boundingBox.bounds; const w = [0,1,2].map((k) => q[1][k] - q[0][k]); if (w[1] > 0.5) continue; holes.push([(q[0][0] + q[1][0]) / 2, (q[0][2] + q[1][2]) / 2, Math.max(w[0], w[2]) / 2]); }
  // footprints of everything touching the plate (within 2 mm of either face), as xz boxes
  const keep = [];
  // only where a part actually sits on the plate: intersect it with a 1 mm slab on each face, keep that footprint's box
  const R = await import("replicad");
  for (const [i, s] of b.entries()) { if (i === pl || GONE.has(i)) continue; const q = s.boundingBox.bounds; if (q[1][1] < faces[0] - 1 || q[0][1] > faces[1] + 1) continue;
    if (q[1][0] < pb[0][0] || q[0][0] > pb[1][0] || q[1][2] < pb[0][2] || q[0][2] > pb[1][2]) continue;
    for (const [y0, y1] of [[faces[0] - 1, faces[0] + 0.05], [faces[1] - 0.05, faces[1] + 1]]) {
      let r = null; try { r = s.clone().intersect(R.makeBox([pb[0][0] - 5, y0, pb[0][2] - 5], [pb[1][0] + 5, y1, pb[1][2] + 5])); const f = r.boundingBox.bounds; if (f[1][0] > f[0][0]) keep.push([f[0][0], f[0][2], f[1][0], f[1][2]]); } catch { if (q[0][1] <= y1 && q[1][1] >= y0) keep.push([q[0][0], q[0][2], q[1][0], q[1][2]]); }   // kernel failed: keep the part's whole box (safe side) finally { try { r?.delete(); } catch {} }
    } }
  // plate edge: the imported plate is a rounded rectangle; stay 12 mm inside its bounding box and its 30 mm corner radius
  const x0 = pb[0][0] + 12, x1 = pb[1][0] - 12, z0 = pb[0][2] + 12, z1 = pb[1][2] - 12, RC = 30;
  const inside = ([x, z]) => { if (x < x0 || x > x1 || z < z0 || z > z1) return false; const cx = Math.min(Math.max(x, pb[0][0] + RC), pb[1][0] - RC), cz = Math.min(Math.max(z, pb[0][2] + RC), pb[1][2] - RC); return Math.hypot(x - cx, z - cz) <= RC - 12 || (x >= pb[0][0] + RC && x <= pb[1][0] - RC) || (z >= pb[0][2] + RC && z <= pb[1][2] - RC); };
  const tris = [];
  for (let row = 0; row < 40; row++) {
    const zb = (pb[0][2] + pb[1][2]) / 2 - 20 * GRID * SQ3 / 2 + row * GRID * SQ3 / 2, zt = zb + GRID * SQ3 / 2;
    for (let k = 0; k < 80; k++) {
      const xl = (pb[0][0] + pb[1][0]) / 2 - 40 * GRID / 2 + k * (GRID / 2) + (row % 2 ? GRID / 2 : 0), up = (k + row) % 2 === 0;
      const T0 = up ? [[xl, zb], [xl + GRID, zb], [xl + GRID / 2, zt]] : [[xl, zt], [xl + GRID, zt], [xl + GRID / 2, zb]];
      const c = [(T0[0][0] + T0[1][0] + T0[2][0]) / 3, (T0[0][1] + T0[1][1] + T0[2][1]) / 3];
      const full = 1 - (INSET * 2 * SQ3) / GRID;                        // shrink about the centroid: webs of 2 x INSET between neighbours
      const dSeg = (p, a, q) => { const L2 = (q[0] - a[0]) ** 2 + (q[1] - a[1]) ** 2; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (q[0] - a[0]) + (p[1] - a[1]) * (q[1] - a[1])) / L2)); return Math.hypot(p[0] - a[0] - t * (q[0] - a[0]), p[1] - a[1] - t * (q[1] - a[1])); };
      // trimmed isogrid (as in Onshape's isogrid/lighten tools): near a keep-out the pocket shrinks about its centroid instead of vanishing
      let T = null, RF = 5;
      for (const f of [1, 0.85, 0.7, 0.58]) {
        const sc = full * f, Tt = T0.map(([x, z]) => [c[0] + (x - c[0]) * sc, c[1] + (z - c[1]) * sc]);
        if (!Tt.every(inside) || !inside(c)) continue;
        const inTri = (p) => { const s2 = (a, q) => (q[0] - a[0]) * (p[1] - a[1]) - (q[1] - a[1]) * (p[0] - a[0]); const d1 = s2(Tt[0], Tt[1]), d2 = s2(Tt[1], Tt[2]), d3 = s2(Tt[2], Tt[0]); return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0); };
        const distTri = (p) => (inTri(p) ? 0 : Math.min(dSeg(p, Tt[0], Tt[1]), dSeg(p, Tt[1], Tt[2]), dSeg(p, Tt[2], Tt[0])));
        if (holes.some(([hx, hz, hr]) => distTri([hx, hz]) < hr + WEB)) continue;
        const rectHit = ([ax, az, cx2, cz2]) => { const R0 = [ax - WEB, az - WEB, cx2 + WEB, cz2 + WEB];
          if (Tt.some(([x, z]) => x > R0[0] && x < R0[2] && z > R0[1] && z < R0[3])) return true;
          if ([[R0[0], R0[1]], [R0[2], R0[1]], [R0[0], R0[3]], [R0[2], R0[3]]].some(inTri)) return true;
          const segX = (a, q) => [[R0[0], R0[1], R0[2], R0[1]], [R0[0], R0[3], R0[2], R0[3]], [R0[0], R0[1], R0[0], R0[3]], [R0[2], R0[1], R0[2], R0[3]]].some(([x3, y3, x4, y4]) => { const d = (q[0] - a[0]) * (y4 - y3) - (q[1] - a[1]) * (x4 - x3); if (!d) return false; const t = ((x3 - a[0]) * (y4 - y3) - (y3 - a[1]) * (x4 - x3)) / d, u = ((x3 - a[0]) * (q[1] - a[1]) - (y3 - a[1]) * (q[0] - a[0])) / d; return t >= 0 && t <= 1 && u >= 0 && u <= 1; });
          return segX(Tt[0], Tt[1]) || segX(Tt[1], Tt[2]) || segX(Tt[2], Tt[0]); };
        if (keep.some(rectHit)) continue;
        T = Tt; RF = Math.max(3, 5 * f); break;
      }
      if (!T) continue;
      // isogrid pocket: the inset triangle with every corner rounded (R = 5 mm, no sharp stress raisers)
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const P = T[k], A = T[(k + 2) % 3], Cn = T[(k + 1) % 3];
        const ua = [(A[0] - P[0]) / Math.hypot(A[0] - P[0], A[1] - P[1]), (A[1] - P[1]) / Math.hypot(A[0] - P[0], A[1] - P[1])];
        const uc = [(Cn[0] - P[0]) / Math.hypot(Cn[0] - P[0], Cn[1] - P[1]), (Cn[1] - P[1]) / Math.hypot(Cn[0] - P[0], Cn[1] - P[1])];
        const bis = [(ua[0] + uc[0]) / Math.hypot(ua[0] + uc[0], ua[1] + uc[1]), (ua[1] + uc[1]) / Math.hypot(ua[0] + uc[0], ua[1] + uc[1])];
        const dC = RF / Math.sin(Math.PI / 6), ctr = [P[0] + bis[0] * dC, P[1] + bis[1] * dC], tl = RF / Math.tan(Math.PI / 6);
        const t1 = [P[0] + ua[0] * tl, P[1] + ua[1] * tl], t2 = [P[0] + uc[0] * tl, P[1] + uc[1] * tl];
        let a1 = Math.atan2(t1[1] - ctr[1], t1[0] - ctr[0]), a2 = Math.atan2(t2[1] - ctr[1], t2[0] - ctr[0]);
        let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        for (let q = 0; q <= 6; q++) { const ang = a1 + (da * q) / 6; pts.push([ctr[0] + RF * Math.cos(ang), ctr[1] + RF * Math.sin(ang)]); }
      }
      tris.push(pts.map((p) => p.map((v) => Math.round(v * 100) / 100)));
    }
  }
  out[pl] = { faces, tris };
  console.log(`side plate #${pl}: ${tris.length} triangle cutouts (${keep.length} parts touching it, ${holes.length} hole edges)`);
}
fs.writeFileSync(new URL("./sideplate-cutouts.json", import.meta.url), JSON.stringify(out));
