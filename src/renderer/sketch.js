// Sketch editor (Onshape style): geometry tools, snapping & inference, constraints, smart dimensions,
// dragging with live solving. Works in the sketch plane's local 2D coordinates.
import { makeEvaluator } from "../kernel/expr.js";
import { sketchFrame, planeFrames } from "../kernel/vec.js";
import { solveSketch, solverReady, regionsOf, inRegion } from "../kernel/sketch2.js";
import { trim, fillet, mirror, offset, ids as sketchIds } from "../kernel/sketchops.js";
import { parseDXF, dxfToGeom, sketchToDXF } from "../kernel/dxf.js";
import { S, edit, feature, emit, effVars } from "./state.js";
import { toast, h } from "./ui.js";
import { promptText } from "./dialogs.js";

export const SK = {
  rectVar: "rect", arcVar: "arc3", showCons: true,
  tool: "line", sel: new Set(), hover: null, draft: null, construction: false, live: null, result: null,
  info: "", sides: 6, pending: null, dragging: false, snap: null, cursor: null, dimEdit: null, cacheKey: "",
};
let VP = null;
const RAD = Math.PI / 180;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const sk = () => (S.sketchEdit ? feature(S.sketchEdit) : null);
const evaluator = () => makeEvaluator(effVars());
const geomOf = () => SK.live ?? sk()?.geom ?? [];
const gmap = (g) => new Map(g.map((x) => [x.id, x]));
const pos = (G, id) => { const p = G.get(id); return p ? [p.x, p.y] : null; };
export const activeSketch = sk;

// ---------- sketch mutation helpers (operate on a cloned sketch object) ----------
function nid(s, prefix) {
  const used = new Set([...s.geom, ...s.cons].map((x) => x.id));
  let n = 1; while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
function addGeom(s, g) { const prefix = { point: "p", line: "l", circle: "c", arc: "a", ellipse: "e" }[g.t]; const id = nid(s, prefix); s.geom.push({ id, ...g }); return id; }
const addPoint = (s, x, y) => addGeom(s, { t: "point", x: r4(x), y: r4(y) });
function addCons(s, c) { const id = nid(s, c.t === "dim" ? "d" : "k"); s.cons.push({ id, ...c }); return id; }
function ensureOrigin(s) {
  if (!s.geom.some((g) => g.id === "o")) { s.geom.unshift({ id: "o", t: "point", x: 0, y: 0 }); s.cons.push({ id: nid(s, "k"), t: "fix", a: "o" }); }
  return "o";
}
/** Turn a snap result into a point id, creating the point (and any curve constraint) if needed. */
function pointFor(s, P) {
  if (P.id) return P.id;
  if (P.origin) return ensureOrigin(s);
  const id = addPoint(s, P.p[0], P.p[1]);
  if (P.curve) addCons(s, { t: "on", a: id, b: P.curve });
  return id;
}
function mergePoints(s, keep, drop) {
  const swap = (v) => (v === drop ? keep : v);
  for (const g of s.geom) for (const k of ["a", "b", "c", "s", "e", "f"]) if (g[k] === drop) g[k] = keep;
  for (const c of s.cons) { c.a = swap(c.a); if (c.b) c.b = swap(c.b); }
  s.geom = s.geom.filter((g) => g.id !== drop && !(g.t === "line" && g.a === g.b));
  const alive = new Set(s.geom.map((g) => g.id));
  s.cons = s.cons.filter((c) => alive.has(c.a) && (!c.b || alive.has(c.b)) && !(c.t === "coincident" && c.a === c.b));
}
function removeIds(s, ids) {
  const dead = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of s.geom) {
      if (dead.has(g.id)) continue;
      if (["a", "b", "c", "s", "e", "f"].some((k) => g[k] && dead.has(g[k]) && g.t !== "point")) { dead.add(g.id); changed = true; }
    }
  }
  s.geom = s.geom.filter((g) => !dead.has(g.id));
  s.cons = s.cons.filter((c) => !dead.has(c.id) && !dead.has(c.a) && !(c.b && dead.has(c.b)) && !(c.l && dead.has(c.l)));
}

/** Apply a change to the sketch, solve it, and commit as one undo step. Returns false (and tells the user) if it can't. */
function apply(fn, { allowConflict = false } = {}) {
  const base = sk(); if (!base) return false;
  if (!solverReady()) { toast("The sketch solver is still loading. Try again in a moment", "err"); return false; }
  const s = { geom: structuredClone(base.geom ?? []), cons: structuredClone(base.cons ?? []) };
  try { fn(s); } catch (e) { toast(e.message, "err"); return false; }
  let res;
  try { res = solveSketch(s, evaluator()); } catch (e) { toast(`Couldn't solve the sketch: ${e.message}`, "err"); return false; }
  if (!allowConflict && (!res.ok || res.conflicting.length)) { toast("That would over-constrain the sketch, so it wasn't applied", "err"); return false; }
  s.geom = res.geom;
  edit((p) => { const t = p.features.find((f) => f.id === S.sketchEdit); t.geom = s.geom; t.cons = s.cons; });
  SK.live = null;
  return true;
}

// ---------- snapping & picking ----------
function ellipsePts(G, g, n = 72) {
  const c = pos(G, g.c), f = pos(G, g.f), d = dist(c, f), b = g.r, a = Math.sqrt(b * b + d * d), rot = Math.atan2(f[1] - c[1], f[0] - c[0]);
  return Array.from({ length: n + 1 }, (_, i) => { const t = (i / n) * 2 * Math.PI, ex = a * Math.cos(t), ey = b * Math.sin(t); return [c[0] + ex * Math.cos(rot) - ey * Math.sin(rot), c[1] + ex * Math.sin(rot) + ey * Math.cos(rot)]; });
}
function nearestOnCurve(g, G, raw) {
  if (g.t === "ellipse") { let best = { d: Infinity, p: raw }; for (const p of ellipsePts(G, g, 144)) { const d = dist(raw, p); if (d < best.d) best = { d, p }; } return best; }
  if (g.t === "line") {
    const a = pos(G, g.a), b = pos(G, g.b), dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((raw[0] - a[0]) * dx + (raw[1] - a[1]) * dy) / l2)) : 0;
    const p = [a[0] + dx * t, a[1] + dy * t];
    return { d: dist(raw, p), p };
  }
  const c = pos(G, g.c);
  const r = g.t === "circle" ? g.r : dist(c, pos(G, g.s));
  const ang = Math.atan2(raw[1] - c[1], raw[0] - c[0]);
  if (g.t === "arc") {
    const a0 = Math.atan2(pos(G, g.s)[1] - c[1], pos(G, g.s)[0] - c[0]);
    let a1 = Math.atan2(pos(G, g.e)[1] - c[1], pos(G, g.e)[0] - c[0]); if (a1 <= a0) a1 += 2 * Math.PI;
    let rel = ang - a0; while (rel < 0) rel += 2 * Math.PI; while (rel >= 2 * Math.PI) rel -= 2 * Math.PI;
    if (rel > a1 - a0) {
      const ends = [pos(G, g.s), pos(G, g.e)].map((p) => ({ d: dist(raw, p), p }));
      return ends[0].d < ends[1].d ? ends[0] : ends[1];
    }
  }
  const p = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
  return { d: dist(raw, p), p };
}

