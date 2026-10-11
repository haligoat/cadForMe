// cadSlop geometry engine: builds a part (variables + ordered features) into solids.
// Pure module: the caller supplies an initialised OpenCascade instance via init(oc).
import * as R from "replicad";
import { makeEvaluator } from "./expr.js";
import { dot, norm, perpendicular, sketchFrame, planeFrame, cross } from "./vec.js";
import { solveSketch, profileDrawing, pathDrawing } from "./sketch2.js";

export { perpendicular };

export function init(oc) { R.setOC(oc); }

const MATCH_TOL = 0.15;

const vec = (v) => (v && v.toTuple ? v.toTuple() : v);
function planeOf(sk, ev, ctx) {
  const f = sketchFrame(sk, ev, ctx?.planes);
  return new R.Plane(f.origin, f.x, f.n);
}

function entityDrawing(e, ev) {
  const cx = ev.opt(e.cx, 0), cy = ev.opt(e.cy, 0);
  const angle = ev.opt(e.angle, 0);
  let d;
  switch (e.type) {
    case "rect": {
      const w = ev(e.w), h = ev(e.h), r = ev.opt(e.r, 0);
      d = r > 0 ? R.drawRoundedRectangle(w, h, Math.min(r, Math.min(w, h) / 2 - 1e-6)) : R.drawRectangle(w, h);
      break;
    }
    case "circle": d = R.drawCircle(ev(e.r)); break;
    case "ellipse": d = R.drawEllipse(ev(e.rx), ev(e.ry)); break;
    case "polygon": d = R.drawPolysides(ev(e.r), Math.round(ev(e.sides))); break;
    case "slot": {
      const len = ev(e.length), w = ev(e.width);
      d = R.drawRoundedRectangle(len, w, w / 2 - 1e-6);
      break;
    }
    case "spline": {
      // smooth B-spline through the points (closed), e.g. organic profiles
      const pts = e.points.map((p) => ev.vec(p, [0, 0]));
      if (pts.length < 4) throw new Error("A spline needs at least 4 points");
      return R.drawPointsInterpolation(pts, { tolerance: 1e-3, degMax: 3 }, { closeShape: true });
    }
    case "polyline": {
      const pts = e.points.map((p) => ev.vec(p, [0, 0]));
      if (pts.length < 3) throw new Error("Polyline needs at least 3 points");
      let pen = R.draw(pts[0]);
      for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
      return pen.close();
    }
    default: throw new Error(`Unknown sketch entity "${e.type}"`);
  }
  if (angle) d = d.rotate(angle);
  return d.translate(cx, cy);
}

/** Combine a sketch's constrained geometry and legacy shapes (add / subtract) into one drawing. */
function sketchDrawing(sk, ev, regions) {
  const ents = sk.entities ?? [];
  let acc = null;
  if (sk.geom?.length) acc = profileDrawing(R, solveSketch(sk, ev).geom, regions);
  for (const e of ents.filter((x) => (x.op ?? "add") === "add")) {
    const d = entityDrawing(e, ev);
    acc = acc ? acc.fuse(d) : d;
  }
  if (!acc) throw new Error("Sketch has no shapes to use");
  for (const e of ents.filter((x) => x.op === "subtract")) acc = acc.cut(entityDrawing(e, ev));
  return acc;
}

/** Points on edges/faces are stored as references; match them back to topology. */
function findEdges(shape, refs) {
  const verts = refs.map((r) => R.makeVertex(r.p));
  const out = shape.edges.filter((e) => verts.some((v) => R.measureDistanceBetween(e, v) < MATCH_TOL * 0.1));
  verts.forEach((v) => v.delete());
  return out;
}

function findFaces(shape, refs) {
  return shape.faces.filter((f) => refs.some((r) => {
    const v = R.makeVertex(r.p);
    const d = R.measureDistanceBetween(f, v);
    v.delete();
    if (d > MATCH_TOL) return false;
    if (!r.n) return true;
    return dot(vec(f.normalAt(r.p)), r.n) > 0.9;
  }));
}

const touches = (a, b) => R.measureDistanceBetween(a, b) < 1e-6;

/** Apply a solid produced by a feature to the body list, honouring merge mode. */
function applyMode(bodies, tool, mode) {
  switch (mode ?? "add") {
    case "new": return [...bodies, tool];
    case "cut": {
      if (!bodies.length) throw new Error("Nothing to cut: no bodies yet");
      return bodies.map((b) => b.cut(tool));
    }
    case "intersect": {
      if (!bodies.length) throw new Error("Nothing to intersect: no bodies yet");
      return bodies.map((b) => b.intersect(tool));
    }
    case "add": default: {
      const hit = bodies.filter((b) => touches(b, tool));
      if (!hit.length) return [...bodies, tool];
      const rest = bodies.filter((b) => !hit.includes(b));
      let merged = tool;
      for (const h of hit) merged = merged.fuse(h);
      return [...rest, merged];
    }
  }
}

