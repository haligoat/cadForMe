// Constraint-based sketches (Onshape style): points, lines, circles and arcs plus constraints and
// dimensions, solved by FreeCAD's PlaneGCS (WebAssembly).
//
// sketch = { geom: [...], cons: [...] }
//   geom: {id,t:"point",x,y} {id,t:"line",a,b,construction?} {id,t:"circle",c,r,construction?}
//         {id,t:"arc",c,s,e,construction?}   (arc runs counter-clockwise from point s to point e)
//   cons: {id,t:"coincident"|"on"|"horizontal"|"vertical"|"parallel"|"perpendicular"|"equal"|"tangent"|
//               "midpoint"|"concentric"|"fix", a, b?}
//         {id,t:"dim",k:"length"|"dist"|"hdist"|"vdist"|"x"|"y"|"radius"|"diameter"|"angle"|"pdist", a, b?, v: number|expr}
import { init_planegcs_module, GcsWrapper, SolveStatus } from "@salusoft89/planegcs";

let gcs = null;
export async function initSolver(wasmBinary) {
  const mod = await init_planegcs_module({ wasmBinary });
  gcs = new GcsWrapper(new mod.GcsSystem(), mod);
  return gcs;
}
export const solverReady = () => !!gcs;

const byId = (geom) => new Map(geom.map((g) => [g.id, g]));
const isCurve = (g) => g && (g.t === "circle" || g.t === "arc");

function arcAngles(c, s, e) {
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  let a1 = Math.atan2(e.y - c.y, e.x - c.x);
  if (a1 <= a0) a1 += 2 * Math.PI;
  return [a0, a1];
}

/**
 * Solve a sketch. Returns { geom (solved copy), dof, ok, conflicting: [constraint ids], redundant: [...], errors: {id: msg} }.
 * `ev` evaluates dimension expressions. `drag` = {id: [x, y]} holds points at those positions while solving.
 */
