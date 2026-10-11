// Before a push, rewrite cadSlop-only primitives as features Onshape has natively, keeping the Onshape tree short:
// - a box or cylinder becomes a dimensioned sketch on a standard plane + an extrude (the sketch's `offset` becomes the
//   extrude's start offset in Onshape, so no construction plane per part);
// - moves and tilts applied to a fresh primitive are built into its sketch (Onshape can only rotate about an axis entity);
// - a cutter that is subtracted straight away becomes a cut extrude (no cutter body + boolean);
// - back-to-back cuts on the same plane with the same depth share one sketch and one cut.
// Mirrors about an offset plane get that plane added in front of them so Onshape has something to mirror about.
// The geometry is unchanged; only the recipe differs.
import { makeEvaluator } from "../kernel/expr.js";
import { STD_FRAMES, dot, cross, norm, rotateAbout } from "../kernel/vec.js";
import { bodiesBefore } from "./bodies.js";

const STD_NAME = { XY: "Top", XZ: "Front", YZ: "Right" };
const EPS = 1e-6;
const r4 = (x) => { const v = Math.round(x * 1e4) / 1e4; return Object.is(v, -0) ? 0 : v; };
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mul = (a, k) => a.map((x) => x * k);
const frame = (name) => { const f = STD_FRAMES[name]; return { x: f.x, y: cross(f.n, f.x), n: f.n }; };
const PASSIVE = new Set(["sketch", "plane"]);

/** The standard plane whose normal is parallel to v, or null. */
export function stdPlaneFor(v) {
  const u = norm(v);
  for (const [name, f] of Object.entries(STD_FRAMES)) if (Math.abs(Math.abs(dot(u, f.n)) - 1) < EPS) return name;
  return null;
}

/** Plane for mirroring about (normal, origin): a standard plane name plus its offset along that plane's normal. */
export function mirrorPlaneOf(f, ev) {
  const std = stdPlaneFor(ev.vec(f.normal, [1, 0, 0]));
  return std ? { std, s: r4(dot(ev.vec(f.origin, [0, 0, 0]), frame(std).n)) } : null;
}

/** k1*v1 + k2*v2 + ... where each v is a number or an expression string; a plain number when nothing is symbolic. */
function lin(terms) {
  let num = 0; const parts = [];
  for (const [k, v] of terms) {
    if (!k) continue;
    if (typeof v === "number") { num += k * v; continue; }
    const t = /^[\w.]+$/.test(String(v).trim()) ? String(v).trim() : `(${v})`;
    parts.push(k === 1 ? `+ ${t}` : k === -1 ? `- ${t}` : `${k < 0 ? "-" : "+"} ${Math.abs(k)} * ${t}`);
  }
  if (!parts.length) return r4(num);
  let out = parts.join(" ").replace(/^\+ /, "").replace(/^- /, "-");
  if (Math.abs(num) > 1e-9) out += num > 0 ? ` + ${r4(num)}` : ` - ${r4(-num)}`;
  return out;
}

const PRIMITIVE_KEYS = new Set(["type", "position", "w", "d", "h", "r", "direction", "mode"]);

function solidOf(f, ev) {
  if (f.type === "box") {
    const [x, y, z] = ev.vec(f.position, [0, 0, 0]), w = ev(f.w), d = ev(f.d), h = ev(f.h);
    return { kind: "box", o: [x - w / 2, y - d / 2, z], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], size: [w, d, h], expr: [f.w, f.d, f.h], raw: f };
  }
  return { kind: "cylinder", p: ev.vec(f.position, [0, 0, 0]), dir: norm(ev.vec(f.direction, [0, 0, 1])), r: ev(f.r), h: ev(f.h), expr: { r: f.r, h: f.h }, raw: f };
}