function pickBodies(bodies, sel) {
  if (sel === undefined || sel === "all") return bodies.map((_, i) => i);
  const a = Array.isArray(sel) ? sel : [sel];
  return a.map(Number).filter((i) => i >= 0 && i < bodies.length);
}

const defaultMode = (f, ctx) => f.mode ?? (ctx.bodies.length ? "add" : "new");

const HANDLERS = {
  gear(f, ctx) {
    const m = ctx.ev(f.module ?? 1), z = Math.round(ctx.ev(f.teeth ?? 20)), th = ctx.ev(f.thickness ?? 5), alpha = (ctx.ev.opt(f.pressure, 20) * Math.PI) / 180, bore = ctx.ev.opt(f.bore, 0);
    if (z < 6) throw new Error("A gear needs at least 6 teeth");
    if (!(m > 0) || !(th > 0)) throw new Error("Module and thickness must be positive");
    const rp = (m * z) / 2, rb = rp * Math.cos(alpha), ra = rp + m, rf = Math.max(rp - 1.25 * m, 0.1 * m);
    const inv = (a) => Math.tan(a) - a, half = Math.PI / (2 * z), rStart = Math.max(rb, rf);
    const tOf = (r) => Math.sqrt(Math.max(0, (r / rb) ** 2 - 1)); // involute roll angle at radius r
    const phiBase = half + inv(alpha); // angle of the involute's start relative to the tooth centre
    const pts = [], N = 9, pitchAng = (2 * Math.PI) / z;
    for (let k = 0; k < z; k++) {
      const c = pitchAng * k;
      const right = [], left = [];
      for (let i = 0; i <= N; i++) {
        const r = rStart + ((ra - rStart) * i) / N, t = tOf(r), ang = t - Math.atan(t); // polar angle of the involute at radius r
        right.push([r, c - (phiBase - ang)]); left.push([r, c + (phiBase - ang)]);
      }
      if (rf < rStart - 1e-9) pts.push([rf, c - phiBase]); // radial flank below the base circle
      pts.push(...right, ...left.reverse());
      if (rf < rStart - 1e-9) pts.push([rf, c + phiBase]);
      // root circle to the next tooth
      const a0 = c + phiBase, a1 = c + pitchAng - phiBase;
      for (let i = 1; i <= 2; i++) pts.push([Math.min(rf, rStart), a0 + ((a1 - a0) * i) / 3]);
    }
    const xy = pts.map(([r, a]) => [r * Math.cos(a), r * Math.sin(a)]);
    let pen = R.draw(xy[0]);
    for (let i = 1; i < xy.length; i++) pen = pen.lineTo(xy[i]);
    let solid = pen.close().sketchOnPlane("XY").extrude(th);
    if (bore > 0) solid = solid.cut(R.drawCircle(bore / 2).sketchOnPlane("XY").extrude(th));
    solid = solid.translate(ctx.ev.vec(f.position, [0, 0, 0]));
    // split: one body per solid in the file (so single parts of an imported assembly can be cut, mirrored, coloured)
    if (f.split) { ctx.bodies = [...ctx.bodies, ...Array.from(R.iterTopo(solid.wrapped, "solid"), (w) => new R.Solid(w))]; return; }
    ctx.bodies = applyMode(ctx.bodies, solid, f.mode ?? "new");
  },

  coil(f, ctx) {
    const r = ctx.ev(f.radius ?? 10), pitch = ctx.ev(f.pitch ?? 5), height = ctx.ev(f.height ?? 30), wire = ctx.ev(f.wire ?? 2);
    if (wire >= pitch) throw new Error("The wire must be thinner than the pitch, or the coils overlap");
    const helix = R.makeHelix(pitch, height, r);
    const prof = R.drawCircle(wire / 2).translate(0, 0).sketchOnPlane(new R.Plane([r, 0, 0], [0, 0, 1], [0, 1, 0]));
    let solid = R.genericSweep(prof.wire, helix, { frenet: true });
    solid = solid.translate(ctx.ev.vec(f.position, [0, 0, 0]));
    // split: one body per solid in the file (so single parts of an imported assembly can be cut, mirrored, coloured)
    if (f.split) { ctx.bodies = [...ctx.bodies, ...Array.from(R.iterTopo(solid.wrapped, "solid"), (w) => new R.Solid(w))]; return; }
    ctx.bodies = applyMode(ctx.bodies, solid, f.mode ?? "new");
  },

  mate() { /* assembly mates are solved in the editor; they place instances, they don't make geometry */ },
  insert(f, ctx) {
    const sub = ctx.parts?.get(f.part);
    if (!sub) throw new Error(`Part "${f.part}" couldn't be loaded. Is it still in the project?`);
    if ((ctx.depth ?? 0) >= 6) throw new Error("Parts are inserted too deeply. Is there a loop (a part inserting itself)?");
    const vars = {};
    for (const [k, v] of Object.entries(f.vars ?? {})) vars[k] = typeof v === "number" ? v : ctx.ev(v); // parent variables can drive the instance
    // build each (part, overrides) once per rebuild and reuse copies: assemblies often insert the same part many times
    const key = `${f.part}|${JSON.stringify(vars)}`;
    let cached = ctx.cache.get(key);
    if (!cached) { cached = buildPart(sub, { imports: ctx.imports, parts: ctx.parts, depth: (ctx.depth ?? 0) + 1, vars, cache: ctx.cache }); ctx.cache.set(key, cached); }
    const r = { errors: cached.errors, bodies: cached.bodies.map((b) => b.clone()) };
    const bad = Object.entries(r.errors)[0];
    if (bad) { r.bodies.forEach((b) => b.delete()); throw new Error(`Inserted part "${f.part}" has an error: ${bad[1]}`); }
    const k = ctx.ev.opt(f.scale, 1), rot = ctx.ev.opt(f.rotate, 0), axis = ctx.ev.vec(f.axis, [0, 0, 1]), origin = ctx.ev.vec(f.origin, [0, 0, 0]), move = ctx.ev.vec(f.position, [0, 0, 0]);
    let bodies = ctx.bodies;
    for (let b of r.bodies) {
      if (k !== 1) b = b.scale(k, origin);
      if (rot) b = b.rotate(rot, origin, axis);
      if (f.orient) { const [ox, oy, oz] = ctx.ev.vec(f.orient, [0, 0, 0]); if (ox) b = b.rotate(ox, [0, 0, 0], [1, 0, 0]); if (oy) b = b.rotate(oy, [0, 0, 0], [0, 1, 0]); if (oz) b = b.rotate(oz, [0, 0, 0], [0, 0, 1]); }
      bodies = applyMode(bodies, b.translate(move), f.mode ?? "new");
    }
    ctx.bodies = bodies;
  },
  import(f, ctx) {
    const src = ctx.imports?.get(f.file);
    if (!src) throw new Error(`Imported file "${f.file}" couldn't be loaded. Is it still in the project folder?`);
    let solid = src.clone();
    const k = ctx.ev.opt(f.scale, 1);
    if (k !== 1) solid = solid.scale(k, [0, 0, 0]);
    // anchor: the point of the file that lands on `position`; orient: [x, y, z] degrees about X, then Y, then Z (about the anchor)
    if (f.anchor) { const a = ctx.ev.vec(f.anchor, [0, 0, 0]); solid = solid.translate([-a[0], -a[1], -a[2]]); }
    if (f.orient) { const [ox, oy, oz] = ctx.ev.vec(f.orient, [0, 0, 0]); if (ox) solid = solid.rotate(ox, [0, 0, 0], [1, 0, 0]); if (oy) solid = solid.rotate(oy, [0, 0, 0], [0, 1, 0]); if (oz) solid = solid.rotate(oz, [0, 0, 0], [0, 0, 1]); }
    solid = solid.translate(ctx.ev.vec(f.position, [0, 0, 0]));
    // split: one body per solid in the file (so single parts of an imported assembly can be cut, mirrored, coloured)
    if (f.split) { ctx.bodies = [...ctx.bodies, ...Array.from(R.iterTopo(solid.wrapped, "solid"), (w) => new R.Solid(w))]; return; }
    ctx.bodies = applyMode(ctx.bodies, solid, f.mode ?? "new");
  },
  sketch() { /* data only; consumed by extrude / revolve */ },
  onshape() { /* exists only in Onshape; kept untouched, not modelled here */ },

  extrude(f, ctx) {
    const sk = ctx.sketch(f.sketch);
    const plane = planeOf(sk, ctx.ev, ctx);
    const dir = vec(plane.zDir);
    const dist = ctx.ev.opt(f.distance, 10) * (f.flip ? -1 : 1);
    const draft = ctx.ev.opt(f.draft, 0);
    const sketch = sketchDrawing(sk, ctx.ev, f.regions).sketchOnPlane(plane);
    const shift = (s, k) => s.translate(dir.map((c) => c * k));
    let solid;
    if (f.through) {
      const L = 1e4;
      solid = shift(sketch.extrude(L * 2), -L);
    } else if (draft) {
      // true draft: loft from the profile to an offset copy of it at the far end
      if (sketch.constructor.name !== "Sketch") throw new Error("Draft works on a single outline without holes. Remove the holes or set the draft angle to 0");
      const depth = Math.abs(dist), sign = dist < 0 ? -1 : 1;
      const delta = -Math.tan((draft * Math.PI) / 180) * depth;
      const base = sketch.wire;
      const top = R.sketchFaceOffset(sketch.clone().face(), delta).wire.translate(dir.map((c) => c * depth * sign));
      solid = R.loft([base, top], { ruled: true });
    } else {
      const len = Math.abs(dist);
      solid = sketch.extrude(len, f.twist ? { twistAngle: ctx.ev(f.twist) } : undefined);
      if (f.symmetric) solid = shift(solid, -len / 2);
      else if (dist < 0) solid = shift(solid, -len);
    }
    ctx.bodies = applyMode(ctx.bodies, solid, defaultMode(f, ctx));
  },

  plane(f, ctx) {
    ctx.planes.set(f.id, planeFrame(f, ctx.ev, ctx.planes));
  },

  loft(f, ctx) {
    const ids = f.sketches ?? [];
    if (ids.length < 2) throw new Error("A loft needs at least two sketches");
    const profiles = ids.map((id) => { const sk = ctx.sketch(id); return sketchDrawing(sk, ctx.ev).sketchOnPlane(planeOf(sk, ctx.ev, ctx)); });
    const [first, ...rest] = profiles;
    ctx.bodies = applyMode(ctx.bodies, first.loftWith(rest, { ruled: !!f.ruled }), defaultMode(f, ctx));
  },

  sweep(f, ctx) {
    const psk = ctx.sketch(f.profile), tsk = ctx.sketch(f.path);
    if (!psk.geom?.length && !psk.entities?.length) throw new Error("The profile sketch is empty");
    const profile = sketchDrawing(psk, ctx.ev).sketchOnPlane(planeOf(psk, ctx.ev, ctx));
    if (profile.constructor.name !== "Sketch") throw new Error("A sweep profile must be a single outline without holes");
    const path = pathDrawing(R, solveSketch(tsk, ctx.ev).geom).sketchOnPlane(planeOf(tsk, ctx.ev, ctx));
    ctx.bodies = applyMode(ctx.bodies, R.genericSweep(profile.wire, path.wire, {}), defaultMode(f, ctx));
  },

  split(f, ctx) {
    const o = ctx.ev.vec(f.origin, [0, 0, 0]), n = norm(ctx.ev.vec(f.normal, [0, 0, 1]));
    const plane = new R.Plane(o, perpendicular(n), n), L = 1e5;
    const half = (k) => { const s = R.drawRectangle(2 * L, 2 * L).sketchOnPlane(plane).extrude(L); return k > 0 ? s : s.translate(n.map((c) => -c * L)); };
    const keep = f.keep ?? "both", out = [], idx = new Set(pickBodies(ctx.bodies, f.body));
    ctx.bodies.forEach((b, i) => {
      if (!idx.has(i)) { out.push(b); return; }
      if (keep !== "below") { const a = b.clone().intersect(half(1)); if (R.measureVolume(a) > 1e-6) out.push(a); }
      if (keep !== "above") { const c = b.clone().intersect(half(-1)); if (R.measureVolume(c) > 1e-6) out.push(c); }
    });
    if (out.length === ctx.bodies.length && keep === "both" && out.every((b, i) => b === ctx.bodies[i])) throw new Error("The split plane doesn't cut any body");
    ctx.bodies = out;
  },

  revolve(f, ctx) {
    const sk = ctx.sketch(f.sketch);
    const plane = planeOf(sk, ctx.ev, ctx);
    const angle = ctx.ev.opt(f.angle, 360);
    const axisDir = vec(f.axis === "Y" ? plane.yDir : plane.xDir);
    const sketch = sketchDrawing(sk, ctx.ev, f.regions).sketchOnPlane(plane);
    const solid = sketch.revolve(axisDir, { origin: vec(plane.origin), angle });
    ctx.bodies = applyMode(ctx.bodies, solid, defaultMode(f, ctx));
  },

  box(f, ctx) {
    const [x, y, z] = ctx.ev.vec(f.position, [0, 0, 0]);
    const w = ctx.ev(f.w), d = ctx.ev(f.d), h = ctx.ev(f.h);
    const solid = R.makeBox([x - w / 2, y - d / 2, z], [x + w / 2, y + d / 2, z + h]);
    ctx.bodies = applyMode(ctx.bodies, solid, f.mode ?? "new");
  },

  cylinder(f, ctx) {
    const pos = ctx.ev.vec(f.position, [0, 0, 0]);
    const solid = R.makeCylinder(ctx.ev(f.r), ctx.ev(f.h), pos, ctx.ev.vec(f.direction, [0, 0, 1]));
    ctx.bodies = applyMode(ctx.bodies, solid, f.mode ?? "new");
  },

  sphere(f, ctx) {
    const solid = R.makeSphere(ctx.ev(f.r)).translate(ctx.ev.vec(f.position, [0, 0, 0]));
    ctx.bodies = applyMode(ctx.bodies, solid, f.mode ?? "new");
  },

  fillet(f, ctx) { edgeOp(f, ctx, (shape, r, finder) => shape.fillet(r, finder)); },
  chamfer(f, ctx) { edgeOp(f, ctx, (shape, r, finder) => shape.chamfer(r, finder)); },

  shell(f, ctx) {
    const t = ctx.ev(f.thickness);
    let any = false;
    ctx.bodies = ctx.bodies.map((b) => {
      const faces = findFaces(b, f.faces ?? []);
      if (!faces.length) return b;
      any = true;
      return b.shell(t, (fi) => fi.when(({ element }) => faces.some((x) => x.isSame(element))));
    });
    if (!any) throw new Error("Shell: no faces found. Pick the face(s) to open");
  },

  hole(f, ctx) {
    const o = ctx.ev.vec(f.position);
    const n = norm(ctx.ev.vec(f.normal, [0, 0, 1]));
    const depth = f.through ? 1e4 : ctx.ev(f.depth);
    const plane = new R.Plane(o, perpendicular(n), n);
    const cyl = (dia, d) => R.drawCircle(dia / 2).sketchOnPlane(plane).extrude(d).translate(n.map((c) => -c * d));
    let tool = cyl(ctx.ev(f.diameter), depth);
    if (f.style === "counterbore") tool = tool.fuse(cyl(ctx.ev(f.cboreDiameter), ctx.ev(f.cboreDepth)));
    if (f.style === "countersink") {
      const D = ctx.ev(f.csinkDiameter ?? ctx.ev(f.diameter) * 2), d = ctx.ev(f.diameter), ang = ctx.ev.opt(f.csinkAngle, 90);
      const h = Math.max(0.01, (D - d) / 2 / Math.tan((ang * Math.PI) / 360));
      const top = R.drawCircle(D / 2).sketchOnPlane(plane).wire, bot = R.drawCircle(d / 2).sketchOnPlane(new R.Plane(o.map((c, i) => c - n[i] * h), perpendicular(n), n)).wire;
      tool = tool.fuse(R.loft([top, bot], { ruled: true }));
    }
    ctx.bodies = applyMode(ctx.bodies, tool, "cut");
  },

  linearPattern(f, ctx) {
    const dir = norm(ctx.ev.vec(f.direction, [1, 0, 0]));
    const dist = ctx.ev(f.distance), count = Math.max(1, Math.round(ctx.ev(f.count)));
    const count2 = Math.max(1, Math.round(ctx.ev.opt(f.count2, 1))), dir2 = norm(ctx.ev.vec(f.direction2, [0, 1, 0])), dist2 = ctx.ev.opt(f.distance2, 0);
    const offsets = [];
    for (let j = 0; j < count2; j++) for (let i = 0; i < count; i++) offsets.push([0, 1, 2].map((a) => dir[a] * dist * i + dir2[a] * dist2 * j));
    patternOp(f, ctx, (src, k) => src.translate(offsets[k]), offsets.length);
  },

  circularPattern(f, ctx) {
    const axis = ctx.ev.vec(f.axis, [0, 0, 1]);
    const origin = ctx.ev.vec(f.origin, [0, 0, 0]);
    const count = Math.max(1, Math.round(ctx.ev(f.count)));
    const total = ctx.ev.opt(f.angle, 360);
    const step = total / (total >= 360 ? count : Math.max(1, count - 1));
    patternOp(f, ctx, (src, i) => src.rotate(step * i, origin, axis), count);
  },

  mirror(f, ctx) {
    const n = norm(ctx.ev.vec(f.normal, [1, 0, 0]));
    const o = ctx.ev.vec(f.origin, [0, 0, 0]);
    patternOp(f, ctx, (src) => src.mirror(n, o), 2);
  },

  transform(f, ctx) {
    const idx = pickBodies(ctx.bodies, f.body);
    const move = ctx.ev.vec(f.translate, [0, 0, 0]);
    const rot = ctx.ev.opt(f.rotate, 0);
    const axis = ctx.ev.vec(f.axis, [0, 0, 1]);
    const origin = ctx.ev.vec(f.origin, [0, 0, 0]);
    const out = [...ctx.bodies];
    const added = [];
    idx.forEach((i) => {
      let s = ctx.bodies[i].clone();
      const k = ctx.ev.opt(f.scale, 1);
      if (k !== 1) s = s.scale(k, origin);
      if (rot) s = s.rotate(rot, origin, axis);
      s = s.translate(move);
      if (f.copy) added.push(s); else out[i] = s;
    });
    ctx.bodies = [...out, ...added];
  },

  boolean(f, ctx) {
    const a = Number(f.a), b = Number(f.b);
    const A = ctx.bodies[a], B = ctx.bodies[b];
    if (!A || !B || a === b) throw new Error("Boolean: pick two different bodies");
    const op = f.op ?? "union";
    const res = op === "subtract" ? A.cut(B) : op === "intersect" ? A.intersect(B) : A.fuse(B);
    // the result takes body a's place (so other body numbers don't shift); body b is used up
    ctx.bodies = ctx.bodies.map((x, i) => (i === a ? res : x)).filter((_, i) => i !== b);
    ctx.owners = ctx.owners.filter((_, i) => i !== b); ctx.ownersDone = true;
  },

  deleteBody(f, ctx) {
    const drop = new Set(pickBodies(ctx.bodies, f.body));
    ctx.bodies = ctx.bodies.filter((_, i) => !drop.has(i));
    ctx.owners = ctx.owners.filter((_, i) => !drop.has(i)); ctx.ownersDone = true;   // keep each remaining body's owner
  },
};