function pickGeom(raw, { points = true, curves = true } = {}) {
  const geom = geomOf(), G = gmap(geom), px = VP.pixelSize();
  let best = null;
  if (points) for (const g of geom) if (g.t === "point") { const d = dist(raw, [g.x, g.y]); if (d < 9 * px && (!best || d < best.d)) best = { id: g.id, d, p: [g.x, g.y], kind: "point" }; }
  if (best) return best;
  if (curves) for (const g of geom) if (g.t !== "point") { const n = nearestOnCurve(g, G, raw); if (n.d < 7 * px && (!best || n.d < best.d)) best = { id: g.id, d: n.d, p: n.p, kind: "curve" }; }
  return best;
}

/** Snap target for drawing: existing point > curve > origin > grid. */
function snap(pt) {
  const hit = pickGeom(pt.raw, { points: true, curves: true });
  if (hit?.kind === "point") return { id: hit.id, p: hit.p, kind: "point" };
  if (dist(pt.raw, [0, 0]) < 9 * VP.pixelSize()) return { origin: true, p: [0, 0], kind: "point" };
  if (hit?.kind === "curve") return { curve: hit.id, p: hit.p, kind: "curve" };
  return { p: pt.p, kind: "free" };
}
const at = (P, G) => (P.id ? pos(G, P.id) : P.p);

/** Horizontal / vertical inference for a new line (within ~3 degrees). */
function inferHV(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < 1e-6) return { p: b, c: null };
  const ang = Math.abs(Math.atan2(dy, dx) / RAD) % 180;
  if (ang < 3 || ang > 177) return { p: [b[0], a[1]], c: "horizontal" };
  if (Math.abs(ang - 90) < 3) return { p: [a[0], b[1]], c: "vertical" };
  return { p: b, c: null };
}

// ---------- tools ----------
const TOOLS = ["select", "line", "rect", "crect", "circle", "arc3", "arcc", "ellipse", "polygon", "slot", "point", "dim", "trim", "sfillet", "mirror"];
export function setTool(t) { SK.tool = t; SK.draft = null; SK.dimEdit = null; SK.snap = null; if (t !== "select") SK.sel = new Set(); emit(); }
const cons = () => (SK.construction ? { construction: true } : {});

