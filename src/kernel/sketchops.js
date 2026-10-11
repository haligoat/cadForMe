// Pure sketch editing operations on { geom, cons }: trim, fillet, mirror, offset.
// They mutate the sketch they are given (callers pass a clone) and are solved afterwards by the caller.
const TAU = 2 * Math.PI;
const norm2 = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const nrm = (x) => ((x % TAU) + TAU) % TAU;

export function ids(s) { return new Set([...s.geom, ...s.cons].map((x) => x.id)); }
function nid(s, prefix) { const used = ids(s); let n = 1; while (used.has(`${prefix}${n}`)) n++; return `${prefix}${n}`; }
const addPoint = (s, p) => { const id = nid(s, "p"); s.geom.push({ id, t: "point", x: Math.round(p[0] * 1e6) / 1e6, y: Math.round(p[1] * 1e6) / 1e6 }); return id; };
const addGeom = (s, g) => { const id = nid(s, { line: "l", circle: "c", arc: "a", ellipse: "e" }[g.t]); s.geom.push({ id, ...g }); return id; };
const addCons = (s, c) => { const id = nid(s, c.t === "dim" ? "d" : "k"); s.cons.push({ id, ...c }); return id; };
const gmap = (s) => new Map(s.geom.map((g) => [g.id, g]));
const pt = (G, id) => { const p = G.get(id); return [p.x, p.y]; };

/** Geometry description with parameters, for intersection maths. */
function info(G, g) {
  if (g.t === "line") return { k: "line", a: pt(G, g.a), b: pt(G, g.b), g };
  if (g.t === "circle") return { k: "circle", c: pt(G, g.c), r: g.r, g };
  if (g.t === "arc") { const c = pt(G, g.c), s = pt(G, g.s), e = pt(G, g.e); const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); return { k: "arc", c, r: dist(c, s), a0, span: nrm(Math.atan2(e[1] - c[1], e[0] - c[0]) - a0) || TAU, g }; }
  return null;
}
const onArc = (i, p) => i.k !== "arc" || nrm(Math.atan2(p[1] - i.c[1], p[0] - i.c[0]) - i.a0) <= i.span + 1e-7;
/** Parameter of point p along a curve: t in [0,1] for lines, angle from the start (0..2π) for circles/arcs. */
function param(i, p) {
  if (i.k === "line") { const d = [i.b[0] - i.a[0], i.b[1] - i.a[1]]; return ((p[0] - i.a[0]) * d[0] + (p[1] - i.a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]); }
  return nrm(Math.atan2(p[1] - i.c[1], p[0] - i.c[0]) - (i.k === "arc" ? i.a0 : 0));
}

/** Intersection points of two curve infos (within both extents). */
export function intersect(A, B) {
  if (A.k !== "line" && B.k === "line") return intersect(B, A);
  const out = [];
  if (A.k === "line" && B.k === "line") {
    const d1 = [A.b[0] - A.a[0], A.b[1] - A.a[1]], d2 = [B.b[0] - B.a[0], B.b[1] - B.a[1]], den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-12) return out;
    const t = ((B.a[0] - A.a[0]) * d2[1] - (B.a[1] - A.a[1]) * d2[0]) / den, u = ((B.a[0] - A.a[0]) * d1[1] - (B.a[1] - A.a[1]) * d1[0]) / den;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) out.push([A.a[0] + d1[0] * t, A.a[1] + d1[1] * t]);
  } else if (A.k === "line") {
    const d = [A.b[0] - A.a[0], A.b[1] - A.a[1]], f = [A.a[0] - B.c[0], A.a[1] - B.c[1]];
    const a = d[0] * d[0] + d[1] * d[1], b = 2 * (f[0] * d[0] + f[1] * d[1]), c = f[0] * f[0] + f[1] * f[1] - B.r * B.r, disc = b * b - 4 * a * c;
    if (disc >= 0) for (const sgn of disc < 1e-12 ? [0] : [-1, 1]) { const t = (-b + sgn * Math.sqrt(disc)) / (2 * a); if (t >= -1e-9 && t <= 1 + 1e-9) { const p = [A.a[0] + d[0] * t, A.a[1] + d[1] * t]; if (onArc(B, p)) out.push(p); } }
  } else {
    const d = dist(A.c, B.c);
    if (d < 1e-12 || d > A.r + B.r + 1e-9 || d < Math.abs(A.r - B.r) - 1e-9) return out;
    const a = (A.r * A.r - B.r * B.r + d * d) / (2 * d), h2 = A.r * A.r - a * a, h = Math.sqrt(Math.max(0, h2));
    const m = [A.c[0] + ((B.c[0] - A.c[0]) * a) / d, A.c[1] + ((B.c[1] - A.c[1]) * a) / d];
    for (const sgn of h < 1e-9 ? [0] : [-1, 1]) { const p = [m[0] + (sgn * h * (B.c[1] - A.c[1])) / d, m[1] - (sgn * h * (B.c[0] - A.c[0])) / d]; if (onArc(A, p) && onArc(B, p)) out.push(p); }
  }
  return out;
}