function edgeOp(f, ctx, fn) {
  const r = ctx.ev(f.radius ?? f.distance);
  let any = false;
  ctx.bodies = ctx.bodies.map((b) => {
    const edges = findEdges(b, f.edges ?? []);
    if (!edges.length) return b;
    any = true;
    return fn(b, r, (fi) => fi.when(({ element }) => edges.some((x) => x.isSame(element))));
  });
  if (!any) throw new Error("No edges found. Pick the edges again");
}

/** Copies of each selected body, generated by gen(clone, k) for k = 1..count-1. */
function patternOp(f, ctx, gen, count) {
  const idx = pickBodies(ctx.bodies, f.body);
  const merge = f.merge !== false;
  const out = [...ctx.bodies];
  const added = [];
  idx.forEach((i) => {
    let acc = ctx.bodies[i];
    for (let k = 1; k < count; k++) {
      const copy = gen(ctx.bodies[i].clone(), k);
      if (merge) acc = acc.fuse(copy); else added.push(copy);
    }
    out[i] = acc;
  });
  ctx.bodies = [...out, ...added];
}

/** Build a part into solids. `upTo` (feature index) gives the rollback position. */
/** Readable text for an error, including crashes inside the OpenCascade kernel (which have no message). */
function kernelMessage(e, f) {
  if (e instanceof Error && e.message) return e.message;
  const hint = { shell: "the wall is probably too thick for the shape, or a face is too curved. Try a thinner wall", fillet: "the radius is probably too big for these edges. Try a smaller radius", chamfer: "the distance is probably too big for these edges", boolean: "the bodies may not overlap cleanly" }[f.type] ?? "check its sizes and references";
  return `The geometry kernel couldn't build this ${f.type}: ${hint}`;
}