function creating(P1, P2, P3, e) {
  const G = gmap(geomOf());
  switch (SK.tool) {
    case "rect": case "crect": {
      const a = at(P1, G), b = at(P2, G);
      if (Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6) return false;
      return apply((s) => {
        let c, x1, y1, x2, y2;
        if (SK.tool === "crect") { c = pointFor(s, P1); x1 = a[0] - (b[0] - a[0]); y1 = a[1] - (b[1] - a[1]); x2 = b[0]; y2 = b[1]; } else { x1 = a[0]; y1 = a[1]; x2 = b[0]; y2 = b[1]; }
        const p1 = SK.tool === "crect" ? addPoint(s, x1, y1) : pointFor(s, P1);
        const p2 = addPoint(s, x2, y1), p3 = SK.tool === "crect" ? addPoint(s, x2, y2) : pointFor(s, { ...P2, p: [x2, y2] }), p4 = addPoint(s, x1, y2);
        const l1 = addGeom(s, { t: "line", a: p1, b: p2, ...cons() }), l2 = addGeom(s, { t: "line", a: p2, b: p3, ...cons() });
        const l3 = addGeom(s, { t: "line", a: p3, b: p4, ...cons() }), l4 = addGeom(s, { t: "line", a: p4, b: p1, ...cons() });
        addCons(s, { t: "horizontal", a: l1 }); addCons(s, { t: "vertical", a: l2 }); addCons(s, { t: "horizontal", a: l3 }); addCons(s, { t: "vertical", a: l4 });
        if (SK.tool === "crect") { const dg = addGeom(s, { t: "line", a: p1, b: p3, construction: true }); addCons(s, { t: "midpoint", a: c, b: dg }); }
      });
    }
    case "circle": {
      const c = at(P1, G), r = dist(c, P2.p);
      if (r < 1e-6) return false;
      return apply((s) => { const cp = pointFor(s, P1); addGeom(s, { t: "circle", c: cp, r: r4(r), ...cons() }); });
    }
    case "arc3": {
      const A = at(P1, G), B = at(P2, G), C = P3.p;
      const d = 2 * (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1]));
      if (Math.abs(d) < 1e-9) { toast("Those three points are in a line", "err"); return false; }
      const ux = ((A[0] ** 2 + A[1] ** 2) * (B[1] - C[1]) + (B[0] ** 2 + B[1] ** 2) * (C[1] - A[1]) + (C[0] ** 2 + C[1] ** 2) * (A[1] - B[1])) / d;
      const uy = ((A[0] ** 2 + A[1] ** 2) * (C[0] - B[0]) + (B[0] ** 2 + B[1] ** 2) * (A[0] - C[0]) + (C[0] ** 2 + C[1] ** 2) * (B[0] - A[0])) / d;
      const ang = (p) => Math.atan2(p[1] - uy, p[0] - ux), TWO = 2 * Math.PI, norm = (x) => ((x % TWO) + TWO) % TWO;
      const ccw = norm(ang(C) - ang(A)) <= norm(ang(B) - ang(A));
      return apply((s) => {
        const cp = addPoint(s, ux, uy);
        const sp = pointFor(s, ccw ? P1 : P2), ep = pointFor(s, ccw ? P2 : P1);
        addGeom(s, { t: "arc", c: cp, s: sp, e: ep, ...cons() });
      });
    }
    case "tarc": {
      // arc leaving the end of a line (or arc) tangentially and ending at the clicked point
      const startId = P1.id; if (!startId) { toast("Start a tangent arc on the end of a line or arc", "err"); return false; }
      const geomNow = geomOf(), Gm = gmap(geomNow);
      const host = geomNow.find((g) => (g.t === "line" && (g.a === startId || g.b === startId)) || (g.t === "arc" && (g.s === startId || g.e === startId)));
      if (!host) { toast("Start a tangent arc on the end of a line or arc", "err"); return false; }
      const S0 = pos(Gm, startId), E = P2.p;
      let tdir;
      if (host.t === "line") { const o = pos(Gm, host.a === startId ? host.b : host.a); tdir = [S0[0] - o[0], S0[1] - o[1]]; }
      else { const c = pos(Gm, host.c), rv = [S0[0] - c[0], S0[1] - c[1]]; tdir = host.e === startId ? [-rv[1], rv[0]] : [rv[1], -rv[0]]; } // continue the arc's travel direction
      const tl = Math.hypot(...tdir); tdir = [tdir[0] / tl, tdir[1] / tl];
      const n = [-tdir[1], tdir[0]], d = [S0[0] - E[0], S0[1] - E[1]], den = 2 * (n[0] * d[0] + n[1] * d[1]);
      if (Math.abs(den) < 1e-9) { toast("That end point is straight ahead; draw a line instead", "err"); return false; }
      const r = -(d[0] * d[0] + d[1] * d[1]) / den, C = [S0[0] + n[0] * r, S0[1] + n[1] * r];
      const ccw = r > 0; // centre to the left of travel => counter-clockwise
      return apply((s) => {
        const cp = addPoint(s, C[0], C[1]), ep = pointFor(s, P2);
        const arc = addGeom(s, ccw ? { t: "arc", c: cp, s: startId, e: ep, ...cons() } : { t: "arc", c: cp, s: ep, e: startId, ...cons() });
        addCons(s, { t: "tangent", a: host.id, b: arc });
      });
    }
    case "arcc": {
      const c = at(P1, G), st = at(P2, G), r = dist(c, st);
      if (r < 1e-6 || dist(c, P3.p) < 1e-6) return false;
      const k = r / dist(c, P3.p), en = [c[0] + (P3.p[0] - c[0]) * k, c[1] + (P3.p[1] - c[1]) * k];
      return apply((s) => { const cp = pointFor(s, P1); const sp = pointFor(s, P2); const ep = addPoint(s, en[0], en[1]); addGeom(s, { t: "arc", c: cp, s: sp, e: ep, ...cons() }); });
    }
    case "ellipse": {
      const c = at(P1, G), A = at(P2, G), a = dist(c, A);
      if (a < 1e-6) return false;
      const dir = [(A[0] - c[0]) / a, (A[1] - c[1]) / a];
      const b = Math.min(Math.abs((P3.p[0] - c[0]) * dir[1] - (P3.p[1] - c[1]) * dir[0]), a * 0.999);
      if (b < 1e-6) return false;
      const dd = Math.sqrt(a * a - b * b);
      return apply((s) => { const cp = pointFor(s, P1), fp = addPoint(s, c[0] + dir[0] * dd, c[1] + dir[1] * dd); addGeom(s, { t: "ellipse", c: cp, f: fp, r: r4(b), ...cons() }); });
    }
    case "polygon": {
      const c = at(P1, G), r = dist(c, P2.p), n = SK.sides;
      if (r < 1e-6) return false;
      const a0 = Math.atan2(P2.p[1] - c[1], P2.p[0] - c[0]);
      return apply((s) => {
        const cp = pointFor(s, P1), cc = addGeom(s, { t: "circle", c: cp, r: r4(r), construction: true });
        const pts = Array.from({ length: n }, (_, i) => addPoint(s, c[0] + r * Math.cos(a0 + (2 * Math.PI * i) / n), c[1] + r * Math.sin(a0 + (2 * Math.PI * i) / n)));
        pts.forEach((p) => addCons(s, { t: "on", a: p, b: cc }));
        const lines = pts.map((p, i) => addGeom(s, { t: "line", a: p, b: pts[(i + 1) % n], ...cons() }));
        lines.slice(1).forEach((l) => addCons(s, { t: "equal", a: lines[0], b: l }));
      });
    }
    case "slot": {
      const A = at(P1, G), B = at(P2, G), len = dist(A, B);
      if (len < 1e-6) return false;
      const d = [(B[0] - A[0]) / len, (B[1] - A[1]) / len], nrm = [-d[1], d[0]];
      const w = Math.abs((P3.p[0] - A[0]) * nrm[0] + (P3.p[1] - A[1]) * nrm[1]);
      if (w < 1e-6) return false;
      const R = w;
      return apply((s) => {
        const ca = pointFor(s, P1), cb = pointFor(s, P2);
        const mk = (c, k) => addPoint(s, c[0] + nrm[0] * R * k, c[1] + nrm[1] * R * k);
        const aTop = mk(A, 1), aBot = mk(A, -1), bTop = mk(B, 1), bBot = mk(B, -1);
        const arcB = addGeom(s, { t: "arc", c: cb, s: bBot, e: bTop, ...cons() }), arcA = addGeom(s, { t: "arc", c: ca, s: aTop, e: aBot, ...cons() });
        const top = addGeom(s, { t: "line", a: bTop, b: aTop, ...cons() }), bot = addGeom(s, { t: "line", a: aBot, b: bBot, ...cons() });
        addCons(s, { t: "tangent", a: top, b: arcA }); addCons(s, { t: "tangent", a: top, b: arcB });
        addCons(s, { t: "tangent", a: bot, b: arcA }); addCons(s, { t: "tangent", a: bot, b: arcB });
        addCons(s, { t: "equal", a: arcA, b: arcB });
      });
    }
    default: return false;
  }
}

const STEPS = { rect: 2, crect: 2, circle: 2, arc3: 3, arcc: 3, tarc: 2, ellipse: 3, polygon: 2, slot: 3 };

/** Operations that act on existing geometry. */
function curveHit(pt) { return pickGeom(pt.raw, { points: false, curves: true }); }
async function doFillet(pid) {
  const text = await promptText("Round this corner", "Radius (mm or an expression)", String(SK.filletR ?? 3), "Round");
  if (!text) return;
  let r; try { r = evaluator()(/^-?(\d+\.?\d*|\.\d+)$/.test(text.trim()) ? Number(text) : text.trim()); } catch (e) { toast(e.message, "err"); return; }
  SK.filletR = r;
  apply((s) => { fillet(s, pid, r); if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text.trim())) { const d = s.cons.findLast((c) => c.t === "dim" && c.k === "radius"); if (d) d.v = text.trim(); } });
  redraw();
}
export function mirrorSelection() {
  const { ids, G } = selectionInfo();
  const geomIds = ids.filter((i) => G.get(i).t !== "point");
  if (!geomIds.length) { toast("Select the shapes to mirror, then press Mirror and click the mirror line", "err"); return; }
  SK.mirrorIds = geomIds; setTool("mirror"); toast("Now click the line to mirror across");
}
export async function offsetSelection() {
  const { ids, G } = selectionInfo();
  const geomIds = ids.filter((i) => ["line", "arc", "circle"].includes(G.get(i).t));
  if (!geomIds.length) { toast("Select a closed loop (or circles), then press Offset", "err"); return; }
  const text = await promptText("Offset", "Distance in mm (positive = outward, negative = inward)", String(SK.offsetD ?? 2), "Offset");
  if (!text) return;
  let d; try { d = evaluator()(/^-?(\d+\.?\d*|\.\d+)$/.test(text.trim()) ? Number(text) : text.trim()); } catch (e) { toast(e.message, "err"); return; }
  SK.offsetD = d; apply((s) => offset(s, geomIds, d)); redraw();
}