const refs = (s, id) => s.cons.filter((c) => c.a === id || c.b === id || c.l === id);
function dropCons(s, id) { s.cons = s.cons.filter((c) => c.a !== id && c.b !== id && c.l !== id); }
function dropOrphanPoints(s, candidates) {
  for (const pid of candidates) {
    if (pid === "o") continue;
    const used = s.geom.some((g) => g.t !== "point" && ["a", "b", "c", "s", "e", "f"].some((k) => g[k] === pid)) || s.cons.some((c) => c.a === pid || c.b === pid || c.l === pid);
    if (!used) s.geom = s.geom.filter((g) => g.id !== pid);
  }
}

/** Trim the curve `id` at the clicked location `at`, back to the nearest crossing curves. */
export function trim(s, id, at) {
  const G = gmap(s), target = G.get(id), I = info(G, target);
  if (!I) throw new Error("Only lines, arcs and circles can be trimmed");
  const others = s.geom.filter((g) => g.id !== id && ["line", "circle", "arc"].includes(g.t)).map((g) => info(G, g));
  const hits = [];
  for (const O of others) for (const p of intersect(I, O)) hits.push({ p, t: param(I, p), against: O.g.id });
  const ends = target.t === "line" ? [target.a, target.b] : target.t === "arc" ? [target.s, target.e, target.c] : [target.c];
  const remove = () => { s.geom = s.geom.filter((g) => g.id !== id); dropCons(s, id); dropOrphanPoints(s, ends); };
  const mk = (h) => { const pid = addPoint(s, h.p); addCons(s, { t: "on", a: pid, b: h.against }); return pid; };

  if (I.k === "line") {
    const tc = param(I, at), eps = 1e-6;
    const inner = hits.filter((h) => h.t > eps && h.t < 1 - eps).sort((a, b) => a.t - b.t);
    const lo = [...inner].reverse().find((h) => h.t < tc), hi = inner.find((h) => h.t > tc);
    if (!lo && !hi) { remove(); return s; }
    const { a, b } = target;
    for (const c of refs(s, id)) s.cons.splice(s.cons.indexOf(c), 1);
    if (lo && hi) { const pl = mk(lo), ph = mk(hi); target.b = pl; addGeom(s, { t: "line", a: ph, b, ...(target.construction ? { construction: true } : {}) }); }
    else if (hi) { target.a = mk(hi); dropOrphanPoints(s, [a]); }
    else { target.b = mk(lo); dropOrphanPoints(s, [b]); }
    return s;
  }
  // circles and arcs
  const full = I.k === "circle", span = full ? TAU : I.span, tc = param(I, at);
  const inner = hits.filter((h) => (full || (h.t > 1e-6 && h.t < span - 1e-6))).sort((a, b) => a.t - b.t);
  if (full) {
    if (inner.length < 2) { remove(); return s; }
    const prev = [...inner].reverse().find((h) => h.t < tc) ?? inner.at(-1), next = inner.find((h) => h.t > tc) ?? inner[0];
    const centre = target.c; s.geom = s.geom.filter((g) => g.id !== id); dropCons(s, id);
    addGeom(s, { t: "arc", c: centre, s: mk(next), e: mk(prev) });
    return s;
  }
  const lo = [...inner].reverse().find((h) => h.t < tc), hi = inner.find((h) => h.t > tc);
  if (!lo && !hi) { remove(); return s; }
  const { s: s0, e: e0, c } = target;
  for (const k of refs(s, id)) s.cons.splice(s.cons.indexOf(k), 1);
  if (lo && hi) { const pl = mk(lo), ph = mk(hi); target.e = pl; addGeom(s, { t: "arc", c, s: ph, e: e0 }); }
  else if (hi) { target.s = mk(hi); dropOrphanPoints(s, [s0]); }
  else { target.e = mk(lo); dropOrphanPoints(s, [e0]); }
  return s;
}