/** Variables with the active configuration's overrides applied. */
export const effectiveVariables = (part) => ({ ...(part.variables ?? {}), ...(part.configs?.[part.config] ?? {}) });

export function buildPart(part, { upTo, imports, parts, depth = 0, vars, cache, timings } = {}) {
  const ownCache = !cache; cache ??= new Map();
  const ev = makeEvaluator({ ...effectiveVariables(part), ...(vars ?? {}) });
  const features = part.features ?? [];
  const sketches = new Map();
  const errors = {};
  const ctx = {
    ev, bodies: [], owners: [], imports, parts, depth, cache, planes: new Map(),
    sketch(id) { const s = sketches.get(id); if (!s) throw new Error(`Sketch "${id}" not found (is it above this feature?)`); return s; },
  };
  const limit = upTo === undefined ? features.length : upTo + 1;
  features.slice(0, limit).forEach((f) => {
    if (f.suppressed) return;
    if (f.type === "sketch") { sketches.set(f.id, f); return; }
    const h = HANDLERS[f.type];
    if (!h) { errors[f.id] = `Unknown feature type "${f.type}"`; return; }
    const before = ctx.bodies;
    const t0 = timings ? performance.now() : 0;
    try {
      h(f, ctx);
      if (timings) timings.push([f.id, f.name ?? f.type, performance.now() - t0]);
      // Remember which feature first made each body (new bodies are appended; merges keep earlier owners).
      if (ctx.ownersDone) ctx.ownersDone = false;
      else if (ctx.bodies !== before) {
        const n = ctx.bodies.length;
        ctx.owners = n >= ctx.owners.length ? [...ctx.owners, ...Array(n - ctx.owners.length).fill(f.id)] : ctx.owners.slice(0, n);
      }
    }
    catch (e) { ctx.bodies = before; errors[f.id] = kernelMessage(e, f); }
  });
  if (ownCache) for (const c of cache.values()) c.bodies.forEach((b) => { try { b.delete(); } catch { /* freed */ } });
  return { bodies: ctx.bodies, owners: ctx.owners, errors, variables: ev.variables() };
}