function click(pt, e) {
  if (SK.tool === "trim") { const h2 = curveHit(pt); if (h2) apply((s) => trim(s, h2.id, pt.raw), { allowConflict: true }); return; }
  if (SK.tool === "sfillet") { const h2 = pickGeom(pt.raw, { points: true, curves: false }); if (h2) doFillet(h2.id); return; }
  if (SK.tool === "mirror") { const h2 = curveHit(pt); if (h2 && SK.mirrorIds) { const ids2 = SK.mirrorIds; if (apply((s) => mirror(s, ids2, h2.id))) { SK.mirrorIds = null; setTool("select"); } } return; }
  const P = snap(pt), G = gmap(geomOf());
  if (SK.tool === "point") { apply((s) => { pointFor(s, P); }); return; }
  if (SK.tool === "line") {
    const d = (SK.draft ??= { pts: [] });
    if (!d.last) { d.last = P; return; }
    let end = P, hv = null;
    if (P.kind === "free" && !e.altKey) { const inf = inferHV(at(d.last, G), P.p); if (inf.c) { end = { ...P, p: inf.p }; hv = inf.c; } }
    let aId, bId;
    const ok = apply((s) => {
      aId = pointFor(s, d.last); bId = pointFor(s, end);
      if (aId === bId) throw new Error("A line needs two different points");
      const id = addGeom(s, { t: "line", a: aId, b: bId, ...cons() });
      if (hv) addCons(s, { t: hv, a: id });
    });
    if (!ok) return;
    d.firstId ??= aId;
    if (bId === d.firstId) SK.draft = null; else d.last = { id: bId, p: end.p, kind: "point" };
    return;
  }
  const steps = STEPS[SK.tool];
  if (steps) {
    const d = (SK.draft ??= { pts: [] });
    d.pts.push(P);
    if (d.pts.length === steps) { creating(d.pts[0], d.pts[1], d.pts[2], e); SK.draft = null; }
    return;
  }
}

// ---------- selection, constraints ----------
const typeOf = (G, id) => G.get(id)?.t;
export function selectionInfo() {
  const G = gmap(geomOf());
  const ids = [...SK.sel].filter((i) => G.has(i));
  return { G, ids, pts: ids.filter((i) => typeOf(G, i) === "point"), lines: ids.filter((i) => typeOf(G, i) === "line"), curves: ids.filter((i) => ["circle", "arc"].includes(typeOf(G, i))) };
}

export function applyConstraint(kind) {
  const { G, ids, pts, lines, curves } = selectionInfo();
  const fail = (m) => toast(m, "err");
  if (!ids.length) { fail("Select the shapes first, then pick a constraint"); return; }
  const mk = (list) => apply((s) => list.forEach((c) => addCons(s, c)));
  switch (kind) {
    case "horizontal": case "vertical":
      if (lines.length) mk(lines.map((l) => ({ t: kind, a: l })));
      else if (pts.length === 2) mk([{ t: kind, a: pts[0], b: pts[1] }]);
      else fail(`${kind === "horizontal" ? "Horizontal" : "Vertical"} needs lines, or two points`);
      break;
    case "parallel": case "perpendicular":
      if (lines.length === 2) mk([{ t: kind, a: lines[0], b: lines[1] }]); else fail("Select exactly two lines");
      break;
    case "equal":
      if (lines.length >= 2 && !curves.length) mk(lines.slice(1).map((l) => ({ t: "equal", a: lines[0], b: l })));
      else if (curves.length >= 2 && !lines.length) mk(curves.slice(1).map((c) => ({ t: "equal", a: curves[0], b: c })));
      else fail("Select two or more lines, or two or more circles/arcs");
      break;
    case "tangent": {
      const two = [...lines, ...curves];
      if (two.length === 2 && !pts.length) mk([{ t: "tangent", a: two[0], b: two[1] }]); else fail("Select a line/circle/arc pair");
      break;
    }
    case "coincident":
      if (pts.length === 2 && ids.length === 2) { if (apply((s) => mergePoints(s, pts[0], pts[1]))) SK.sel = new Set([pts[0]]); }
      else if (pts.length === 1 && (lines.length + curves.length) === 1) mk([{ t: "on", a: pts[0], b: [...lines, ...curves][0] }]);
      else fail("Select two points, or a point and a curve");
      break;
    case "midpoint":
      if (pts.length === 1 && lines.length === 1) mk([{ t: "midpoint", a: pts[0], b: lines[0] }]); else fail("Select a point and a line");
      break;
    case "concentric":
      if (curves.length === 2) mk([{ t: "concentric", a: curves[0], b: curves[1] }]); else fail("Select two circles or arcs");
      break;
    case "symmetric":
      if (pts.length === 2 && lines.length === 1) mk([{ t: "symmetric", a: pts[0], b: pts[1], l: lines[0] }]); else fail("Select two points and the line they should mirror across");
      break;
    case "fix": {
      const targets = new Set(pts);
      for (const l of lines) { targets.add(G.get(l).a); targets.add(G.get(l).b); }
      for (const c of curves) targets.add(G.get(c).c);
      if (targets.size) mk([...targets].map((p) => ({ t: "fix", a: p }))); else fail("Select points or shapes to fix");
      break;
    }
    default: break;
  }
  redraw();
}

export function deleteSelection() {
  if (!SK.sel.size) return;
  const ids = [...SK.sel];
  if (apply((s) => removeIds(s, ids), { allowConflict: true })) SK.sel = new Set();
  redraw();
}
export function toggleConstruction() {
  const { ids, G } = selectionInfo();
  const targets = ids.filter((i) => G.get(i).t !== "point");
  if (!targets.length) { SK.construction = !SK.construction; emit(); return; }
  apply((s) => { for (const g of s.geom) if (targets.includes(g.id)) g.construction = g.construction ? undefined : true; }, { allowConflict: true });
}