/** Round the corner at point `pid` where exactly two lines meet. */
export function fillet(s, pid, r) {
  const G = gmap(s), lines = s.geom.filter((g) => g.t === "line" && (g.a === pid || g.b === pid));
  if (lines.length !== 2) throw new Error("Pick a corner where exactly two lines meet");
  if (!(r > 0)) throw new Error("The fillet radius must be positive");
  const P = pt(G, pid), far = (l) => (l.a === pid ? l.b : l.a);
  const u1 = norm2([pt(G, far(lines[0]))[0] - P[0], pt(G, far(lines[0]))[1] - P[1]]), u2 = norm2([pt(G, far(lines[1]))[0] - P[0], pt(G, far(lines[1]))[1] - P[1]]);
  const dotp = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])), theta = Math.acos(dotp);
  if (theta < 1e-3 || theta > Math.PI - 1e-3) throw new Error("Those lines are straight through the corner; there's nothing to round");
  const t = r / Math.tan(theta / 2), len1 = dist(P, pt(G, far(lines[0]))), len2 = dist(P, pt(G, far(lines[1])));
  if (t > len1 - 1e-6 || t > len2 - 1e-6) throw new Error("That radius is too big for these lines");
  const bis = norm2([u1[0] + u2[0], u1[1] + u2[1]]), cd = r / Math.sin(theta / 2);
  const C = [P[0] + bis[0] * cd, P[1] + bis[1] * cd], T1 = [P[0] + u1[0] * t, P[1] + u1[1] * t], T2 = [P[0] + u2[0] * t, P[1] + u2[1] * t];
  const t1 = addPoint(s, T1), t2 = addPoint(s, T2), cp = addPoint(s, C);
  for (const [l, tp] of [[lines[0], t1], [lines[1], t2]]) { if (l.a === pid) l.a = tp; else l.b = tp; }
  const cross = (T1[0] - C[0]) * (T2[1] - C[1]) - (T1[1] - C[1]) * (T2[0] - C[0]);
  const arc = addGeom(s, { t: "arc", c: cp, s: cross > 0 ? t1 : t2, e: cross > 0 ? t2 : t1 });
  addCons(s, { t: "tangent", a: lines[0].id, b: arc }); addCons(s, { t: "tangent", a: lines[1].id, b: arc }); addCons(s, { t: "dim", k: "radius", a: arc, v: Math.round(r * 1e6) / 1e6 });
  s.cons = s.cons.filter((c) => c.a !== pid && c.b !== pid);
  s.geom = s.geom.filter((g) => g.id !== pid);
  return s;
}

/** Mirror geometry across a line, keeping the copies symmetric with constraints. */
export function mirror(s, geomIds, axisId) {
  const G = gmap(s), axis = G.get(axisId);
  if (axis?.t !== "line") throw new Error("Pick a line to mirror across");
  const A = pt(G, axis.a), B = pt(G, axis.b), d = norm2([B[0] - A[0], B[1] - A[1]]);
  const reflect = (p) => { const v = [p[0] - A[0], p[1] - A[1]], k = v[0] * d[0] + v[1] * d[1], f = [A[0] + d[0] * k, A[1] + d[1] * k]; return [2 * f[0] - p[0], 2 * f[1] - p[1]]; };
  const map = new Map();
  const mp = (pid) => {
    if (map.has(pid)) return map.get(pid);
    const p = pt(G, pid), q = reflect(p);
    if (dist(p, q) < 1e-6) { map.set(pid, pid); return pid; } // on the axis: shared
    const np = addPoint(s, q); map.set(pid, np);
    addCons(s, { t: "symmetric", a: pid, b: np, l: axisId });
    return np;
  };
  const made = [];
  for (const id of geomIds) {
    const g = G.get(id); if (!g || id === axisId) continue;
    if (g.t === "line") made.push(addGeom(s, { t: "line", a: mp(g.a), b: mp(g.b), ...(g.construction ? { construction: true } : {}) }));
    else if (g.t === "circle") made.push(addGeom(s, { t: "circle", c: mp(g.c), r: g.r, ...(g.construction ? { construction: true } : {}) }));
    else if (g.t === "arc") made.push(addGeom(s, { t: "arc", c: mp(g.c), s: mp(g.e), e: mp(g.s), ...(g.construction ? { construction: true } : {}) })); // reflection reverses direction
  }
  if (!made.length) throw new Error("Select shapes to mirror first");
  return s;
}

