// Fast collision check for ~/cadSlop/test (same rules and output as check-hardware.mjs, a fraction of the time).
//   1. broad phase: sort-and-sweep on bounding boxes
//   2. mid phase:   triangle meshes in plain JS (BVH per body). A pair goes on only if the surfaces really cross (separating-axis
//                   test with a small epsilon, so faces that just touch, like a plate flush on a plate, do not count) or one body
//                   sits inside the other (ray parity)
//   3. exact phase: OpenCascade intersection volume, only for what is left, cached on disk by both bodies' geometry hash, so a
//                   rerun after a small change only measures the pairs whose bodies changed
// Usage: node scripts/check-collisions-fast.mjs [--all] [--no-cache] [--baseline] [--strict]
//   --all       every pair, not just pairs with a part made or moved by the "tx" features
//   --no-cache  ignore and rewrite the exact-volume cache (scripts/.collision-cache.json)
//   --strict    every pair (like --all) and report overlaps that were already in the original robot too
//   --baseline  check the original imported robot only (no "tx" features), every pair, and write every overlap to
//               scripts/original-overlaps.json: the "already there" list the normal run compares against
import fs from "node:fs";
import crypto from "node:crypto";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";

const BASE = process.argv.includes("--baseline"), STRICT = process.argv.includes("--strict"), ALL = BASE || STRICT || process.argv.includes("--all"), NOCACHE = process.argv.includes("--no-cache");
const t0 = Date.now(), lap = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}`);
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const part0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
// build without the trailing deleteBody so robot body numbers stay the original ones; skip the deleted bodies instead
const GONE = new Set(BASE ? [] : part0.features.filter((f) => f.type === "deleteBody").flatMap((f) => [].concat(f.body)));
const part = { ...part0, features: part0.features.filter((f) => f.type !== "deleteBody" && !(BASE && String(f.id).startsWith("tx"))) };
const files = {};
for (const f of part.features) {
  if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file));
  if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part));
}
const built = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const errs = Object.entries(built.errors ?? {}); if (errs.length) console.log("ERRORS", JSON.stringify(errs).slice(0, 500));
lap(`built ${built.bodies.length} bodies`);

const ORIG = BASE ? {} : JSON.parse(fs.readFileSync(new URL("./original-overlaps.json", import.meta.url), "utf8"));
const origVol = (i, j) => ORIG[`${Math.min(i, j)}-${Math.max(i, j)}`] ?? 0;
const byId = new Map(part.features.map((f) => [f.id, f]));
const name = (i) => { const f = byId.get(built.owners[i]); return f && String(f.id).startsWith("tx") ? f.name : `robot #${i}`; };
const moved = new Set(part.features.filter((f) => f.type === "transform" && String(f.id).startsWith("tx")).flatMap((f) => [].concat(f.body)));
const mine = (i) => i >= 623 || moved.has(i);
// what an overlap is compared against: a copied/mirrored body counts as its source part, and a drive-pod part on side B also as its
// mirror twin on side A (so overlaps that come with the vendor parts are not reported as new)
const SRC = new Map();
{ const byOwner = new Map(); built.owners.forEach((o, i) => { if (!byOwner.has(o)) byOwner.set(o, []); byOwner.get(o).push(i); });
  for (const f of part.features) { const list = byOwner.get(f.id); if (!list) continue;
    if ((f.type === "transform" && f.copy) || (f.type === "mirror" && f.merge === false)) { const srcs = [].concat(f.body); list.forEach((i, k) => { if (srcs[k] !== undefined) SRC.set(i, srcs[k]); }); } } }
const src = (i) => { let k = i; for (let g = 0; g < 8 && SRC.has(k); g++) k = SRC.get(k); return k; };
const PODS = JSON.parse(fs.readFileSync(new URL("./drive-groups.json", import.meta.url), "utf8"));
const center = (q) => [0, 1, 2].map((k) => (q[0][k] + q[1][k]) / 2), dims = (q) => [0, 1, 2].map((k) => q[1][k] - q[0][k]);
const podA = PODS["24"].filter((i) => i < built.bodies.length).map((i) => [i, built.bodies[i].boundingBox.bounds]);
const twinA = (i) => { if (i >= built.bodies.length || GONE.has(i)) return null; const q = built.bodies[i].boundingBox.bounds, c = center(q), d = dims(q);
  if (c[1] > 150) return null; const hit = podA.find(([, r]) => { const cr = center(r), dr = dims(r); return Math.abs(cr[0] - c[0]) < 1.6 && Math.abs(301.6 - cr[1] - c[1]) < 1.6 && Math.abs(cr[2] - c[2]) < 1.6 && [0, 1, 2].every((k) => Math.abs(dr[k] - d[k]) < 1.5); });
  return hit ? hit[0] : null; };