export function meshBodies(bodies, { tolerance = 0.05, angularTolerance = 0.2 } = {}) {
  return bodies.map((b, index) => {
    const m = b.mesh({ tolerance, angularTolerance });
    const e = b.meshEdges({ tolerance, angularTolerance });
    return {
      index,
      vertices: Float32Array.from(m.vertices),
      normals: Float32Array.from(m.normals),
      triangles: Uint32Array.from(m.triangles),
      faceGroups: m.faceGroups,
      lines: Float32Array.from(e.lines),
      edgeGroups: e.edgeGroups,
    };
  });
}

export function measure(bodies, density) {
  const withArea = bodies.length <= 250;                 // surface area is a full extra pass: skip it on very large models
  return bodies.map((b, index) => {
    const bb = b.boundingBox.bounds;
    let com = null, volume;
    try { const p = R.measureShapeVolumeProperties(b); com = p.centerOfMass; volume = p.volume ?? p.mass; } catch { /* not available */ }
    if (typeof volume !== "number") volume = R.measureVolume(b);
    return {
      index, com, mass: density ? (volume / 1000) * density : null,
      volume,
      area: withArea ? R.measureArea(b) : null,
      bounds: bb,
      size: [bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]],
    };
  });
}

export function exportSTL(bodies) {
  return R.makeCompound(bodies.map((b) => b.clone())).blobSTL({ tolerance: 0.02, angularTolerance: 0.1, binary: true });
}