/** Offset closed loops of lines/arcs (and circles) by distance d; positive = outward. */
export function offset(s, geomIds, d) {
  const G = gmap(s);
  const sel = geomIds.map((id) => G.get(id)).filter((g) => g && ["line", "arc", "circle"].includes(g.t));
  if (!sel.length) throw new Error("Select lines, arcs or circles to offset");
  for (const c of sel.filter((g) => g.t === "circle")) addGeom(s, { t: "circle", c: c.c, r: Math.max(1e-6, c.r + d) });
  const segs = sel.filter((g) => g.t !== "circle");
  if (!segs.length) return s;
  // order the segments into a loop
  const key = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const ends = (g) => (g.t === "line" ? [pt(G, g.a), pt(G, g.b)] : [pt(G, g.s), pt(G, g.e)]);
  const left = [...segs]; const ordered = [left.shift()]; let at = ends(ordered[0])[1]; const startKey = key(ends(ordered[0])[0]);
  while (left.length) {
    const i = left.findIndex((g) => key(ends(g)[0]) === key(at) || key(ends(g)[1]) === key(at));
    if (i < 0) break;
    const g = left.splice(i, 1)[0], [e0, e1] = ends(g);
    ordered.push(g); at = key(e0) === key(at) ? e1 : e0;
  }
  if (left.length || key(at) !== startKey) throw new Error("Offset needs a closed loop (or circles). Select every segment of the loop");
  // walk direction & signed area for the outward side
  const pts = []; let cur = ends(ordered[0])[0];
  for (const g of ordered) { const [e0, e1] = ends(g); const fwd = key(e0) === key(cur); pts.push({ g, from: fwd ? e0 : e1, to: fwd ? e1 : e0, fwd }); cur = fwd ? e1 : e0; }
  let area = 0; for (const q of pts) area += q.from[0] * q.to[1] - q.to[0] * q.from[1]; // chord approximation is enough for the sign
  const outSign = area > 0 ? 1 : -1; // CCW loops: the outward normal is to the right of travel
  const curveOf = (q) => {
    if (q.g.t === "line") { const t = norm2([q.to[0] - q.from[0], q.to[1] - q.from[1]]), n = [t[1] * outSign, -t[0] * outSign]; return { k: "line", a: [q.from[0] + n[0] * d, q.from[1] + n[1] * d], b: [q.to[0] + n[0] * d, q.to[1] + n[1] * d] }; }
    const I = info(G, q.g), am = I.a0 + I.span / 2, pm = [I.c[0] + I.r * Math.cos(am), I.c[1] + I.r * Math.sin(am)], outDir = norm2([pm[0] - I.c[0], pm[1] - I.c[1]]);
    // is the loop's outward direction at the arc midpoint the same as the radial direction?
    const probe = [pm[0] + outDir[0] * 1e-3, pm[1] + outDir[1] * 1e-3];
    const radialIsOut = !insidePoly(probe, pts.map((x) => x.from));
    return { k: "circle", c: I.c, r: Math.max(1e-6, I.r + (radialIsOut ? d : -d)), arc: I };
  };
  const curves = pts.map(curveOf), n = curves.length, junction = [];
  for (let i = 0; i < n; i++) {
    const A = curves[i], B = curves[(i + 1) % n], J = pts[i].to;
    let cand = intersectFull(A, B);
    if (!cand.length) throw new Error("The offset collapses (distance too large for this loop)");
    cand.sort((x, y) => dist(x, [J[0], J[1]]) - dist(y, [J[0], J[1]]));
    junction.push(cand[0]);
  }
  const jp = junction.map((p) => addPoint(s, p));
  pts.forEach((q, i) => {
    const a = jp[(i - 1 + n) % n], b = jp[i];
    if (q.g.t === "line") { const id = addGeom(s, { t: "line", a, b }); addCons(s, { t: "parallel", a: id, b: q.g.id }); }
    else addGeom(s, q.fwd ? { t: "arc", c: q.g.c, s: a, e: b } : { t: "arc", c: q.g.c, s: b, e: a });
  });
  return s;
}
function insidePoly(p, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; }
/** Intersections of the infinite versions of two curves (lines extended). */
function intersectFull(A, B) {
  const ext = (X) => (X.k === "line" ? { ...X, a: [X.a[0] - (X.b[0] - X.a[0]) * 1e4, X.a[1] - (X.b[1] - X.a[1]) * 1e4], b: [X.b[0] + (X.b[0] - X.a[0]) * 1e4, X.b[1] + (X.b[1] - X.a[1]) * 1e4] } : { k: "circle", c: X.c, r: X.r });
  return intersect(ext(A), ext(B));
}