/** Apply a transform feature (scale 1) the way the kernel does: rotate about axis/origin, then translate. */
function moveSolid(s, t, ev) {
  const rot = ev.opt(t.rotate, 0), axis = norm(ev.vec(t.axis, [0, 0, 1])), origin = ev.vec(t.origin, [0, 0, 0]), move = ev.vec(t.translate, [0, 0, 0]);
  const pt = (p) => add(add(origin, rot ? rotateAbout(sub(p, origin), axis, rot) : sub(p, origin)), move);
  const dir = (v) => (rot ? rotateAbout(v, axis, rot) : v);
  // Once moved, positions are plain numbers (a tilt doesn't keep "x - w/2" meaning anything useful).
  return s.kind === "box" ? { ...s, o: pt(s.o), axes: s.axes.map(dir), raw: null } : { ...s, p: pt(s.p), dir: dir(s.dir), raw: null };
}

/**
 * Standard plane, offset along its normal, 2D shape and extrude depth for a solid, or null when none of its sides is
 * square to a standard plane. `box` is the shape's 2D bounds [u0, v0, u1, v1]; geom/cons ids are local to the shape.
 */
function recipeOf(s) {
  if (s.kind === "cylinder") {
    const std = stdPlaneFor(s.dir);
    if (!std) return null;
    const F = frame(std), base = dot(s.dir, F.n) > 0 ? s.p : add(s.p, mul(s.dir, s.h));
    const u = r4(dot(base, F.x)), v = r4(dot(base, F.y));
    // Unmoved: keep positions as written (expressions stay expressions), so editing a variable moves things the same way.
    const P = s.raw?.position ?? [0, 0, 0], along = (w) => lin([0, 1, 2].map((k) => [w[k], P[k] ?? 0]));
    const su = s.raw ? along(F.x) : u, sv = s.raw ? along(F.y) : v;
    const offset = s.raw ? lin([...[0, 1, 2].map((k) => [F.n[k], P[k] ?? 0]), ...(dot(s.dir, F.n) > 0 ? [] : [[-1, s.expr.h]])]) : r4(dot(base, F.n));
    return { std, offset, depth: s.expr.h, box: [u - s.r, v - s.r, u + s.r, v + s.r],
      geom: [{ id: "p1", t: "point", x: u, y: v }, { id: "c1", t: "circle", c: "p1", r: r4(s.r) }],
      cons: [{ id: "d1", t: "dim", k: "radius", a: "c1", v: s.expr.r }, { id: "d2", t: "dim", k: "x", a: "p1", v: su }, { id: "d3", t: "dim", k: "y", a: "p1", v: sv }] };
  }
  // A box: extrude along whichever of its edges is square to a standard plane (height first, so plain boxes sketch on Top).
  const i = [2, 0, 1].find((k) => stdPlaneFor(s.axes[k]));
  if (i === undefined) return null;
  const std = stdPlaneFor(s.axes[i]), F = frame(std), j = (i + 1) % 3, k = (i + 2) % 3;
  const base = dot(s.axes[i], F.n) > 0 ? s.o : add(s.o, mul(s.axes[i], s.size[i]));
  const a = add(base, mul(s.axes[j], s.size[j]));
  const corners = [base, a, add(a, mul(s.axes[k], s.size[k])), add(base, mul(s.axes[k], s.size[k]))];
  const geom = corners.map((c, n) => ({ id: `p${n + 1}`, t: "point", x: r4(dot(c, F.x)), y: r4(dot(c, F.y)) }));
  for (let n = 0; n < 4; n++) geom.push({ id: `l${n + 1}`, t: "line", a: `p${n + 1}`, b: `p${((n + 1) % 4) + 1}` });
  const along = (v, w) => Math.abs(Math.abs(dot(v, w)) - 1) < EPS;
  const cons = [];
  if (along(s.axes[j], F.x) || along(s.axes[j], F.y)) {
    const firstH = along(s.axes[j], F.x);
    ["l1", "l2", "l3", "l4"].forEach((l, n) => cons.push({ id: `k${n + 1}`, t: (n % 2 === 0) === firstH ? "horizontal" : "vertical", a: l }));
  } else for (let n = 0; n < 3; n++) cons.push({ id: `k${n + 1}`, t: "perpendicular", a: `l${n + 1}`, b: `l${n + 2}` });
  // Unmoved boxes sketch on Top with the corner at position - size/2, written as an expression when sizes are variables.
  const P = s.raw?.position ?? [0, 0, 0];
  const cu = s.raw ? lin([[1, P[0] ?? 0], [-0.5, s.raw.w]]) : geom[0].x, cv = s.raw ? lin([[1, P[1] ?? 0], [-0.5, s.raw.d]]) : geom[0].y;
  cons.push({ id: "d1", t: "dim", k: "length", a: "l1", v: s.expr[j] }, { id: "d2", t: "dim", k: "length", a: "l2", v: s.expr[k] },
    { id: "d3", t: "dim", k: "x", a: "p1", v: cu }, { id: "d4", t: "dim", k: "y", a: "p1", v: cv });
  const us = geom.slice(0, 4).map((g) => g.x), vs = geom.slice(0, 4).map((g) => g.y);
  const offset = s.raw ? lin([[1, P[2] ?? 0]]) : r4(dot(base, F.n));
  return { std, offset, depth: s.expr[i], geom, cons, box: [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)] };
}