export function solveSketch(sk, ev, { drag } = {}) {
  const geom = structuredClone(sk.geom ?? []);
  const cons = sk.cons ?? [];
  const errors = {};
  if (!gcs) throw new Error("Sketch solver isn't loaded yet");
  if (!geom.length) return { geom, dof: 0, ok: true, conflicting: [], redundant: [], errors };
  const G = byId(geom);
  const prims = [];
  for (const g of geom) if (g.t === "point") prims.push({ id: g.id, type: "point", x: g.x, y: g.y, fixed: !!drag?.[g.id] });
  if (drag) for (const g of prims) if (drag[g.id]) { g.x = drag[g.id][0]; g.y = drag[g.id][1]; }
  const P = (id) => G.get(id);
  for (const g of geom) {
    if (g.t === "line") prims.push({ id: g.id, type: "line", p1_id: g.a, p2_id: g.b });
    else if (g.t === "circle") prims.push({ id: g.id, type: "circle", c_id: g.c, radius: g.r });
    else if (g.t === "ellipse") prims.push({ id: g.id, type: "ellipse", c_id: g.c, focus1_id: g.f, radmin: g.r });
    else if (g.t === "arc") {
      const c = P(g.c), s = P(g.s), e = P(g.e);
      const [a0, a1] = arcAngles(c, s, e);
      prims.push({ id: g.id, type: "arc", c_id: g.c, start_id: g.s, end_id: g.e, radius: Math.hypot(s.x - c.x, s.y - c.y), start_angle: a0, end_angle: a1 });
      prims.push({ id: `${g.id}#rules`, type: "arc_rules", a_id: g.id });
    }
  }
  const idMap = new Map();
  const add = (c, p) => { const id = `c:${c.id}`; idMap.set(id, c.id); prims.push({ id, ...p }); };
  for (const c of cons) {
    const A = P(c.a), B = c.b ? P(c.b) : null;
    try {
      if (!A) throw new Error("references a missing shape");
      switch (c.t) {
        case "coincident": add(c, { type: "p2p_coincident", p1_id: c.a, p2_id: c.b }); break;
        case "on":
          if (B.t === "line") add(c, { type: "point_on_line_pl", p_id: c.a, l_id: c.b });
          else if (B.t === "circle") add(c, { type: "point_on_circle", p_id: c.a, c_id: c.b });
          else add(c, { type: "point_on_arc", p_id: c.a, a_id: c.b });
          break;
        case "horizontal": case "vertical": {
          const k = c.t === "horizontal" ? "horizontal" : "vertical";
          if (A.t === "line") add(c, { type: `${k}_l`, l_id: c.a }); else add(c, { type: `${k}_pp`, p1_id: c.a, p2_id: c.b });
          break;
        }
        case "parallel": add(c, { type: "parallel", l1_id: c.a, l2_id: c.b }); break;
        case "perpendicular": add(c, { type: "perpendicular_ll", l1_id: c.a, l2_id: c.b }); break;
        case "equal":
          if (A.t === "line") add(c, { type: "equal_length", l1_id: c.a, l2_id: c.b });
          else add(c, { type: "equal", param1: { o_id: c.a, prop: "radius" }, param2: { o_id: c.b, prop: "radius" } });
          break;
        case "tangent": {
          let [x, y] = [A, B], [xi, yi] = [c.a, c.b];
          if (x.t !== "line" && y.t === "line") { [x, y] = [y, x]; [xi, yi] = [yi, xi]; }
          if (x.t === "line") add(c, y.t === "circle" ? { type: "tangent_lc", l_id: xi, c_id: yi } : { type: "tangent_la", l_id: xi, a_id: yi });
          else if (x.t === "circle" && y.t === "circle") add(c, { type: "tangent_cc", c1_id: xi, c2_id: yi });
          else if (x.t === "arc" && y.t === "arc") add(c, { type: "tangent_aa", a1_id: xi, a2_id: yi });
          else { const [ci, ai] = x.t === "circle" ? [xi, yi] : [yi, xi]; add(c, { type: "tangent_ca", c_id: ci, a_id: ai }); }
          break;
        }
        case "midpoint":
          add({ id: `${c.id}a` }, { type: "point_on_line_pl", p_id: c.a, l_id: c.b });
          add({ id: `${c.id}b` }, { type: "point_on_perp_bisector_pl", p_id: c.a, l_id: c.b });
          idMap.set(`c:${c.id}a`, c.id); idMap.set(`c:${c.id}b`, c.id);
          break;
        case "symmetric": add(c, { type: "p2p_symmetric_ppl", p1_id: c.a, p2_id: c.b, l_id: c.l }); break;
        case "concentric": add(c, { type: "p2p_coincident", p1_id: A.c, p2_id: B.c }); break;
        case "fix":
          if (A.t === "point") { add({ id: `${c.id}x` }, { type: "coordinate_x", p_id: c.a, x: A.x }); add({ id: `${c.id}y` }, { type: "coordinate_y", p_id: c.a, y: A.y }); idMap.set(`c:${c.id}x`, c.id); idMap.set(`c:${c.id}y`, c.id); }
          break;
        case "dim": {
          const v = ev(c.v);
          switch (c.k) {
            case "length": add(c, { type: "p2p_distance", p1_id: A.a, p2_id: A.b, distance: Math.abs(v) }); break;
            case "dist": add(c, { type: "p2p_distance", p1_id: c.a, p2_id: c.b, distance: Math.abs(v) }); break;
            case "pdist": add(c, { type: "p2l_distance", p_id: c.a, l_id: c.b, distance: Math.abs(v) }); break;
            case "hdist": add(c, { type: "difference", param1: { o_id: c.a, prop: "x" }, param2: { o_id: c.b, prop: "x" }, difference: v }); break;
            case "vdist": add(c, { type: "difference", param1: { o_id: c.a, prop: "y" }, param2: { o_id: c.b, prop: "y" }, difference: v }); break;
            case "x": add(c, { type: "coordinate_x", p_id: c.a, x: v }); break;
            case "y": add(c, { type: "coordinate_y", p_id: c.a, y: v }); break;
            case "radius": add(c, A.t === "circle" ? { type: "circle_radius", c_id: c.a, radius: Math.abs(v) } : { type: "arc_radius", a_id: c.a, radius: Math.abs(v) }); break;
            case "diameter": add(c, A.t === "circle" ? { type: "circle_diameter", c_id: c.a, diameter: Math.abs(v) } : { type: "arc_diameter", a_id: c.a, diameter: Math.abs(v) }); break;
            case "angle": add(c, { type: "l2l_angle_ll", l1_id: c.a, l2_id: c.b, angle: (v * Math.PI) / 180 }); break;
            default: throw new Error(`unknown dimension ${c.k}`);
          }
          break;
        }
        default: throw new Error(`unknown constraint ${c.t}`);
      }
    } catch (e) { errors[c.id] = e.message; }
  }
  gcs.clear_data();
  gcs.push_primitives_and_params(prims);
  const status = gcs.solve();
  const ok = status === SolveStatus.Success || status === SolveStatus.Converged;
  const conflicting = [...new Set(gcs.get_gcs_conflicting_constraints?.().map((i) => idMap.get(i) ?? i) ?? [])];
  const redundant = [...new Set(gcs.get_gcs_redundant_constraints?.().map((i) => idMap.get(i) ?? i) ?? [])];
  let dof = 0;
  try { dof = gcs.gcs.dof(); } catch { /* unknown */ }
  if (ok || !conflicting.length) gcs.apply_solution();
  const out = new Map(gcs.sketch_index.get_primitives().map((p) => [p.id, p]));
  for (const g of geom) {
    const p = out.get(g.id);
    if (g.t === "point" && p) { g.x = p.x; g.y = p.y; }
    if (g.t === "circle" && p) g.r = p.radius;
    if (g.t === "ellipse" && p) g.r = p.radmin;
  }
  return { geom, dof, ok, conflicting, redundant, errors };
}