// ---------- dimensions ----------
const fmtV = (v) => (typeof v === "number" ? String(+v.toFixed(4)) : String(v));
function measure(G, def) {
  const P = (id) => pos(G, id), L = (id) => G.get(id);
  switch (def.k) {
    case "length": return dist(P(L(def.a).a), P(L(def.a).b));
    case "dist": return dist(P(def.a), P(def.b));
    case "hdist": return Math.abs(P(def.b)[0] - P(def.a)[0]);
    case "vdist": return Math.abs(P(def.b)[1] - P(def.a)[1]);
    case "radius": return L(def.a).t === "circle" ? L(def.a).r : dist(P(L(def.a).c), P(L(def.a).s));
    case "diameter": return 2 * (L(def.a).t === "circle" ? L(def.a).r : dist(P(L(def.a).c), P(L(def.a).s)));
    case "pdist": { const l = L(def.b), a = P(l.a), b = P(l.b), p = P(def.a); const dx = b[0] - a[0], dy = b[1] - a[1]; return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy); }
    case "angle": { const l1 = L(def.a), l2 = L(def.b); const d1 = [P(l1.b)[0] - P(l1.a)[0], P(l1.b)[1] - P(l1.a)[1]], d2 = [P(l2.b)[0] - P(l2.a)[0], P(l2.b)[1] - P(l2.a)[1]]; let a = (Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0])) / RAD; while (a < 0) a += 360; return a % 360; }
    default: return 0;
  }
}
function dimDefFor(G, items, shift) {
  const [x, y] = items.map((i) => G.get(i));
  if (items.length === 1) {
    if (x.t === "line") return { k: "length", a: x.id };
    if (x.t === "circle") return { k: "diameter", a: x.id };
    if (x.t === "arc") return { k: "radius", a: x.id };
    return null;
  }
  if (x.t === "point" && y.t === "point") {
    if (shift) { const dx = Math.abs(y.x - x.x), dy = Math.abs(y.y - x.y); const horiz = dx >= dy; const [a, b] = horiz ? (x.x <= y.x ? [x, y] : [y, x]) : (x.y <= y.y ? [x, y] : [y, x]); return { k: horiz ? "hdist" : "vdist", a: a.id, b: b.id }; }
    return { k: "dist", a: x.id, b: y.id };
  }
  if (x.t === "line" && y.t === "line") return { k: "angle", a: x.id, b: y.id };
  if (x.t === "point" && y.t === "line") return { k: "pdist", a: x.id, b: y.id };
  if (x.t === "line" && y.t === "point") return { k: "pdist", a: y.id, b: x.id };
  return null;
}
function openDimEditor(def, screen) {
  const G = gmap(geomOf());
  const m = measure(G, def);
  const input = h("input", { class: "in", value: fmtV(r4(m)), style: { width: "90px", position: "absolute", left: `${screen[0]}px`, top: `${screen[1]}px`, pointerEvents: "auto", zIndex: 5 }, onkeydown: (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { SK.dimEdit = null; redraw(); }
    if (e.key === "Enter") {
      const t = input.value.trim(); const v = /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : t;
      try { evaluator()(v); } catch (err) { toast(err.message, "err"); return; }
      const ok = apply((s) => addCons(s, { t: "dim", ...def, v }));
      SK.dimEdit = null; SK.draft = null; if (ok) toast("Dimension added"); redraw();
    }
  } });
  SK.dimEdit = { def, input };
  labelLayer().append(input); input.focus(); input.select();
}
function dimClick(pt, e) {
  const hit = pickGeom(pt.raw, { points: true, curves: true });
  const d = (SK.draft ??= { items: [] });
  if (!hit) {
    if (d.items.length) { const def = dimDefFor(gmap(geomOf()), d.items.slice(0, 1), false) ?? null; if (def && d.items.length === 1) openDimEditor(def, VP.project(pt.raw).map((v) => v + 8)); }
    return;
  }
  if (!d.items.includes(hit.id)) d.items.push(hit.id);
  const G = gmap(geomOf());
  if (d.items.length === 2) {
    const def = dimDefFor(G, d.items, e.shiftKey);
    if (!def) { toast("Can't dimension that pair. Try two points, two lines, or a point and a line", "err"); SK.draft = null; return; }
    openDimEditor(def, VP.project(pt.raw).map((v) => v + 8));
  }
  SK.sel = new Set(d.items);
}

// ---------- pointer handling ----------
export function sketchHandlers(vp) {
  VP = vp;
  return {
    onSketchDown(pt) {
      if (!pt || !sk() || SK.tool !== "select") return;
      const hit = pickGeom(pt.raw);
      SK.pending = hit ? { hit, start: pt.raw, orig: structuredClone(sk().geom) } : null;
    },
    onSketchMove(pt, e) {
      if (!pt || !sk()) return;
      SK.cursor = pt.raw; SK.info = `x ${r4(pt.p[0])}   y ${r4(pt.p[1])}`;
      const pend = SK.pending;
      if (pend && (e.buttons & 1)) {
        if (!SK.dragging && dist(pt.raw, pend.start) < 4 * vp.pixelSize()) return;
        SK.dragging = true; drag(pend, pt.raw); return;
      }
      SK.hover = SK.tool === "select" || SK.tool === "dim" ? pickGeom(pt.raw)?.id ?? null : null;
      SK.snap = !["select", "dim"].includes(SK.tool) ? snap(pt) : null;
      redraw(); emit();
    },
    onSketchUp(pt, e) {
      if (!pt || !sk()) return;
      const pend = SK.pending; SK.pending = null;
      if (SK.dragging) { SK.dragging = false; commitDrag(pend); return; }
      if (SK.tool === "select") {
        const hit = pend?.hit ?? pickGeom(pt.raw);
        if (!hit) { if (!e.shiftKey) SK.sel = new Set(); }
        else if (e.shiftKey) { SK.sel = new Set(SK.sel); SK.sel.has(hit.id) ? SK.sel.delete(hit.id) : SK.sel.add(hit.id); }
        else SK.sel = new Set([hit.id]);
        redraw(); emit(); return;
      }
      if (SK.tool === "dim") { if (!SK.dimEdit) dimClick(pt, e); redraw(); emit(); return; }
      click(pt, e); redraw(); emit();
    },
    onSketchDouble() { if (SK.tool === "line") SK.draft = null; redraw(); },
    onCamera() { if (sk() && !SK.dimEdit) redrawLabels(); },
  };
}

function drag(pend, raw) {
  const { hit, start, orig } = pend, G = gmap(orig);
  const s = { geom: structuredClone(orig), cons: structuredClone(sk().cons ?? []) };
  const dragMap = {};
  const g = G.get(hit.id);
  if (g.t === "point") dragMap[g.id] = raw;
  else if (g.t === "line") { const dx = raw[0] - start[0], dy = raw[1] - start[1]; for (const k of ["a", "b"]) { const p = G.get(g[k]); dragMap[g[k]] = [p.x + dx, p.y + dy]; } }
  else if (g.t === "circle") { const c = G.get(g.c); s.geom.find((x) => x.id === g.id).r = Math.max(1e-3, dist(raw, [c.x, c.y])); }
  else return;
  try { SK.live = solveSketch(s, evaluator(), { drag: dragMap }).geom; } catch { return; }
  redraw();
}
function commitDrag(pend) {
  const live = SK.live; SK.live = null;
  if (!live || !pend) { redraw(); return; }
  const ok = apply((s) => { const L = gmap(live); for (const g of s.geom) { const l = L.get(g.id); if (!l) continue; if (g.t === "point") { g.x = l.x; g.y = l.y; } if (g.t === "circle") g.r = l.r; } }, { allowConflict: true });
  if (!ok) redraw();
}