export function exportSTEP(bodies) {
  return R.exportSTEP(bodies.map((shape, i) => ({ shape, name: `body${i + 1}` })));
}

export const FEATURE_TYPES = Object.keys(HANDLERS);

/** Load the STEP files an import feature needs (async because the kernel reads them as blobs). Dispose with disposeImports. */
export async function loadImports(part, files) {
  const out = new Map();
  for (const f of part.features ?? []) {
    if (f.type !== "import" || f.suppressed || out.has(f.file) || !files?.[f.file]) continue;
    try { out.set(f.file, await R.importSTEP(new Blob([files[f.file]]))); } catch { /* reported by the feature */ }
  }
  return out;
}
export const disposeImports = (m) => m?.forEach((s) => { try { s.delete(); } catch { /* freed */ } });

const decode = (b) => (typeof b === "string" ? b : new TextDecoder().decode(b));
/** Find every part reachable through "insert" features. files maps project path -> bytes/text. Returns Map path -> part object. */
export function collectParts(part, files, out = new Map(), depth = 0) {
  if (depth > 6) return out;
  for (const f of part.features ?? []) {
    if (f.type !== "insert" || f.suppressed || !f.part || out.has(f.part) || !files?.[f.part]) continue;
    try { const sub = JSON.parse(decode(files[f.part])); out.set(f.part, sub); collectParts(sub, files, out, depth + 1); } catch { /* reported by the feature */ }
  }
  return out;
}