const baseline = (i, j) => { let v = origVol(src(i), src(j)); if (src(i) < 623 && src(j) < 623) { const a = twinA(i), b = twinA(j); if (a !== null && b !== null) v = Math.max(v, origVol(a, b)); } return v; };
// intended press fits: wheels / bearings / couplers on their shafts, a coupler or mount on its motor
const press = (a, b) => [[a, b], [b, a]].some(([s, t]) => /shaft|robot #13$/i.test(s) && /wheel|bearing (?!plate)|bearing$|coupler/i.test(t) && !/bearing plate/i.test(t))
  || [[a, b], [b, a]].some(([s, t]) => /coupler|motor mount/i.test(s) && /motor(?! mount)/i.test(t));

// ---- meshes ----
const live = built.bodies.map((_, i) => !GONE.has(i));
const M = built.bodies.map((b, i) => {
  if (!live[i]) return null;
  let m; try { m = b.mesh({ tolerance: 0.05, angularTolerance: 0.3 }); } catch { return null; }
  const V = Float64Array.from(m.vertices), T = Uint32Array.from(m.triangles);
  if (!T.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < V.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], V[k + a]); hi[a] = Math.max(hi[a], V[k + a]); }
  const hash = crypto.createHash("sha1").update(Buffer.from(Float32Array.from(V).buffer)).update(Buffer.from(T.buffer)).digest("hex").slice(0, 16);
  return { V, T, lo, hi, hash, bvh: null };
});
lap(`meshed ${M.filter(Boolean).length} bodies (${M.filter((m, i) => live[i] && !m).length} could not be meshed: those go straight to the exact check)`);

// ---- broad phase: sort-and-sweep along x ----
const EPS = 0.05;
const bbox = (i) => (M[i] ? [M[i].lo, M[i].hi] : built.bodies[i].boundingBox.bounds);
const idx = built.bodies.map((_, i) => i).filter((i) => live[i]).sort((a, b) => bbox(a)[0][0] - bbox(b)[0][0]);
const pairs = [];
for (let p = 0; p < idx.length; p++) {
  const i = idx[p], [ilo, ihi] = bbox(i);
  for (let q = p + 1; q < idx.length; q++) {
    const j = idx[q], [jlo, jhi] = bbox(j);
    if (jlo[0] >= ihi[0] - EPS) break;
    if (!(jlo[1] < ihi[1] - EPS && ilo[1] < jhi[1] - EPS && jlo[2] < ihi[2] - EPS && ilo[2] < jhi[2] - EPS)) continue;
    if (!ALL && !mine(i) && !mine(j)) continue;
    const [a, b] = i < j ? [i, j] : [j, i];
    if (!BASE && press(name(a), name(b))) continue;
    pairs.push([a, b]);
  }
}
lap(`broad phase: ${pairs.length} pairs with overlapping boxes`);