export function sketchKey(e) {
  if (!S.sketchEdit) return false;
  if (SK.dimEdit) return false;
  const k = e.key.toLowerCase();
  if (e.key === "Escape") {
    if (SK.draft) { SK.draft = null; redraw(); emit(); return true; }
    if (SK.sel.size) { SK.sel = new Set(); redraw(); emit(); return true; }
    if (SK.tool !== "select") { setTool("select"); return true; }
    return false;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && SK.sel.size) { deleteSelection(); return true; }
  if (e.metaKey || e.ctrlKey) return false;
  const map = { l: "line", r: "rect", c: "circle", a: "arc3", d: "dim", s: "select", p: "point", t: "trim" };
  if (map[k]) { setTool(map[k]); return true; }
  if (k === "x") { toggleConstruction(); return true; }
  const cmap = { h: "horizontal", v: "vertical", e: "equal" };
  if (cmap[k]) { applyConstraint(cmap[k]); return true; }
  return false;
}

// ---------- rendering ----------
function arcPts(c, s, e, n = 28) {
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]); if (a1 <= a0) a1 += 2 * Math.PI;
  const r = dist(c, s);
  return Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; });
}
const circlePts = (c, r) => Array.from({ length: 73 }, (_, i) => [c[0] + r * Math.cos((i / 72) * 2 * Math.PI), c[1] + r * Math.sin((i / 72) * 2 * Math.PI)]);

/** Legacy shape outlines (from older files) so they still display. */
export function outline(e, ev) {
  const n = (k, d = 0) => ev.opt(e[k], d);
  const cx = n("cx"), cy = n("cy"), ang = n("angle") * RAD;
  const place = (pts) => pts.map(([x, y]) => [cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)]);
  const arc = (ox, oy, r, a0, a1, steps = 10) => Array.from({ length: steps + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / steps; return [ox + r * Math.cos(a), oy + r * Math.sin(a)]; });
  switch (e.type) {
    case "rect": {
      const w = ev(e.w) / 2, hh = ev(e.h) / 2, r = Math.min(n("r"), Math.min(w, hh));
      if (r <= 0) return place([[-w, -hh], [w, -hh], [w, hh], [-w, hh]]);
      return place([...arc(w - r, -hh + r, r, -Math.PI / 2, 0), ...arc(w - r, hh - r, r, 0, Math.PI / 2), ...arc(-w + r, hh - r, r, Math.PI / 2, Math.PI), ...arc(-w + r, -hh + r, r, Math.PI, 1.5 * Math.PI)]);
    }
    case "circle": return place(arc(0, 0, ev(e.r), 0, 2 * Math.PI, 72).slice(0, -1));
    case "ellipse": { const rx = ev(e.rx), ry = ev(e.ry); return place(arc(0, 0, 1, 0, 2 * Math.PI, 72).slice(0, -1).map(([x, y]) => [x * rx, y * ry])); }
    case "polygon": { const k = Math.max(3, Math.round(ev(e.sides))), r = ev(e.r); return place(Array.from({ length: k }, (_, i) => { const a = Math.PI / 2 + (2 * Math.PI * i) / k; return [r * Math.cos(a), r * Math.sin(a)]; })); }
    case "slot": { const L = ev(e.length), w = ev(e.width), r = w / 2, d = Math.max(0, L / 2 - r); return place([...arc(d, 0, r, -Math.PI / 2, Math.PI / 2), ...arc(-d, 0, r, Math.PI / 2, 1.5 * Math.PI)]); }
    case "polyline": case "spline": return e.points.map((p) => ev.vec(p, [0, 0]));
    default: throw new Error(`Unknown shape ${e.type}`);
  }
}
export function describe(e) {
  switch (e.type) {
    case "rect": return `Rectangle ${e.w} × ${e.h}`; case "circle": return `Circle r ${e.r}`; case "ellipse": return `Ellipse ${e.rx} × ${e.ry}`;
    case "polygon": return `Polygon ${e.sides} sides`; case "slot": return `Slot ${e.length} × ${e.width}`; case "polyline": return `Shape ${e.points.length} points`; case "spline": return `Spline ${e.points.length} points`;
    default: return e.type;
  }
}
export function deleteEntity(i) { edit((p) => { p.features.find((f) => f.id === S.sketchEdit).entities.splice(i, 1); }); }

/** Solve (cached) so the UI can show degrees of freedom and conflicts. */
export function sketchStatus() {
  const s = sk(); if (!s || !solverReady()) return null;
  if (!s.geom?.length) return { dof: 0, ok: true, conflicting: [], redundant: [], empty: true };
  const key = JSON.stringify([s.geom, s.cons, effVars()]);
  if (key !== SK.cacheKey) { try { SK.result = solveSketch(s, evaluator()); } catch (e) { SK.result = { dof: 0, ok: false, conflicting: [], redundant: [], error: e.message }; } SK.cacheKey = key; }
  return SK.result;
}

