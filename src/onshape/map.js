// Translate between cadSlop parts and Onshape Part Studio feature JSON.
// Mapped both ways: variables (assignVariable), offset construction planes, constrained sketches (on standard or
// construction planes; a sketch's offset travels as its extrudes' start offset), extrudes, fillets, chamfers, shells.
// Sent to Onshape: booleans, transforms (moves and copies), mirrors and body deletes. They pick bodies with queries built
// from the body list (bodies.js); when Onshape hands them back untouched, sync keeps the cadSlop version.
// Everything else Onshape has is imported as an opaque `onshape` feature and left untouched.
// Onshape lengths in sketch geometry are metres; expressions carry their own units.

import { makeEvaluator } from "../kernel/expr.js";
import { pickBodies } from "./bodies.js";
import { mirrorPlaneOf } from "./nativize.js";

export const PLANE_IDS = { XY: "JDC", XZ: "JCC", YZ: "JEC" }; // Top, Front, Right (checked against Onshape)
const PLANE_BY_ID = Object.fromEntries(Object.entries(PLANE_IDS).map(([k, v]) => [v, k]));
const M = 1 / 1000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// ---------- parameter builders / readers ----------
const S = (id, v) => ({ btType: "BTMParameterString-149", value: v, parameterId: id });
const Q = (id, expression) => ({ btType: "BTMParameterQuantity-147", isInteger: false, expression, parameterId: id });
const E = (id, enumName, value) => ({ btType: "BTMParameterEnum-145", enumName, value, parameterId: id });
const B = (id, value) => ({ btType: "BTMParameterBoolean-144", value, parameterId: id });
const param = (f, id) => (f.parameters ?? []).find((p) => p.parameterId === id);