// ---------- profiles ----------
const key = (p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;

/** Lines and arcs of a solved sketch as edges, plus full circles as closed loops. */
function edgesAndCircles(geom) {
  const G = byId(geom);
  const loops = [], edges = [];
  for (const g of geom) {
    if (g.construction) continue;
    if (g.t === "circle") { const c = G.get(g.c); loops.push({ circle: { x: c.x, y: c.y, r: g.r }, pts: Array.from({ length: 48 }, (_, i) => [c.x + g.r * Math.cos((i / 48) * 2 * Math.PI), c.y + g.r * Math.sin((i / 48) * 2 * Math.PI)]) }); }
    else if (g.t === "ellipse") {
      const c = G.get(g.c), f = G.get(g.f), d = Math.hypot(f.x - c.x, f.y - c.y), b = g.r, a = Math.sqrt(b * b + d * d), rot = Math.atan2(f.y - c.y, f.x - c.x);
      loops.push({ ellipse: { x: c.x, y: c.y, a, b, rot }, pts: Array.from({ length: 72 }, (_, i) => { const t = (i / 72) * 2 * Math.PI, ex = a * Math.cos(t), ey = b * Math.sin(t); return [c.x + ex * Math.cos(rot) - ey * Math.sin(rot), c.y + ex * Math.sin(rot) + ey * Math.cos(rot)]; }) });
    }
    else if (g.t === "line") { const a = G.get(g.a), b = G.get(g.b); if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-9) edges.push({ id: g.id, k: "line", a, b }); }
    else if (g.t === "arc") {
      const c = G.get(g.c), s = G.get(g.s), e = G.get(g.e), r = Math.hypot(s.x - c.x, s.y - c.y);
      const [a0, a1] = arcAngles(c, s, e), m = (a0 + a1) / 2;
      edges.push({ id: g.id, k: "arc", a: s, b: e, via: { x: c.x + r * Math.cos(m), y: c.y + r * Math.sin(m) }, c, r, a0, a1 });
    }
  }
  return { loops, edges };
}

/** Closed loops made by the (non-construction) lines/arcs/circles of a solved sketch. */
export function loopsOf(geom) {
  const { loops, edges } = edgesAndCircles(geom);
  const open = [];
  const adj = new Map();
  edges.forEach((e, i) => { for (const p of [e.a, e.b]) { const k = key(p); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } });
  const used = new Set();
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    const segs = []; let cur = i, at = edges[i].a, ok = true;
    const startKey = key(at);
    for (;;) {
      used.add(cur);
      const e = edges[cur];
      const forward = key(e.a) === key(at);
      segs.push({ ...e, from: forward ? e.a : e.b, to: forward ? e.b : e.a });
      at = forward ? e.b : e.a;
      if (key(at) === startKey) break;
      const next = (adj.get(key(at)) ?? []).filter((j) => !used.has(j));
      if ((adj.get(key(at)) ?? []).length !== 2 || next.length !== 1) { ok = false; break; }
      cur = next[0];
    }
    if (!ok) { open.push(segs.map((s) => s.id)); continue; }
    const pts = [];
    for (const s of segs) {
      if (s.k === "line") pts.push([s.from.x, s.from.y]);
      else for (let t = 0; t < 12; t++) { const f = t / 12; const fwd = key(s.from) === key(s.a); const ang = fwd ? s.a0 + (s.a1 - s.a0) * f : s.a1 - (s.a1 - s.a0) * f; pts.push([s.c.x + s.r * Math.cos(ang), s.c.y + s.r * Math.sin(ang)]); }
    }
    loops.push({ segs, pts });
  }
  return { loops, open };
}