// ---------- engineering drawing (SVG sheet) ----------
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SCALES = [10, 5, 2, 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.025, 0.02, 0.01, 0.005];
const fmtScale = (s) => { const r = (x) => (Math.abs(x - Math.round(x)) < 0.01 ? String(Math.round(x)) : x.toFixed(1)); return s >= 1 ? `${r(s)}:1` : `1:${r(1 / s)}`; };

function projectView(shape, which) {
  let proj;
  if (which === "iso") { const cam = new R.ProjectionCamera([0, 0, 0], [-1, 1, -0.8]); cam.autoAxes(); proj = R.drawProjection(shape, cam); }
  else proj = R.drawProjection(shape, which);
  const flat = (d) => d.toSVGPaths().flat(Infinity).filter((x) => typeof x === "string");
  const [[x0, y0], [x1, y1]] = proj.visible.boundingBox.bounds;
  return { vis: flat(proj.visible), hid: flat(proj.hidden), x0, x1, y0: -y1, y1: -y0, w: x1 - x0, h: y1 - y0 }; // y flipped for SVG
}

/** A three-view + isometric drawing of the bodies on an A3 landscape sheet. Returns SVG text. */
export function makeDrawing(bodies, { name = "Part", material = "", mass = null, date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!bodies.length) throw new Error("Nothing to draw: the part has no solid bodies");
  const shape = R.makeCompound(bodies.map((b) => b.clone()));
  const SW = 420, SH = 297, M = 12, TB = 30;
  const V = { front: projectView(shape, "front"), top: projectView(shape, "top"), right: projectView(shape, "right"), iso: projectView(shape, "iso") };
  shape.delete();
  const gap = 28, areaW = SW - 2 * M, areaH = SH - 2 * M - TB;
  const fits = (s) => (V.front.w + V.right.w) * s + gap + 30 <= areaW * 0.68 && (V.front.h + V.top.h) * s + gap + 24 <= areaH;
  const s = SCALES.find(fits) ?? SCALES.at(-1);
  const isoMax = Math.min(areaW * 0.28, areaH * 0.45);
  const sIso = Math.min(s, isoMax / Math.max(V.iso.w, V.iso.h, 1e-6));
  // third-angle layout: top above front, right to the right of front
  const fw = V.front.w * s, fh = V.front.h * s, tw = V.top.w * s, th = V.top.h * s, rw = V.right.w * s;
  const left = M + 18, bottom = SH - M - TB - 18;
  const place = { front: [left + 12, bottom - fh], top: [left + 12 + (fw - tw) / 2, bottom - fh - gap - th], right: [left + 12 + fw + gap, bottom - fh] };
  const stroke = 0.35;
  const group = (v, x, y, k) => `<g transform="translate(${(x - v.x0 * k).toFixed(3)} ${(y - v.y0 * k).toFixed(3)}) scale(${k})">`
    + `<path d="${v.hid.join(" ")}" fill="none" stroke="#7a7a7a" stroke-width="${(0.2 / k).toFixed(4)}" stroke-dasharray="${(2.2 / k).toFixed(3)} ${(1.4 / k).toFixed(3)}"/>`
    + `<path d="${v.vis.join(" ")}" fill="none" stroke="#111" stroke-width="${(stroke / k).toFixed(4)}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  const text = (x, y, t, size = 3.5, anchor = "middle", extra = "") => `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" text-anchor="${anchor}" ${/fill=/.test(extra) ? "" : 'fill="#111"'} ${extra}>${esc(t)}</text>`;
  const line = (x1, y1, x2, y2, w = 0.18) => `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#111" stroke-width="${w}"/>`;
  const dimH = (x1, x2, y, value, off = 9) => { const yy = y + off; return `${line(x1, y + 1.5, x1, yy + 2)}${line(x2, y + 1.5, x2, yy + 2)}${line(x1, yy, x2, yy)}${line(x1, yy, x1 + 2.2, yy - 0.8)}${line(x1, yy, x1 + 2.2, yy + 0.8)}${line(x2, yy, x2 - 2.2, yy - 0.8)}${line(x2, yy, x2 - 2.2, yy + 0.8)}${text((x1 + x2) / 2, yy - 1.3, value.toFixed(2).replace(/\.?0+$/, ""))}`; };
  const dimV = (y1, y2, x, value, off = -9) => { const xx = x + off; return `${line(x - 1.5, y1, xx - 2, y1)}${line(x - 1.5, y2, xx - 2, y2)}${line(xx, y1, xx, y2)}${line(xx, y1, xx - 0.8, y1 + 2.2)}${line(xx, y1, xx + 0.8, y1 + 2.2)}${line(xx, y2, xx - 0.8, y2 - 2.2)}${line(xx, y2, xx + 0.8, y2 - 2.2)}${text(xx - 1.3, (y1 + y2) / 2, value.toFixed(2).replace(/\.?0+$/, ""), 3.5, "middle", `transform="rotate(-90 ${(xx - 1.3).toFixed(2)} ${((y1 + y2) / 2).toFixed(2)})"`)}`; };
  const isoX = SW - M - 14 - V.iso.w * sIso, isoY = M + 22;
  const tbW = 190, tbX = SW - M - tbW, tbY = SH - M - TB;
  const mm = (v) => v.toFixed(1);
  const dimsOk = V.front.w * s > 8 && V.front.h * s > 8;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SW} ${SH}" width="${SW}mm" height="${SH}mm" style="background:#fff">`,
    `<rect x="${M}" y="${M}" width="${SW - 2 * M}" height="${SH - 2 * M}" fill="none" stroke="#111" stroke-width="0.7"/>`,
    group(V.front, ...place.front, s), group(V.top, ...place.top, s), group(V.right, ...place.right, s), group(V.iso, isoX, isoY, sIso),
    text(place.front[0] + fw / 2, bottom + 17, "FRONT", 3, "middle", 'font-weight="bold"'), text(place.top[0] + tw / 2, place.top[1] - 3, "TOP", 3, "middle", 'font-weight="bold"'),
    text(place.right[0] + rw / 2, bottom + 17, "RIGHT", 3, "middle", 'font-weight="bold"'), text(isoX + (V.iso.w * sIso) / 2, isoY - 4, `ISOMETRIC  (${fmtScale(sIso)})`, 3, "middle", 'font-weight="bold"'),
    dimsOk ? dimH(place.front[0], place.front[0] + fw, bottom, V.front.w, 9) : "", dimsOk ? dimV(place.front[1], place.front[1] + fh, place.front[0], V.front.h, -9) : "",
    dimsOk ? dimH(place.right[0], place.right[0] + rw, bottom, V.right.w, 9) : "",
    `<rect x="${tbX}" y="${tbY}" width="${tbW}" height="${TB}" fill="none" stroke="#111" stroke-width="0.5"/>`,
    line(tbX, tbY + 12, tbX + tbW, tbY + 12, 0.3), line(tbX + 110, tbY + 12, tbX + 110, tbY + TB, 0.3),
    text(tbX + 4, tbY + 8.5, name, 6, "start", 'font-weight="bold"'), text(tbX + tbW - 4, tbY + 8.5, "cadSlop", 3, "end", 'fill="#666"'),
    text(tbX + 4, tbY + 19, `Scale ${fmtScale(s)}   Units mm   Third angle`, 3.2, "start"), text(tbX + 4, tbY + 26, `Date ${date}`, 3.2, "start"),
    text(tbX + 114, tbY + 19, material ? `Material ${material}` : "Material -", 3.2, "start"), text(tbX + 114, tbY + 26, mass !== null ? `Mass ${mass >= 1000 ? (mass / 1000).toFixed(3) + " kg" : mass.toFixed(2) + " g"}` : "Mass -", 3.2, "start"),
    text(M + 3, SH - M - 3, `Overall ${mm(V.front.w)} x ${mm(V.right.w)} x ${mm(V.front.h)} mm`, 3, "start", 'fill="#555"'),
    "</svg>",
  ];
  return parts.join("\n");
}