const labelLayer = () => {
  let l = document.getElementById("sklabels");
  if (!l) { l = h("div", { id: "sklabels", style: { position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" } }); VP.canvas.parentElement.insertBefore(l, VP.canvas.nextSibling); }
  return l;
};

export function redraw(vpArg) {
  if (vpArg) VP = vpArg;
  const s = sk();
  if (!s || !VP?.sketchFrame) { document.getElementById("sklabels")?.replaceChildren(); return; }
  const ev = evaluator(), geom = geomOf(), G = gmap(geom), st = sketchStatus();
  const bad = new Set((st?.conflicting ?? []).flatMap((id) => { const c = (s.cons ?? []).find((x) => x.id === id); return c ? [c.a, c.b] : []; }));
  const base = st && st.dof === 0 && !st.empty ? 0x2b2118 : 0x2f6fe0;
  const items = [], dots = [];
  for (const e of s.entities ?? []) { try { items.push({ pts: outline(e, ev), closed: true, color: 0x7d8aa6, width: 2 }); } catch { /* shown in inspector */ } }
  for (const g of geom) {
    if (g.t === "point") continue;
    const sel = SK.sel.has(g.id), hov = SK.hover === g.id;
    const color = bad.has(g.id) ? 0xff5d6c : sel ? 0xff9a45 : hov ? 0xa9c8ff : g.construction ? 0x7d8aa6 : base;
    const style = { color, width: sel ? 3.5 : g.construction ? 1.5 : 2.5, dashed: !!g.construction };
    if (g.t === "line") items.push({ pts: [pos(G, g.a), pos(G, g.b)], ...style });
    else if (g.t === "circle") items.push({ pts: circlePts(pos(G, g.c), g.r), ...style });
    else if (g.t === "arc") items.push({ pts: arcPts(pos(G, g.c), pos(G, g.s), pos(G, g.e)), ...style });
    else if (g.t === "ellipse") items.push({ pts: ellipsePts(G, g), ...style });
  }
  for (const g of geom) if (g.t === "point") {
    const sel = SK.sel.has(g.id), hov = SK.hover === g.id;
    dots.push({ p: [g.x, g.y], color: sel ? 0xff9a45 : hov ? 0x000000 : bad.has(g.id) ? 0xff5d6c : base, size: sel || hov ? 10 : 6.5 });
  }
  dots.push({ p: [0, 0], color: 0x8b93a5, size: 4 });
  // in-progress preview
  const cur = SK.snap?.p ?? null;
  const d = SK.draft, white = { color: 0x3a2c1e, width: 2, opacity: 0.85 };
  if (d && cur && SK.tool !== "dim") {
    const pts = d.pts ?? [];
    if (SK.tool === "line" && d.last) items.push({ pts: [at(d.last, G), SK.snap.kind === "free" ? inferHV(at(d.last, G), cur).p : cur], ...white });
    else if ((SK.tool === "rect" || SK.tool === "crect") && pts[0]) {
      const a = at(pts[0], G), b = cur;
      const c0 = SK.tool === "crect" ? [a[0] - (b[0] - a[0]), a[1] - (b[1] - a[1])] : a;
      items.push({ pts: [c0, [b[0], c0[1]], b, [c0[0], b[1]]], closed: true, ...white });
    } else if (SK.tool === "circle" && pts[0]) items.push({ pts: circlePts(at(pts[0], G), dist(at(pts[0], G), cur)), ...white });
    else if (SK.tool === "polygon" && pts[0]) { const c = at(pts[0], G), r = dist(c, cur), a0 = Math.atan2(cur[1] - c[1], cur[0] - c[0]); items.push({ pts: Array.from({ length: SK.sides }, (_, i) => [c[0] + r * Math.cos(a0 + (2 * Math.PI * i) / SK.sides), c[1] + r * Math.sin(a0 + (2 * Math.PI * i) / SK.sides)]), closed: true, ...white }); }
    else if (SK.tool === "arc3" && pts.length) { if (pts.length === 1) items.push({ pts: [at(pts[0], G), cur], ...white }); else { const A = at(pts[0], G), B = at(pts[1], G), C = cur; const dd = 2 * (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1])); if (Math.abs(dd) > 1e-9) { const ux = ((A[0] ** 2 + A[1] ** 2) * (B[1] - C[1]) + (B[0] ** 2 + B[1] ** 2) * (C[1] - A[1]) + (C[0] ** 2 + C[1] ** 2) * (A[1] - B[1])) / dd, uy = ((A[0] ** 2 + A[1] ** 2) * (C[0] - B[0]) + (B[0] ** 2 + B[1] ** 2) * (A[0] - C[0]) + (C[0] ** 2 + C[1] ** 2) * (B[0] - A[0])) / dd; const TWO = 2 * Math.PI, ang = (p) => Math.atan2(p[1] - uy, p[0] - ux), nm = (x) => ((x % TWO) + TWO) % TWO; const ccw = nm(ang(C) - ang(A)) <= nm(ang(B) - ang(A)); items.push({ pts: ccw ? arcPts([ux, uy], A, B) : arcPts([ux, uy], B, A), ...white }); } } }
    else if (SK.tool === "arcc" && pts.length) { const c = at(pts[0], G); if (pts.length === 1) items.push({ pts: [c, cur], ...white }); else { const st2 = at(pts[1], G), r = dist(c, st2), k = dist(c, cur) ? r / dist(c, cur) : 0, en = [c[0] + (cur[0] - c[0]) * k, c[1] + (cur[1] - c[1]) * k]; items.push({ pts: arcPts(c, st2, en), ...white }); } }
    else if (SK.tool === "tarc" && pts.length) items.push({ pts: [at(pts[0], G), cur], ...white });
    else if (SK.tool === "ellipse" && pts.length) {
      const c = at(pts[0], G); if (pts.length === 1) items.push({ pts: [c, cur], ...white }); else { const A = at(pts[1], G), a = dist(c, A) || 1, dir = [(A[0] - c[0]) / a, (A[1] - c[1]) / a], b = Math.min(Math.abs((cur[0] - c[0]) * dir[1] - (cur[1] - c[1]) * dir[0]), a * 0.999), rot = Math.atan2(dir[1], dir[0]);
        items.push({ pts: Array.from({ length: 73 }, (_, i) => { const t = (i / 72) * 2 * Math.PI, ex = a * Math.cos(t), ey = b * Math.sin(t); return [c[0] + ex * Math.cos(rot) - ey * Math.sin(rot), c[1] + ex * Math.sin(rot) + ey * Math.cos(rot)]; }), ...white }); }
    }
    else if (SK.tool === "slot" && pts.length) { const A = at(pts[0], G); if (pts.length === 1) items.push({ pts: [A, cur], ...white }); else { const B = at(pts[1], G), len = dist(A, B) || 1, nrm = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len], w = Math.abs((cur[0] - A[0]) * nrm[0] + (cur[1] - A[1]) * nrm[1]); items.push({ pts: [[A[0] + nrm[0] * w, A[1] + nrm[1] * w], [B[0] + nrm[0] * w, B[1] + nrm[1] * w], [B[0] - nrm[0] * w, B[1] - nrm[1] * w], [A[0] - nrm[0] * w, A[1] - nrm[1] * w]], closed: true, ...white }); } }
    for (const p of pts) dots.push({ p: at(p, G), color: 0x3a2c1e, size: 8 });
    if (d.last) dots.push({ p: at(d.last, G), color: 0x3a2c1e, size: 8 });
  }
  if (SK.snap && !["select", "dim"].includes(SK.tool)) dots.push({ p: SK.snap.p, color: SK.snap.kind === "point" ? 0x3ecf8e : SK.snap.kind === "curve" ? 0x1f8a93 : 0x3a2c1e, size: SK.snap.kind === "free" ? 6 : 11 });
  VP.drawSketch(items, dots);
  redrawLabels();
}

function redrawLabels() {
  const s = sk(); if (!s || !VP?.sketchFrame) return;
  const layer = labelLayer(), keep = SK.dimEdit?.input;
  [...layer.children].forEach((c) => { if (c !== keep) c.remove(); });
  const G = gmap(geomOf()), ev = evaluator();
  const scr = (p) => VP.project(p);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const stack = new Map();
  // Like Onshape: a label that would land on top of one already drawn is skipped (zoom in to see it; it's always in
  // the dimension list). Selected labels always show.
  const placed = [];
  const free = (x, y, w, hh) => !placed.some((r) => x < r[0] + r[2] && r[0] < x + w && y < r[1] + r[3] && r[1] < y + hh);
  const badge = (text, local, { title, id, cls = "", off = [0, 0], dim = false } = {}) => {
    const q = scr(local); if (!q) return;
    const n = stack.get(id ?? text) ?? 0; stack.set(id ?? text, n + 1);
    const x = q[0] + off[0] + n * 15, y = q[1] + off[1], w = String(text).length * 7.5 + 12, hh = 18;
    if (!SK.sel.has(id) && !free(x - 2, y - 2, w + 4, hh + 4)) return;
    placed.push([x, y, w, hh]);
    const el = h("div", { class: `sklabel ${cls} ${SK.sel.has(id) ? "sel" : ""}`, title, style: { left: `${q[0] + off[0] + n * 15}px`, top: `${q[1] + off[1]}px` },
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => { e.stopPropagation(); if (id) { SK.sel = e.shiftKey ? new Set([...SK.sel, id]) : new Set([id]); redraw(); emit(); } },
      ondblclick: (e) => { e.stopPropagation(); if (dim && id) editDim(id, [q[0] + off[0], q[1] + off[1]]); } }, text);
    layer.append(el);
  };
  // Sizes first, then positions, then constraint glyphs, so the useful labels win when space is tight.
  const rank = (c) => (c.t !== "dim" ? 2 : c.k === "x" || c.k === "y" ? 1 : 0);
  for (const c of [...(s.cons ?? [])].sort((a, b) => rank(a) - rank(b))) {
    try {
      const A = G.get(c.a), B = c.b ? G.get(c.b) : null;
      const center = (g) => (g.t === "point" ? [g.x, g.y] : g.t === "line" ? mid(pos(G, g.a), pos(G, g.b)) : pos(G, g.c));
      if (c.t === "dim") {
        const v = ev(c.v); const text = { radius: `R${fmtV(r4(v))}`, diameter: `Ø${fmtV(r4(v))}`, angle: `${fmtV(r4(v))}°` }[c.k] ?? fmtV(r4(v));
        let p, off = [0, -16];
        if (c.k === "length") p = center(A);
        else if (["dist", "hdist", "vdist"].includes(c.k)) p = mid(center(A), center(B));
        else if (c.k === "pdist") p = mid(center(A), center(B));
        else if (c.k === "angle") p = mid(center(A), center(B));
        else if (c.k === "radius" || c.k === "diameter") { const cc = pos(G, A.c); const r = A.t === "circle" ? A.r : dist(cc, pos(G, A.s)); p = [cc[0] + r * 0.7071, cc[1] + r * 0.7071]; off = [10, -14]; }
        else p = center(A);
        badge(text, p, { id: c.id, cls: "dim", off, title: `${c.k} = ${c.v} (double-click to edit)`, dim: true });
      } else if (SK.showCons) {
        const glyph = { horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⟂", equal: "=", tangent: "T", midpoint: "M", concentric: "◎", fix: "▣", on: "⌖", coincident: "●", symmetric: "⇋" }[c.t];
        if (glyph) badge(glyph, center(A), { id: c.id, off: [8, 10], cls: SK.sel.has(c.id) ? "sel" : "", title: c.t });
      }
    } catch { /* stale reference */ }
  }
}
function editDim(id, screen) {
  const c = sk().cons.find((x) => x.id === id); if (!c) return;
  const input = h("input", { class: "in", value: fmtV(c.v), style: { width: "90px", position: "absolute", left: `${screen[0]}px`, top: `${screen[1]}px`, pointerEvents: "auto", zIndex: 6 }, onkeydown: (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { SK.dimEdit = null; input.remove(); redraw(); }
    if (e.key === "Enter") {
      const t = input.value.trim(); const v = /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : t;
      try { evaluator()(v); } catch (err) { toast(err.message, "err"); return; }
      SK.dimEdit = null; input.remove();
      apply((s) => { s.cons.find((x) => x.id === id).v = v; });
      redraw();
    }
  } });
  SK.dimEdit = { input }; labelLayer().append(input); input.focus(); input.select();
}

export function frameOfActive() {
  const s = sk(); if (!s) return null;
  try { const ev = evaluator(); return sketchFrame(s, ev, planeFrames(S.part, ev)); } catch { return null; }
}
export function resetSketchState() { SK.mirrorIds = null; SK.draft = null; SK.sel = new Set(); SK.tool = "line"; SK.info = ""; SK.live = null; SK.pending = null; SK.dimEdit = null; SK.cacheKey = ""; }
export { TOOLS };

// ---------- finished-sketch display & region data ----------
const regionCache = new Map();
/** Solved regions + curve outlines for a sketch feature (cached). */
export function sketchView(f) {
  if (!solverReady()) return null;
  const key = JSON.stringify([f.id, f.geom, f.cons, f.entities, f.plane, f.offset, effVars()]);
  if (regionCache.has(key)) return regionCache.get(key);
  let out = null;
  try {
    const ev = evaluator(), frame = sketchFrame(f, ev, planeFrames(S.part, ev)), curves = [], regions = [];
    if (f.geom?.length) {
      const sol = solveSketch(f, ev), G = gmap(sol.geom);
      for (const g of sol.geom) {
        if (g.t === "line") curves.push([pos(G, g.a), pos(G, g.b)]);
        else if (g.t === "circle") curves.push(circlePts(pos(G, g.c), g.r));
        else if (g.t === "arc") curves.push(arcPts(pos(G, g.c), pos(G, g.s), pos(G, g.e)));
        else if (g.t === "ellipse") curves.push(ellipsePts(G, g));
      }
      for (const r of regionsOf(sol.geom)) regions.push({ outer: r.outer.pts, holes: r.holes.map((h) => h.pts), raw: r });
    }
    for (const e of f.entities ?? []) { try { const pts = outline(e, ev); curves.push([...pts, pts[0]]); regions.push({ outer: pts, holes: [], raw: { outer: { pts }, holes: [] } }); } catch { /* skip */ } }
    out = { frame, curves, regions };
  } catch { out = null; }
  if (regionCache.size > 40) regionCache.clear();
  regionCache.set(key, out);
  return out;
}
export const regionContains = (r, p) => inRegion(r.raw, p);

// ---------- DXF ----------
export async function importDXF() {
  if (!activeSketch()) return;
  try {
    const f = await window.cad.invoke("dxf:pick"); if (!f) return;
    const parsed = parseDXF(f.text);
    if (apply((s) => { s.geom.push(...dxfToGeom(parsed, sketchIds(s))); })) toast(`Imported ${f.name}`, "ok");
    redraw();
  } catch (e) { toast(e.message, "err"); }
}
export async function exportDXF(sketchFeat) {
  try {
    const s = sketchFeat ?? activeSketch();
    const geom = solveSketch(s, evaluator()).geom;
    const bytes = new TextEncoder().encode(sketchToDXF(geom));
    const saved = await window.cad.invoke("export:save", { name: (s.name ?? s.id).replace(/[^\w.-]+/g, "_"), ext: "dxf", bytes });
    if (saved) toast(`Exported ${saved}`, "ok");
  } catch (e) { toast(e.message, "err"); }
}