// ---------- expressions ----------
const UNIT_WORDS = new Set(["mm", "cm", "m", "in", "ft", "deg", "rad"]);
const FN_WORDS = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "abs", "min", "max", "pow", "floor", "ceil", "round", "log", "exp", "PI", "pi"]);
const TOK = /\s*(?:(\d*\.?\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(.))/gy;

/** cadSlop value -> Onshape expression. Bare numbers get a unit; variable names become #name. */
export function toOsExpr(v, unit = "mm") {
  if (typeof v === "number") return unit ? `${r6(v)} ${unit}` : String(r6(v));
  const src = String(v);
  const toks = []; TOK.lastIndex = 0; let m;
  while (TOK.lastIndex < src.length && (m = TOK.exec(src))) toks.push(m[1] !== undefined ? { n: m[1] } : m[2] !== undefined ? { id: m[2] } : { op: m[3] });
  const out = [];
  toks.forEach((t, i) => {
    if (t.n !== undefined) {
      const next = toks[i + 1], prev = toks[i - 1];
      const hasUnit = next?.id && UNIT_WORDS.has(next.id);
      const mulCtx = (prev?.op && "*/^%".includes(prev.op)) || (next?.op && "*/^%".includes(next.op));
      const additive = !mulCtx && ((next?.op && "+-".includes(next.op)) || (prev?.op && "+-".includes(prev.op)) || toks.length === 1 || (prev?.op === "(" && next?.op === ")"));
      out.push(t.n + (!hasUnit && unit && additive ? ` ${unit}` : ""));
    } else if (t.id !== undefined) out.push(UNIT_WORDS.has(t.id) ? ` ${t.id}` : FN_WORDS.has(t.id) ? t.id : `#${t.id}`);
    else out.push(t.op);
  });
  return out.join("").replace(/([+\-*/])/g, " $1 ").replace(/\s+/g, " ").trim();
}

/** Onshape expression -> cadSlop value (number when it's a plain quantity). */
export function fromOsExpr(expr) {
  const s = String(expr ?? "").replace(/#/g, "").trim();
  const m = s.match(/^(-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*(mm|cm|m|in|ft|deg|rad|meter|inch|degree)?$/);
  if (m) {
    const n = Number(m[1]);
    const f = { mm: 1, cm: 10, m: 1000, meter: 1000, in: 25.4, inch: 25.4, ft: 304.8, deg: 1, degree: 1, rad: 180 / Math.PI }[m[2] ?? "mm"];
    return r6(n * f);
  }
  return s.replace(/\bmeters?\b/g, "m").replace(/\binch(es)?\b/g, "in").replace(/\bdegrees?\b/g, "deg");
}

// ---------- sketch export ----------
const CONS = (type, entityId, params) => ({ btType: "BTMSketchConstraint-2", constraintType: type, entityId, parameters: params });
const FIRST = (id) => S("localFirst", id), SECOND = (id) => S("localSecond", id);

function sketchToOs(f, warnings) {
  const geom = f.geom ?? [];
  const P = new Map(geom.filter((g) => g.t === "point").map((g) => [g.id, g]));
  const holders = new Map();
  const hold = (pid, local) => { if (!holders.has(pid)) holders.set(pid, []); holders.get(pid).push(local); };
  const ents = [], cons = [];
  const con = (...a) => cons.push(CONS(a[0], `${f.id}.c${cons.length + 1}`, a[1]));
  for (const g of geom) {
    const base = { entityId: g.id, isConstruction: !!g.construction };
    if (g.t === "line") {
      const a = P.get(g.a), b = P.get(g.b), dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-9;
      ents.push({ btType: "BTMSketchCurveSegment-155", ...base, startPointId: `${g.id}.start`, endPointId: `${g.id}.end`, startParam: 0, endParam: r6(len * M),
        geometry: { btType: "BTCurveGeometryLine-117", pntX: r6(a.x * M), pntY: r6(a.y * M), dirX: r6(dx / len), dirY: r6(dy / len) } });
      hold(g.a, `${g.id}.start`); hold(g.b, `${g.id}.end`);
    } else if (g.t === "circle") {
      const c = P.get(g.c);
      ents.push({ btType: "BTMSketchCurve-4", ...base, centerId: `${g.id}.center`, geometry: { btType: "BTCurveGeometryCircle-115", radius: r6(g.r * M), xCenter: r6(c.x * M), yCenter: r6(c.y * M), xDir: 1, yDir: 0, clockwise: false } });
      hold(g.c, `${g.id}.center`);
    } else if (g.t === "arc") {
      const c = P.get(g.c), s = P.get(g.s), e = P.get(g.e);
      let a0 = Math.atan2(s.y - c.y, s.x - c.x); if (a0 < 0) a0 += 2 * Math.PI; // Onshape wants 0 <= start < 2π
      let a1 = Math.atan2(e.y - c.y, e.x - c.x); while (a1 <= a0) a1 += 2 * Math.PI;
      ents.push({ btType: "BTMSketchCurveSegment-155", ...base, centerId: `${g.id}.center`, startPointId: `${g.id}.start`, endPointId: `${g.id}.end`, startParam: r6(a0), endParam: r6(a1),
        geometry: { btType: "BTCurveGeometryCircle-115", radius: r6(Math.hypot(s.x - c.x, s.y - c.y) * M), xCenter: r6(c.x * M), yCenter: r6(c.y * M), xDir: 1, yDir: 0, clockwise: false } });
      hold(g.c, `${g.id}.center`); hold(g.s, `${g.id}.start`); hold(g.e, `${g.id}.end`);
    }
  }
  for (const [pid, p] of P) if (!holders.has(pid) && pid !== "o") { ents.push({ btType: "BTMSketchPoint-158", entityId: pid, isConstruction: false, x: r6(p.x * M), y: r6(p.y * M) }); hold(pid, pid); }
  for (const [pid, list] of holders) for (let i = 1; i < list.length; i++) con("COINCIDENT", [FIRST(list[0]), SECOND(list[i])]);
  const R = (id) => (P.has(id) ? holders.get(id)?.[0] : id);
  const gt = new Map(geom.map((g) => [g.id, g.t]));
  const fixed = new Set();
  for (const c of f.cons ?? []) {
    const a = R(c.a), b = c.b ? R(c.b) : null;
    if (!a || (c.b && !b)) { warnings.push(`Sketch "${f.name ?? f.id}": skipped ${c.t} (uses the origin/an unsupported reference)`); continue; }
    switch (c.t) {
      case "horizontal": case "vertical": con(c.t.toUpperCase(), b ? [FIRST(a), SECOND(b)] : [FIRST(a)]); break;
      case "parallel": case "perpendicular": case "equal": case "tangent": case "concentric": con(c.t.toUpperCase(), [FIRST(a), SECOND(b)]); break;
      case "midpoint": con("MIDPOINT", [FIRST(a), SECOND(b)]); break;
      case "on": con("COINCIDENT", [FIRST(a), SECOND(b)]); break;
      case "fix": con("FIX", [FIRST(a)]); break;
      case "dim": {
        const L = toOsExpr(c.v);
        if (c.k === "length") con("LENGTH", [FIRST(a), Q("length", L)]);
        else if (c.k === "dist" || c.k === "pdist") con("DISTANCE", [FIRST(a), SECOND(b), Q("length", L)]);
        else if (c.k === "hdist" || c.k === "vdist") con("DISTANCE", [FIRST(a), SECOND(b), E("direction", "DimensionDirection", c.k === "hdist" ? "HORIZONTAL" : "VERTICAL"), Q("length", L)]);
        else if (c.k === "radius") con("RADIUS", [FIRST(a), Q("length", L)]);   // Onshape names both values "length"
        else if (c.k === "diameter") con("DIAMETER", [FIRST(a), Q("length", L)]);
        else if (c.k === "angle") warnings.push(`Sketch "${f.name ?? f.id}": angle dimension ${c.v} stays in cadSlop (Onshape's API rejects sketch angle constraints); the geometry is sent at that angle`);
        else if (c.k === "x" || c.k === "y") { if (!fixed.has(a)) { fixed.add(a); con("FIX", [FIRST(a)]); } } // positions from the origin lock the point in Onshape
        else warnings.push(`Sketch "${f.name ?? f.id}": dimension ${c.k} isn't sent to Onshape`);
        break;
      }
      default: warnings.push(`Sketch "${f.name ?? f.id}": constraint ${c.t} isn't sent to Onshape`);
    }
    void gt;
  }
  return { entities: ents, constraints: cons };
}

// ---------- topology queries ----------
// Onshape selects edges/faces by internal ids we can't match, but its query language can select "the entity
// containing this point", which is exactly how cadSlop stores picks.
const QPOINT = /qContainsPoint\(\s*qEverything\(\s*EntityType\.(EDGE|FACE)\s*\)\s*,\s*vector\(([^)]*)\)\s*\*\s*meter\s*\)/;
const pointQuery = (kind, p) => ({ btType: "BTMIndividualQuery-138", deterministicIds: [], queryString: `query=qContainsPoint(qEverything(EntityType.${kind}), vector(${p.map((x) => r6(x * M)).join(", ")}) * meter);` });
const entitiesParam = (kind, refs) => ({ btType: "BTMParameterQueryList-148", parameterId: "entities", queries: refs.map((r) => pointQuery(kind, r.p)) });
/** Parse our own point queries back into refs; null if any query is something else (e.g. picked in Onshape's UI). */
function refsFromQueries(queries, kind) {
  if (!queries?.length) return null;
  const out = [];
  for (const q of queries) {
    const m = String(q.queryString ?? "").match(QPOINT);
    if (!m || m[1] !== kind) return null;
    const p = m[2].split(",").map((x) => r6(Number(x) / M));
    if (p.length !== 3 || p.some((x) => !Number.isFinite(x))) return null;
    out.push({ p });
  }
  return out;
}

// ---------- planes ----------
const createdByFace = (osId) => `query=qCreatedBy(makeId("${osId}"), EntityType.FACE);`;
const CREATED_BY = /qCreatedBy\(\s*makeId\(\s*"([^"]+)"\s*\)/;
/** Query for a standard plane name or a construction-plane feature id (null if that plane isn't in Onshape yet). */
function planeQuery(ref, ctx) {
  if (PLANE_IDS[ref]) return { btType: "BTMIndividualQuery-138", deterministicIds: [PLANE_IDS[ref]] };
  const os = ctx.osIdOf(ref);
  return os ? { btType: "BTMIndividualQuery-138", deterministicIds: [], queryString: createdByFace(os) } : null;
}
/** Onshape plane query -> standard plane name or the Onshape feature id that created it. */
function planeRefOf(q) {
  const det = q?.deterministicIds?.[0];
  if (det && PLANE_BY_ID[det]) return { std: PLANE_BY_ID[det] };
  const m = String(q?.queryString ?? "").match(CREATED_BY);
  return m ? { osId: m[1] } : null;
}

// ---------- export ----------
/** cadSlop feature -> Onshape feature JSON, or null (with a warning) if it can't be sent. `osIdOf(id)` resolves sketch ids. */
export function featureToOs(f, ctx) {
  const wrap = (featureType, params, extra = {}) => ({ btType: "BTMFeature-134", featureType, name: f.name ?? f.id, suppressed: !!f.suppressed, parameters: params, returnAfterSubfeatures: false, ...extra });
  if (f.type === "sketch") {
    const pq = typeof f.plane === "string" ? planeQuery(f.plane, ctx) : null;
    if (!pq) { ctx.warnings.push(`Sketch "${f.name ?? f.id}" is on a face/custom plane; not sent. Put it on a construction plane instead`); return null; }
    if (f.entities?.length) ctx.warnings.push(`Sketch "${f.name ?? f.id}" has older-style shapes, which aren't sent. Redraw them with the new sketch tools`);
    const { entities, constraints } = sketchToOs(f, ctx.warnings);
    return { btType: "BTMSketch-151", featureType: "newSketch", name: f.name ?? f.id, suppressed: !!f.suppressed,
      parameters: [{ btType: "BTMParameterQueryList-148", parameterId: "sketchPlane", queries: [pq] }], entities, constraints };
  }
  if (f.type === "plane") {
    if ((f.mode ?? "offset") !== "offset") { ctx.warnings.push(`Plane "${f.name ?? f.id}" (${f.mode}) isn't sent to Onshape yet; only offset planes are`); return null; }
    const q = planeQuery(f.from ?? "XY", ctx);
    if (!q) { ctx.warnings.push(`Plane "${f.name ?? f.id}" is offset from a plane that isn't in Onshape yet; not sent`); return null; }
    const { size, flip } = splitSign(f.distance ?? 10);
    return wrap("cPlane", [{ btType: "BTMParameterQueryList-148", parameterId: "entities", queries: [q] }, E("cplaneType", "CPlaneType", "OFFSET"), Q("offset", toOsExpr(size)), B("oppositeDirection", flip)]);
  }
  if (f.type === "extrude") {
    const sk = ctx.osIdOf(f.sketch);
    if (!sk) { ctx.warnings.push(`Extrude "${f.name ?? f.id}" uses a sketch that isn't in Onshape yet; not sent`); return null; }
    if (f.regions?.length) ctx.warnings.push(`Extrude "${f.name ?? f.id}": region selection isn't sent; Onshape will use every region`);
    const op = { new: "NEW", add: "ADD", cut: "REMOVE", intersect: "INTERSECT" }[f.mode ?? "add"] ?? "ADD";
    const params = [E("bodyType", "ExtendedToolBodyType", "SOLID"), E("operationType", "NewBodyOperationType", op),
      // Every region except holes (inner loops), which is what cadSlop extrudes; a bare region query would fill the holes in.
      { btType: "BTMParameterQueryList-148", parameterId: "entities", queries: [{ btType: "BTMIndividualQuery-138", deterministicIds: [], queryString: `query=qSketchRegion(makeId("${sk}"), true);` }] },
      E("endBound", "BoundingType", f.through ? "THROUGH_ALL" : f.symmetric ? "SYMMETRIC" : "BLIND")];
    if (!f.through) params.push(Q("depth", toOsExpr(f.distance ?? 10)));
    params.push(B("oppositeDirection", !!f.flip));
    // The sketch's offset (cadSlop moves the sketch along its normal) is Onshape's "start offset" on the extrude.
    const off = ctx.feature?.(f.sketch)?.offset;
    if (off && off !== "0" && !f.through) {
      const { size, flip } = splitSign(off);
      params.push(B("startOffset", true), E("startOffsetBound", "StartOffsetType", "BLIND"), Q("startOffsetDistance", toOsExpr(size)), B("startOffsetOppositeDirection", flip));
    }
    return wrap("extrude", params);
  }
  if (f.type === "boolean") {
    const a = bodiesParam("tools", f, Number(f.a), ctx), b = a && bodiesParam("tools", f, Number(f.b), ctx);
    if (!b) return null;
    const op = f.op ?? "union";
    if (op === "subtract") return wrap("booleanBodies", [E("operationType", "BooleanOperationType", "SUBTRACTION"), { ...a, parameterId: "targets" }, b, B("keepTools", false)]);
    return wrap("booleanBodies", [E("operationType", "BooleanOperationType", op === "intersect" ? "INTERSECTION" : "UNION"), { ...a, queries: [...a.queries, ...b.queries] }, B("keepTools", false)]);
  }
  if (f.type === "transform") {
    // Onshape rotates only about an axis that exists in the model; nativize builds tilts of fresh boxes/cylinders into their sketch.
    const ev = ctx.ev ?? makeEvaluator({});
    if (ev.opt(f.rotate, 0) || ev.opt(f.scale, 1) !== 1) { ctx.warnings.push(`Transform "${f.name ?? f.id}" rotates or scales an existing body, which can't be sent to Onshape; kept in cadSlop only`); return null; }
    const bodies = bodiesParam("entities", f, f.body, ctx);
    if (!bodies) return null;
    const t = f.translate ?? [0, 0, 0];
    return wrap("transform", [bodies, E("transformType", "TransformType", "TRANSLATION_3D"), Q("dx", toOsExpr(t[0] ?? 0)), Q("dy", toOsExpr(t[1] ?? 0)), Q("dz", toOsExpr(t[2] ?? 0)), B("makeCopy", !!f.copy)]);
  }
  if (f.type === "mirror") {
    const mp = mirrorPlaneOf(f, ctx.ev ?? makeEvaluator({}));
    const planeId = !mp ? null : Math.abs(mp.s) < 1e-6 ? mp.std
      : ctx.features?.find((g) => g.type === "plane" && (g.mode ?? "offset") === "offset" && (g.from ?? "XY") === mp.std && typeof g.distance === "number" && Math.abs(g.distance - mp.s) < 1e-4)?.id;
    const pq = planeId ? planeQuery(planeId, ctx) : null;
    if (!pq) { ctx.warnings.push(`Mirror "${f.name ?? f.id}": its mirror plane isn't square to Top/Front/Right or isn't in Onshape yet; not sent`); return null; }
    const bodies = bodiesParam("entities", f, f.body, ctx);
    if (!bodies) return null;
    return wrap("mirror", [E("patternType", "MirrorType", "PART"), E("operationType", "NewBodyOperationType", f.merge === false ? "NEW" : "ADD"), bodies,
      { btType: "BTMParameterQueryList-148", parameterId: "mirrorPlane", queries: [pq] }, B("defaultScope", true)]);
  }
  if (f.type === "deleteBody") {
    const bodies = bodiesParam("entities", f, f.body, ctx);
    return bodies && wrap("deleteBodies", [bodies]);
  }
  if (f.type === "fillet" || f.type === "chamfer") {
    if (!f.edges?.length) { ctx.warnings.push(`${f.type} "${f.name ?? f.id}" has no edges picked; not sent`); return null; }
    const params = [entitiesParam("EDGE", f.edges)];
    if (f.type === "fillet") params.push(Q("radius", toOsExpr(f.radius ?? 2)));
    else params.push(E("chamferType", "ChamferType", "EQUAL_OFFSETS"), Q("width", toOsExpr(f.radius ?? 1)));
    params.push(B("tangentPropagation", false));
    return wrap(f.type, params);
  }
  if (f.type === "shell") {
    if (!f.faces?.length) { ctx.warnings.push(`shell "${f.name ?? f.id}" has no faces picked; not sent`); return null; }
    return wrap("shell", [entitiesParam("FACE", f.faces), Q("thickness", toOsExpr(f.thickness ?? 2))]);
  }
  if (f.type === "onshape") return null;
  ctx.warnings.push(`${f.type} "${f.name ?? f.id}" isn't sent to Onshape yet (kept in cadSlop only)`);
  return null;
}

/** Split a signed distance into its size and whether it points the other way (Onshape wants positive values + a flip). */
function splitSign(d) {
  if (typeof d === "number") return { size: Math.abs(d), flip: d < 0 };
  const neg = /^\s*-/.test(String(d));
  return { size: neg ? String(d).replace(/^\s*-\s*/, "") : d, flip: neg };
}

const bodyQuery = (osIds) => ({ btType: "BTMIndividualQuery-138", deterministicIds: [],
  queryString: `query=qBodyType(qUnion([${osIds.map((id) => `qCreatedBy(makeId("${id}"), EntityType.BODY)`).join(", ")}]), BodyType.SOLID);` });

/** Query-list parameter picking cadSlop body number(s) `sel` as they are just before feature f, or null (with a warning). */
function bodiesParam(parameterId, f, sel, ctx) {
  const fail = (why) => { ctx.warnings.push(`${f.type} "${f.name ?? f.id}" isn't sent to Onshape: ${why}`); return null; };
  if (sel === undefined || sel === "all") return { btType: "BTMParameterQueryList-148", parameterId, queries: [{ btType: "BTMIndividualQuery-138", deterministicIds: [], queryString: "query=qBodyType(qEverything(EntityType.BODY), BodyType.SOLID);" }] };
  const list = ctx.bodiesAt?.(f.id);
  if (!list) return fail("an earlier feature changes the bodies in a way Onshape can't follow (a merge by touch, an import or an Onshape-only feature)");
  const idx = pickBodies(list, sel);
  if (!idx.length) return fail("it picks a body that doesn't exist");
  const queries = [];
  for (const i of idx) {
    if (list[i].shared) return fail(`body ${i} is one of several copies made by one feature, so Onshape can't pick it alone`);
    const osIds = list[i].from.map((id) => ctx.osIdOf(id));
    if (osIds.some((x) => !x)) return fail(`body ${i} was made by a feature that isn't in Onshape`);
    queries.push(bodyQuery(osIds));
  }
  return { btType: "BTMParameterQueryList-148", parameterId, queries };
}

/** Onshape variable feature. cadSlop variables are lengths (mm) unless the value is written in degrees. */
export function variableToOs(name, value) {
  const angle = typeof value === "string" && /\b(deg|rad)\b/.test(value);
  return { btType: "BTMFeature-134", featureType: "assignVariable", name: `#${name}`, suppressed: false, returnAfterSubfeatures: false,
    parameters: [E("variableType", "VariableType", angle ? "ANGLE" : "LENGTH"), S("name", name), angle ? Q("angleValue", toOsExpr(value, "deg")) : Q("lengthValue", toOsExpr(value))] };
}

// ---------- import ----------
const FEATURE_PREFIX = { plane: "pl", sketch: "sk", extrude: "ex", fillet: "fl", chamfer: "ch", shell: "sh", onshape: "os" };
const stableId = (type, osId) => `${FEATURE_PREFIX[type] ?? "f"}_${String(osId).replace(/[^A-Za-z0-9]/g, "").slice(0, 6)}`;

function importSketch(raw, id, warnings, planeOf = () => null) {
  const pr = planeRefOf(param(raw, "sketchPlane")?.queries?.[0]);
  const plane = pr?.std ?? (pr?.osId ? planeOf(pr.osId) : null);
  if (!plane) return null;
  const geom = [], cons = [];
  const holder = new Map(); // onshape local point id -> our point id
  let pn = 0, ln = 0, cn = 0, an = 0, kn = 0;
  const newPoint = (x, y) => { const id2 = `p${++pn}`; geom.push({ id: id2, t: "point", x: r6(x / M), y: r6(y / M) }); return id2; };
  const bind = (local, x, y) => { if (!holder.has(local)) holder.set(local, newPoint(x, y)); return holder.get(local); };
  const ents = raw.entities ?? [];
  // merge points joined by COINCIDENT first so shared corners become one point
  const uf = new Map(); const find = (a) => (uf.get(a) === undefined || uf.get(a) === a ? a : (uf.set(a, find(uf.get(a))), uf.get(a)));
  const coincident = (raw.constraints ?? []).filter((c) => c.constraintType === "COINCIDENT");
  const pv = (c, id2) => param(c, id2)?.value;
  for (const c of coincident) { const a = pv(c, "localFirst"), b = pv(c, "localSecond"); if (a && b) uf.set(find(b), find(a)); }
  const ref = (local, x, y) => bind(find(local), x, y);
  const idOf = new Map(); // onshape entity id -> our geometry id
  for (const e of ents) {
    const g = e.geometry ?? {}, construction = e.isConstruction ? { construction: true } : {};
    if (e.btType === "BTMSketchPoint-158") { const pid = ref(e.entityId, e.x, e.y); idOf.set(e.entityId, pid); }
    else if (g.btType === "BTCurveGeometryLine-117") {
      const len = e.endParam - e.startParam, sx = g.pntX + g.dirX * e.startParam, sy = g.pntY + g.dirY * e.startParam;
      const a = ref(e.startPointId, sx, sy), b = ref(e.endPointId, sx + g.dirX * len, sy + g.dirY * len);
      const gid = `l${++ln}`; geom.push({ id: gid, t: "line", a, b, ...construction }); idOf.set(e.entityId, gid);
    } else if (g.btType === "BTCurveGeometryCircle-115") {
      const c = ref(e.centerId, g.xCenter, g.yCenter);
      if (e.btType === "BTMSketchCurveSegment-155" && e.startPointId) {
        const sign = g.clockwise ? -1 : 1, x0 = Math.atan2(g.yDir, g.xDir);
        const at = (t) => [g.xCenter + g.radius * Math.cos(x0 + sign * t), g.yCenter + g.radius * Math.sin(x0 + sign * t)];
        const sp = at(e.startParam), ep = at(e.endParam);
        const [s, en] = g.clockwise ? [ref(e.endPointId, ...ep), ref(e.startPointId, ...sp)] : [ref(e.startPointId, ...sp), ref(e.endPointId, ...ep)];
        const gid = `a${++an}`; geom.push({ id: gid, t: "arc", c, s, e: en, ...construction }); idOf.set(e.entityId, gid);
      } else { const gid = `c${++cn}`; geom.push({ id: gid, t: "circle", c, r: r6(g.radius / M), ...construction }); idOf.set(e.entityId, gid); }
    } else warnings.push(`Sketch "${raw.name}": skipped an unsupported curve (${g.btType ?? e.btType})`);
  }
  const target = (local) => { if (idOf.has(local)) return idOf.get(local); const base = String(local).split(".")[0]; const kind = String(local).split(".")[1]; const g = geom.find((x) => x.id === idOf.get(base)); if (!g) return holder.get(find(local)) ?? null;
    if (kind === "center") return g.c; if (kind === "start") return g.t === "line" ? g.a : g.s; if (kind === "end") return g.t === "line" ? g.b : g.e; return null; };
  const KIND = { HORIZONTAL: "horizontal", VERTICAL: "vertical", PARALLEL: "parallel", PERPENDICULAR: "perpendicular", EQUAL: "equal", TANGENT: "tangent", CONCENTRIC: "concentric", MIDPOINT: "midpoint", FIX: "fix" };
  for (const c of raw.constraints ?? []) {
    const type = c.constraintType; const a = target(pv(c, "localFirst")), b = pv(c, "localSecond") ? target(pv(c, "localSecond")) : null;
    const kid = `k${++kn}`;
    const exprOf = (id2) => fromOsExpr(param(c, id2)?.expression);
    if (type === "COINCIDENT") {
      const ta = a && geom.find((g) => g.id === a), tb = b && geom.find((g) => g.id === b);
      if (ta?.t === "point" && tb?.t === "point") continue; // already merged
      if (ta?.t === "point" && tb) cons.push({ id: kid, t: "on", a, b }); else if (tb?.t === "point" && ta) cons.push({ id: kid, t: "on", a: b, b: a });
      continue;
    }
    if (!a) { warnings.push(`Sketch "${raw.name}": skipped ${type}`); continue; }
    if (KIND[type]) { cons.push({ id: kid, t: KIND[type], a, ...(b ? { b } : {}) }); continue; }
    if (type === "LENGTH") cons.push({ id: kid, t: "dim", k: "length", a, v: exprOf("length") });
    else if (type === "DISTANCE") {
      const dir = param(c, "direction")?.value, ta = geom.find((g) => g.id === a);
      cons.push({ id: kid, t: "dim", k: dir === "HORIZONTAL" ? "hdist" : dir === "VERTICAL" ? "vdist" : ta?.t === "point" && geom.find((g) => g.id === b)?.t === "line" ? "pdist" : "dist", a, b, v: exprOf("length") });
    } else if (type === "RADIUS") cons.push({ id: kid, t: "dim", k: "radius", a, v: exprOf(param(c, "length") ? "length" : "radius") });
    else if (type === "DIAMETER") cons.push({ id: kid, t: "dim", k: "diameter", a, v: exprOf(param(c, "length") ? "length" : "radius") });
    else if (type === "ANGLE") cons.push({ id: kid, t: "dim", k: "angle", a, b, v: exprOf("angle") });
    else warnings.push(`Sketch "${raw.name}": skipped Onshape constraint ${type}`);
  }
  return { plane, geom, cons };
}

/**
 * Onshape feature list -> cadSlop part. `idMap` maps Onshape featureId -> existing cadSlop id so ids stay stable.
 */
export function onshapeToPart(rawFeatures, { idMap = {}, name } = {}) {
  const variables = {}, features = [], warnings = [], varIds = {};
  const idFor = (type, osId) => idMap[osId] ?? stableId(type, osId);
  for (const raw of rawFeatures) {
    const osId = raw.featureId;
    if (raw.featureType === "assignVariable") {
      const t = param(raw, "variableType")?.value;
      const n = param(raw, "name")?.value, v = (param(raw, { ANGLE: "angleValue", NUMBER: "numberValue", ANY: "anyValue" }[t] ?? "lengthValue") ?? param(raw, "value"))?.expression;
      if (n && v !== undefined) { variables[n] = fromOsExpr(v); varIds[n] = osId; continue; }
    }
    let f = null;
    if (raw.btType === "BTMSketch-151") {
      const s = importSketch(raw, idFor("sketch", osId), warnings, (os) => features.find((x) => x.osId === os && x.type === "plane")?.id ?? null);
      if (s) f = { id: idFor("sketch", osId), type: "sketch", name: raw.name, plane: s.plane, offset: 0, geom: s.geom, cons: s.cons };
    } else if (raw.featureType === "cPlane" && param(raw, "cplaneType")?.value === "OFFSET") {
      const pr = planeRefOf(param(raw, "entities")?.queries?.[0]);
      const from = pr?.std ?? (pr?.osId ? features.find((x) => x.osId === pr.osId && x.type === "plane")?.id : null);
      const off = fromOsExpr(param(raw, "offset")?.expression ?? "0 mm");
      if (from && param(raw, "entities")?.queries?.length === 1) {
        const neg = !!param(raw, "oppositeDirection")?.value;
        f = { id: idFor("plane", osId), type: "plane", name: raw.name, mode: "offset", from, distance: neg ? (typeof off === "number" ? -off : `-(${off})`) : off };
      }
    } else if (raw.featureType === "extrude") {
      const q = param(raw, "entities")?.queries?.[0];
      const skOs = q?.featureId ?? String(q?.queryString ?? "").match(/qSketchRegion\(\s*makeId\(\s*"([^"]+)"/)?.[1], skFeat = features.find((x) => x.osId === skOs);
      const bound = param(raw, "endBound")?.value;
      if (skFeat && (q?.btType === "BTMIndividualSketchRegionQuery-140" || /qSketchRegion/.test(q?.queryString ?? "")) && ["BLIND", "SYMMETRIC", "THROUGH_ALL"].includes(bound) && !param(raw, "endBound")?.queries) {
        const op = param(raw, "operationType")?.value;
        f = { id: idFor("extrude", osId), type: "extrude", name: raw.name, sketch: skFeat.id,
          distance: bound === "THROUGH_ALL" ? 10 : fromOsExpr(param(raw, "depth")?.expression ?? "10 mm"), mode: { NEW: "new", ADD: "add", REMOVE: "cut", INTERSECT: "intersect" }[op] ?? "add" };
        if (bound === "SYMMETRIC") f.symmetric = true;
        if (bound === "THROUGH_ALL") f.through = true;
        if (param(raw, "oppositeDirection")?.value) f.flip = true;
        if (param(raw, "startOffset")?.value && bound !== "THROUGH_ALL") {
          const d = fromOsExpr(param(raw, "startOffsetDistance")?.expression ?? "0 mm");
          skFeat.offset = param(raw, "startOffsetOppositeDirection")?.value ? (typeof d === "number" ? -d : `-(${d})`) : d;
        }
      }
    }
    else if (["fillet", "chamfer", "shell"].includes(raw.featureType)) {
      const kind = raw.featureType === "shell" ? "FACE" : "EDGE";
      const refs = refsFromQueries(param(raw, "entities")?.queries, kind);
      const sizeId = { fillet: "radius", chamfer: "width", shell: "thickness" }[raw.featureType];
      const size = param(raw, sizeId)?.expression;
      if (refs && size !== undefined) {
        f = { id: idFor(raw.featureType, osId), type: raw.featureType, name: raw.name, ...(raw.featureType === "shell" ? { faces: refs, thickness: fromOsExpr(size) } : { edges: refs, radius: fromOsExpr(size) }) };
      }
    }
    if (f) { f.osId = osId; if (raw.suppressed) f.suppressed = true; features.push(f); continue; }
    warnings.push(`Onshape feature "${raw.name}" (${raw.featureType ?? raw.btType}) can't be edited here; kept as-is`);
    features.push({ id: idFor("onshape", osId), type: "onshape", name: raw.name, osId, ...(raw.suppressed ? { suppressed: true } : {}) });
  }
  return { part: { ...(name ? { name } : {}), variables, features }, warnings, varIds };
}