const inside = (pt, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/** Nesting depth of every loop: even = material, odd = hole. */
export function nestLoops(loops) {
  return loops.map((l, i) => {
    const probe = l.pts[Math.floor(l.pts.length / 3)];
    const depth = loops.reduce((n, o, j) => n + (j !== i && inside(probe, o.pts) ? 1 : 0), 0);
    return { ...l, depth };
  }).sort((a, b) => a.depth - b.depth);
}

/** Closed regions: each outer (even-depth) loop with the loops directly inside it as holes. */
export function regionsOf(geom) {
  const { loops } = loopsOf(geom);
  const all = nestLoops(loops);
  const regions = all.filter((l) => l.depth % 2 === 0).map((outer) => ({ outer, holes: [] }));
  for (const hole of all.filter((l) => l.depth % 2 === 1)) {
    const host = regions.filter((r) => inside(hole.pts[0], r.outer.pts)).sort((a, b) => b.outer.depth - a.outer.depth)[0];
    host?.holes.push(hole);
  }
  return regions;
}
export const inRegion = (r, pt) => inside(pt, r.outer.pts) && !r.holes.some((h) => inside(pt, h.pts));

function loopDrawing(R, l) {
  if (l.circle) return R.drawCircle(l.circle.r).translate(l.circle.x, l.circle.y);
  if (l.ellipse) { const e = l.ellipse; return R.drawEllipse(e.a, e.b).rotate((e.rot * 180) / Math.PI).translate(e.x, e.y); }
  let pen = R.draw([l.segs[0].from.x, l.segs[0].from.y]);
  l.segs.forEach((s, i) => {
    const end = i === l.segs.length - 1 ? [l.segs[0].from.x, l.segs[0].from.y] : [s.to.x, s.to.y];
    pen = s.k === "line" ? pen.lineTo(end) : pen.threePointsArcTo(end, [s.via.x, s.via.y]);
  });
  return pen.close();
}

/**
 * Build a replicad Drawing from solved geometry. With `regionPts` ([[x,y],...]) only the regions containing those
 * points are used (Onshape-style region selection); otherwise every loop (material fused, holes cut).
 */
export function profileDrawing(R, geom, regionPts) {
  const { loops, open } = loopsOf(geom);
  if (!loops.length) throw new Error(open.length ? "The sketch profile isn't closed. Close the gaps or mark stray lines as construction" : "Sketch has no closed shapes to use");
  if (regionPts?.length) {
    const chosen = regionsOf(geom).filter((r) => regionPts.some((p) => inRegion(r, p)));
    if (!chosen.length) throw new Error("The selected sketch region no longer exists. Pick the region again");
    let acc = null;
    for (const r of chosen) {
      let d = loopDrawing(R, r.outer);
      for (const h of r.holes) d = d.cut(loopDrawing(R, h));
      acc = acc ? acc.fuse(d) : d;
    }
    return acc;
  }
  let acc = null;
  for (const l of nestLoops(loops)) {
    const d = loopDrawing(R, l);
    acc = !acc ? d : l.depth % 2 === 0 ? acc.fuse(d) : acc.cut(d);
  }
  return acc;
}

/** An open (or closed) chain of lines/arcs as a replicad Drawing, for sweep paths. */
export function pathDrawing(R, geom) {
  const { edges } = edgesAndCircles(geom);
  if (!edges.length) throw new Error("The path sketch has no lines or arcs");
  const adj = new Map();
  edges.forEach((e, i) => { for (const p of [e.a, e.b]) { const k = key(p); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); } });
  if ([...adj.values()].some((l) => l.length > 2)) throw new Error("The path branches. A sweep path must be one continuous chain");
  const startKey = [...adj.entries()].find(([, l]) => l.length === 1)?.[0] ?? key(edges[0].a);
  const used = new Set(); const segs = []; let at = startKey;
  for (;;) {
    const next = (adj.get(at) ?? []).find((i) => !used.has(i));
    if (next === undefined) break;
    used.add(next);
    const e = edges[next], fwd = key(e.a) === at;
    segs.push({ ...e, from: fwd ? e.a : e.b, to: fwd ? e.b : e.a });
    at = key(fwd ? e.b : e.a);
  }
  if (used.size !== edges.length) throw new Error("The path is in separate pieces. Join them into one chain");
  let pen = R.draw([segs[0].from.x, segs[0].from.y]);
  for (const s of segs) pen = s.k === "line" ? pen.lineTo([s.to.x, s.to.y]) : pen.threePointsArcTo([s.to.x, s.to.y], [s.via.x, s.via.y]);
  return key(segs.at(-1).to) === key(segs[0].from) ? pen.close() : pen.done();
}