// ---- mid phase: BVH over each body's triangles ----
function buildBVH(m) {
  const { V, T } = m, nt = T.length / 3, tb = new Float64Array(nt * 6), c = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) for (let a = 0; a < 3; a++) {
    const x0 = V[T[t * 3] * 3 + a], x1 = V[T[t * 3 + 1] * 3 + a], x2 = V[T[t * 3 + 2] * 3 + a];
    tb[t * 6 + a] = Math.min(x0, x1, x2); tb[t * 6 + 3 + a] = Math.max(x0, x1, x2); c[t * 3 + a] = (x0 + x1 + x2) / 3;
  }
  const order = Uint32Array.from({ length: nt }, (_, k) => k);
  const make = (s, e) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = s; k < e; k++) { const t = order[k]; for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], tb[t * 6 + a]); hi[a] = Math.max(hi[a], tb[t * 6 + 3 + a]); } }
    const node = { lo, hi, s, e, l: null, r: null };
    if (e - s > 4) {
      const ax = [0, 1, 2].sort((p, q) => (hi[q] - lo[q]) - (hi[p] - lo[p]))[0], mid = (s + e) >> 1;
      order.set(Array.from(order.subarray(s, e)).sort((p, q) => c[p * 3 + ax] - c[q * 3 + ax]), s);
      node.l = make(s, mid); node.r = make(mid, e);
    }
    return node;
  };
  return { root: make(0, nt), order };
}
const bvh = (i) => (M[i].bvh ??= buildBVH(M[i]));
const boxHit = (a, b) => a.lo[0] <= b.hi[0] && b.lo[0] <= a.hi[0] && a.lo[1] <= b.hi[1] && b.lo[1] <= a.hi[1] && a.lo[2] <= b.hi[2] && b.lo[2] <= a.hi[2];
const tri = (m, t) => { const { V, T } = m; return [0, 1, 2].map((k) => [V[T[t * 3 + k] * 3], V[T[t * 3 + k] * 3 + 1], V[T[t * 3 + k] * 3 + 2]]); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// separating-axis test for two triangles: they "cross" only if their projections overlap by more than PEN on every axis, so
// touching (flush faces, coplanar triangles, a shaft tangent to a bore) is not crossing; PEN is above the mesh deflection
const PEN = 0.1;   // above the 0.05 mm mesh deflection, so tessellation noise on touching faces does not count
function trisCross(A, B) {
  const eA = [sub(A[1], A[0]), sub(A[2], A[1]), sub(A[0], A[2])], eB = [sub(B[1], B[0]), sub(B[2], B[1]), sub(B[0], B[2])];
  // each triangle's own normal: it projects to one value there, so the other triangle must pass through that plane by more than
  // PEN on both sides (a flush or coplanar face never does)
  for (const [P, Q, e] of [[A, B, eA], [B, A, eB]]) {
    const nn = crs(e[0], e[1]), L = Math.hypot(nn[0], nn[1], nn[2]); if (L < 1e-12) return false;   // degenerate sliver
    const u = [nn[0] / L, nn[1] / L, nn[2] / L], d0 = dot(P[0], u), q = Q.map((p) => dot(p, u) - d0);
    if (Math.max(...q) <= PEN || Math.min(...q) >= -PEN) return false;
  }
  for (const a of eA) for (const b of eB) {
    const ax = crs(a, b), L = Math.hypot(ax[0], ax[1], ax[2]); if (L < 1e-9) continue;
    const u = [ax[0] / L, ax[1] / L, ax[2] / L];
    const pa = A.map((p) => dot(p, u)), pb = B.map((p) => dot(p, u));
    if (Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= PEN) return false;
  }
  return true;
}
function meshesCross(i, j) {
  const A = bvh(i), B = bvh(j), stack = [[A.root, B.root]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (!boxHit(a, b)) continue;
    if (!a.l && !b.l) {
      for (let p = a.s; p < a.e; p++) { const ta = tri(M[i], A.order[p]); for (let q = b.s; q < b.e; q++) if (trisCross(ta, tri(M[j], B.order[q]))) return true; }
    } else if (!b.l || (a.l && a.e - a.s >= b.e - b.s)) stack.push([a.l, b], [a.r, b]);
    else stack.push([a, b.l], [a, b.r]);
  }
  return false;
}
// ray parity (slightly skewed direction, so the ray does not run along edges): is point p inside body j's closed mesh?
function inside(p, j) {
  const B = bvh(j), d = [1, 0.0123, 0.0071], L = Math.hypot(...d), dir = d.map((v) => v / L), inv = dir.map((v) => 1 / v);
  let hits = 0; const stack = [B.root];
  while (stack.length) {
    const n = stack.pop();
    let tmin = 0, tmax = Infinity;
    for (let a = 0; a < 3; a++) { let t1 = (n.lo[a] - p[a]) * inv[a], t2 = (n.hi[a] - p[a]) * inv[a]; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
    if (tmin > tmax) continue;
    if (n.l) { stack.push(n.l, n.r); continue; }
    for (let k = n.s; k < n.e; k++) {   // Möller-Trumbore
      const [v0, v1, v2] = tri(M[j], B.order[k]), e1 = sub(v1, v0), e2 = sub(v2, v0), h = crs(dir, e2), a = dot(e1, h);
      if (Math.abs(a) < 1e-12) continue;
      const f = 1 / a, s = sub(p, v0), u = f * dot(s, h); if (u < 0 || u > 1) continue;
      const q = crs(s, e1), v = f * dot(dir, q); if (v < 0 || u + v > 1) continue;
      if (f * dot(e2, q) > 1e-9) hits++;
    }
  }
  return hits % 2 === 1;
}
// a point just inside body i: the centre of its biggest triangle, nudged 0.05 mm against the outward normal
const innerPoint = (i) => {
  const m = M[i]; let best = 0, area = -1;
  for (let t = 0; t < m.T.length / 3; t++) { const a = tri(m, t), ar = Math.hypot(...crs(sub(a[1], a[0]), sub(a[2], a[0]))); if (ar > area) { area = ar; best = t; } }
  const a = tri(m, best), n = crs(sub(a[1], a[0]), sub(a[2], a[0])), L = Math.hypot(...n) || 1;
  return [0, 1, 2].map((k) => (a[0][k] + a[1][k] + a[2][k]) / 3 - (n[k] / L) * 0.05);
};

// overlap volume from the meshes (when the exact kernel fails): a 24^3 grid of points over the common box, inside both = overlap
function meshOverlap(i, j) {
  const lo = [0, 1, 2].map((a) => Math.max(M[i].lo[a], M[j].lo[a])), hi = [0, 1, 2].map((a) => Math.min(M[i].hi[a], M[j].hi[a])), N = 24;
  const step = [0, 1, 2].map((a) => (hi[a] - lo[a]) / N); if (step.some((d) => d <= 0)) return 0;
  let inBoth = 0;
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
    const p = [lo[0] + (x + 0.5) * step[0], lo[1] + (y + 0.5) * step[1], lo[2] + (z + 0.5) * step[2]];
    if (inside(p, i) && inside(p, j)) inBoth++;
  }
  return inBoth * step[0] * step[1] * step[2];
}
const exactList = [];
let crossed = 0, contained = 0, noMesh = 0;
for (const [i, j] of pairs) {
  if (!M[i] || !M[j]) { noMesh++; exactList.push([i, j]); continue; }
  if (meshesCross(i, j)) { crossed++; exactList.push([i, j]); continue; }
  if (inside(innerPoint(i), j) || inside(innerPoint(j), i)) { contained++; exactList.push([i, j]); }
}
lap(`mid phase: ${exactList.length} pairs left (${crossed} surfaces cross, ${contained} one inside the other, ${noMesh} without a mesh)`);

// ---- exact phase (cached by geometry) ----
const cacheFile = new URL("./.collision-cache.json", import.meta.url);
const cache = !NOCACHE && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
const key = (i, j) => (M[i] && M[j] ? `${M[i].hash}:${M[j].hash}` : null);
/** Overlap volume (mm³); intersect consumes its inputs, so only the result is freed. -1 if the kernel can't tell. */
function overlap(a, b) {
  for (const [p, q] of [[a, b], [b, a]]) { let r = null; try { r = p.clone().intersect(q.clone()); return R.measureVolume(r); } catch { /* other order */ } finally { try { r?.delete(); } catch { /* freed */ } } }
  return -1;
}
let hitsN = 0, fromCache = 0, unknown = 0;
const baseOut = {};
for (const [i, j] of exactList) {
  const k = key(i, j);
  let v; if (k && k in cache) { v = cache[k]; fromCache++; } else { v = overlap(built.bodies[i], built.bodies[j]); if (k) cache[k] = v; }
  let est = "";
  if (v < 0 && M[i] && M[j]) { v = meshOverlap(i, j); est = "~"; if (k) cache[k] = -1; }   // kernel failed: estimate from the meshes
  if (v < 0) { unknown++; console.log("UNKNOWN (kernel failed, no mesh) |", name(i), "<->", name(j)); continue; }
  if (v <= 1) continue;
  if (BASE) { if (v > 0.5) baseOut[`${i}-${j}`] = Math.round(v * 10) / 10; continue; }
  if (!STRICT && src(i) < 623 && src(j) < 623 && v <= baseline(i, j) + 1) continue;   // already in the original (or its source / twin), not made worse
  hitsN++; console.log("HIT", `${est}${Math.round(v)}`, "mm3 |", name(i), "<->", name(j));
}
fs.writeFileSync(cacheFile, JSON.stringify(cache));
if (BASE) { fs.writeFileSync(new URL("./original-overlaps.json", import.meta.url), JSON.stringify(baseOut)); console.log(`baseline: ${Object.keys(baseOut).length} overlapping pairs in the original robot written to original-overlaps.json`); }
lap(`exact phase: ${exactList.length - fromCache} measured, ${fromCache} from cache`);
console.log(`bodies ${built.bodies.length - GONE.size}, collisions ${hitsN}, unknown ${unknown}`);