/** Put several shapes into one sketch, prefixing ids so they stay unique. */
function mergeShapes(recipes) {
  if (recipes.length === 1) return { geom: recipes[0].geom, cons: recipes[0].cons };
  const geom = [], cons = [];
  recipes.forEach((r, n) => {
    const p = (id) => `s${n + 1}${id}`;
    for (const g of r.geom) geom.push({ ...g, id: p(g.id), ...(g.a ? { a: p(g.a) } : {}), ...(g.b ? { b: p(g.b) } : {}), ...(g.c ? { c: p(g.c) } : {}) });
    for (const c of r.cons) cons.push({ ...c, id: p(c.id), a: p(c.a), ...(c.b ? { b: p(c.b) } : {}) });
  });
  return { geom, cons };
}
const overlaps = (a, b) => a[0] < b[2] + EPS && b[0] < a[2] + EPS && a[1] < b[3] + EPS && b[1] < a[3] + EPS;
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const label = (f) => (f.type === "box" ? "Box" : "Cylinder");

/**
 * Rewrite a part so everything it can be is an Onshape-native feature. Returns { part, changed: [descriptions], warnings }.
 * A converted primitive's id stays on its extrude, so nothing that refers to it breaks.
 */
export function nativizePart(part) {
  const feats = part.features ?? [];
  const ev = makeEvaluator({ ...(part.variables ?? {}), ...(part.configs?.[part.config] ?? {}) });
  const byId = new Map(feats.map((f) => [f.id, f]));
  const at = bodiesBefore(feats);
  // Transforms that hit each primitive while nothing else had touched it (the last pure entry has the full list).
  const movesOf = new Map();
  for (const list of [...at.values(), at.final]) for (const e of list ?? []) if (e.pure) movesOf.set(e.pure, e.moves);
  // A cutter subtracted by the very next body feature, when only it and its target exist, is just a cut.
  const cutBy = new Map();
  feats.forEach((f, n) => {
    if ((f.type !== "box" && f.type !== "cylinder") || f.suppressed || (f.mode ?? "new") !== "new") return;
    const moves = new Set(movesOf.get(f.id) ?? []);
    const next = feats.slice(n + 1).find((g) => !g.suppressed && !PASSIVE.has(g.type) && !moves.has(g.id));
    const list = next && at.get(next.id);
    if (next?.type === "boolean" && next.op === "subtract" && list?.length === 2 && list[Number(next.b)]?.pure === f.id && Number(next.a) !== Number(next.b)) cutBy.set(f.id, next);
  });

  const ids = new Set(feats.map((f) => f.id));
  const uid = (base) => { let id = base, n = 2; while (ids.has(id)) id = `${base}${n++}`; ids.add(id); return id; };
  const out = [], changed = [], warnings = [], dropped = new Set(), planes = new Map();
  const planeRef = (std, s) => {
    const key = `${std}|${r4(s)}`;
    if (Math.abs(s) < EPS || planes.has(key)) return;
    const id = uid("pl");
    out.push({ id, type: "plane", name: `${STD_NAME[std]} ${s > 0 ? "+" : "-"} ${Math.abs(r4(s))} mm`, mode: "offset", from: std, distance: r4(s) });
    planes.set(key, id);
  };
  let group = null;   // the last cut written, while more cuts can still join it
  const closeGroup = () => {
    if (!group) return;
    Object.assign(group.sketch, mergeShapes(group.recipes));
    if (group.names.length > 1) {
      group.extrude.name = `${group.names[0]} (+${group.names.length - 1} more)`;
      group.sketch.name = `${group.extrude.name} (sketch)`;
    }
    group = null;
  };

  for (const f of feats) {
    if (dropped.has(f.id)) continue;
    if (f.type === "plane" && !f.suppressed && (f.mode ?? "offset") === "offset" && STD_FRAMES[f.from ?? "XY"] && typeof f.distance === "number") planes.set(`${f.from ?? "XY"}|${r4(f.distance)}`, f.id);
    if (f.type === "mirror" && !f.suppressed) { try { const mp = mirrorPlaneOf(f, ev); if (mp) { closeGroup(); planeRef(mp.std, mp.s); } } catch { /* bad expression: the kernel reports it */ } }
    if ((f.type !== "box" && f.type !== "cylinder") || f.suppressed) { if (!PASSIVE.has(f.type) && !f.suppressed) closeGroup(); out.push(f); continue; }

    const allMoves = (movesOf.get(f.id) ?? []).map((id) => byId.get(id));
    let recipe = null, moves = allMoves;
    try {
      const solid = solidOf(f, ev);
      recipe = moves.length ? recipeOf(moves.reduce((s, t) => moveSolid(s, t, ev), solid)) : null;
      if (!recipe) { moves = []; recipe = recipeOf(solid); }
    } catch { recipe = null; }
    if (!recipe) { closeGroup(); warnings.push(`${f.type} "${f.name ?? f.id}" points along a tilted axis, so it stays a cadSlop ${f.type}`); out.push(f); continue; }
    for (const t of moves) dropped.add(t.id);
    // The cutter shortcut assumed its moves are built in; if they couldn't be, keep the boolean.
    const boolean = moves.length === allMoves.length ? cutBy.get(f.id) ?? null : null;
    if (boolean) dropped.add(boolean.id);
    const mode = boolean ? "cut" : f.mode ?? "new";
    const name = boolean?.name ?? f.name ?? f.id;
    const built = moves.length ? ` (with ${moves.map((t) => `"${t.name ?? t.id}"`).join(", ")} built in)` : "";
    changed.push(boolean ? `${label(f)} cutter "${f.name ?? f.id}" + "${name}" become one cut${built}` : `${label(f)} "${f.name ?? f.id}" becomes a sketch + extrude${built}`);

    // Join the previous cut when it's on the same plane at the same offset and depth and the shapes don't touch.
    if (mode === "cut" && group && group.std === recipe.std && sameValue(group.offset, recipe.offset) && sameValue(group.depth, recipe.depth) && !group.recipes.some((r) => overlaps(r.box, recipe.box))) {
      group.recipes.push(recipe); group.names.push(name);
      continue;
    }
    closeGroup();
    const extra = Object.fromEntries(Object.entries(f).filter(([k]) => !PRIMITIVE_KEYS.has(k)));
    const sk = uid(`${f.id}sk`);
    const sketch = { id: sk, type: "sketch", name: `${name} (sketch)`, plane: recipe.std, ...(recipe.offset ? { offset: recipe.offset } : {}), geom: recipe.geom, cons: recipe.cons };
    const extrude = { ...extra, name, type: "extrude", sketch: sk, distance: recipe.depth, mode };
    out.push(sketch, extrude);
    if (mode === "cut") group = { sketch, extrude, recipes: [recipe], names: [name], std: recipe.std, offset: recipe.offset, depth: recipe.depth };
  }
  closeGroup();
  return { part: { ...part, features: out }, changed, warnings };
}
