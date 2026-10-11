// Lift each designed part's feature chain out of the cadSlop robot part and write it as its own cadForMe part:
// bodies renumbered (the part is body 0, each tool the next one), legacy sketch shapes turned into dimensioned
// points/lines/circles on a standard plane + offset (so Onshape gets real sketches).
import fs from "node:fs";
import path from "node:path";
const SRC = process.argv[2], OUT = process.argv[3];
const part = JSON.parse(fs.readFileSync(SRC, "utf8"));
const F = part.features;
const PARTS = ["Transfer side plate A (3 mm, new profile)", "Transfer side plate B (3 mm, new profile)", "Transfer floor piece 1 (3D-printed PETG)",
  "Transfer floor piece 2 (3D-printed PETG)", "Transfer floor piece 3 (3D-printed PETG)", "Funnel side A (3D-printed PETG, one solid)", "Funnel side B (3D-printed PETG, one solid)",
  "Bracket A, transfer plate to cross channel #8 (3D-printed PETG)", "Bracket B, transfer plate to cross channel #8 (3D-printed PETG)",
  "Bracket A, transfer plate to rear channel #22 (3D-printed PETG)", "Bracket B, transfer plate to rear channel #22 (3D-printed PETG)",
  "Bumper bracket A (3D-printed PETG)", "Bumper bracket B (3D-printed PETG)", "Transfer motor plate (3D-printed PETG, minimal mount)"];
// a feature belongs to a part when its name starts with the part name, or with the short form before " (" (e.g. "Funnel side A, side-plate screw: ...")
const ALIAS = [["Transfer wall (floor piece 3)", "Transfer floor piece 3 (3D-printed PETG)"]];
const owner = (n = "") => ALIAS.find(([a]) => n.startsWith(a))?.[1] ?? PARTS.find((p) => n === p || n.startsWith(p + ":") || n.startsWith(p + " ") || n.startsWith(p.split(" (")[0] + ",") || n.startsWith(p.split(" (")[0] + ":"));
const byId = new Map(F.map((f) => [f.id, f]));
const MAKES = new Set(["box", "cylinder", "extrude", "revolve", "sphere", "loft", "sweep", "gear", "coil"]);   // imports/inserts are vendor parts: they end a chain
const chains = new Map(); let pending = [];
const report = [];
for (const f of F) {
  if (f.suppressed || f.type === "sketch" || f.type === "plane") continue;
  const own = owner(f.name);
  const makesNew = MAKES.has(f.type) && (f.mode ?? "add") === "new";
  if (own && makesNew && !chains.has(own)) { chains.set(own, { main: [f], items: [], base: null }); pending = []; continue; }
  if (f.type === "boolean" && own && chains.has(own)) {
    chains.get(own).items.push({ pending, f });
    pending = [];
    continue;
  }
  if (makesNew || f.type === "boolean" || f.type === "transform" || f.type === "mirror") pending.push(f);
  else pending = [];   // something else happened (imports etc.): tools before it can't belong to the next part
}
// the part's own body number: the lowest body its booleans work on; booleans on other bodies (e.g. holes the source
// cut into the main side plates) are dropped together with the tool they used
for (const [name, ch] of chains) {
  ch.base = Math.min(...ch.items.map((x) => Number(x.f.a)));
  const items = [];
  for (const { pending: pend, f } of ch.items) {
    const keep = [];
    for (const p of pend) {
      if (p.type === "boolean" && Number(p.a) < ch.base) {
        const k = keep.map((x) => MAKES.has(x.type)).lastIndexOf(true);
        if (k >= 0) keep.splice(k, 1);
        report.push(`${name}: left out "${p.name}" (works on another part)`);
      } else keep.push(p);
    }
    items.push(...keep.map((p) => ({ f: p, base: ch.base })), { f, base: ch.base });
  }
  ch.items = items;
}
// ---- legacy sketch shapes -> geom/cons on a standard plane ----
const STD = { XY: { x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] }, XZ: { x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] }, YZ: { x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] } };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const r4 = (v) => Math.round(v * 1e4) / 1e4;
function convertSketch(sk) {
  if (typeof sk.plane === "string") return { sk, flip: false };
  const n = sk.plane.normal, xd = sk.plane.xDir, yd = cross(n, xd), o = sk.plane.origin;
  const std = Object.entries(STD).find(([, s]) => Math.abs(Math.abs(dot(s.n, n)) - 1) < 1e-9)?.[0];
  if (!std) throw new Error(`sketch ${sk.id} isn't parallel to a standard plane`);
  const S = STD[std], flip = dot(S.n, n) < 0;
  const to2 = (u, v) => { const w = [0, 1, 2].map((k) => o[k] + u * xd[k] + v * yd[k]); return [r4(dot(w, S.x)), r4(dot(w, S.y))]; };
  const geom = [], cons = []; let k = 0; const id = (p) => `${p}${++k}`;
  const dimPt = (pid, x, y) => { cons.push({ id: id("d"), t: "dim", k: "x", a: pid, v: x }, { id: id("d"), t: "dim", k: "y", a: pid, v: y }); };
  const loop = (pts) => {
    const ids = pts.map(([x, y]) => { const pid = id("p"); geom.push({ id: pid, t: "point", x, y }); dimPt(pid, x, y); return pid; });
    ids.forEach((a, i) => geom.push({ id: id("l"), t: "line", a, b: ids[(i + 1) % ids.length] }));
  };
  // outline of each shape (2D, sketch coords) so subtracted shapes can be checked to lie inside an added one
  const outline = (e) => { const cx = e.cx ?? 0, cy = e.cy ?? 0, ang = ((e.angle ?? 0) * Math.PI) / 180, pl = ([x, y]) => [cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)];
    if (e.type === "circle") return [...Array(24).keys()].map((i) => [cx + e.r * Math.cos(i * Math.PI / 12), cy + e.r * Math.sin(i * Math.PI / 12)]);
    if (e.type === "polygon") { const n = Math.round(e.sides); return [...Array(n).keys()].map((i) => { const t = -(2 * Math.PI / n) * i; return pl([e.r * Math.sin(t), e.r * Math.cos(t)]); }); }
    if (e.type === "rect") return [[-e.w / 2, -e.h / 2], [e.w / 2, -e.h / 2], [e.w / 2, e.h / 2], [-e.w / 2, e.h / 2]].map(pl);
    if (e.type === "polyline") return e.points; return null; };
  const inside = ([x, y], poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const addEnts = (sk.entities ?? []).filter((e) => (e.op ?? "add") === "add");
  const adds = addEnts.map(outline);
  // an added shape lying fully inside another added shape adds nothing, but as a loop inside a loop it would become a hole
  const redundant = new Set(addEnts.filter((e, i) => adds.some((a, j) => j !== i && adds[i].every((q) => inside(q, a)))));
  const cutAfter = [];
  for (const e of sk.entities ?? []) {
    if (redundant.has(e)) continue;
    if ((e.op ?? "add") !== "add") {
      const ol = outline(e);
      if (!adds.some((a) => ol.every((q) => inside(q, a)))) { cutAfter.push(e); continue; }   // crosses the outline: cut separately
    }
    const cx = e.cx ?? 0, cy = e.cy ?? 0, ang = ((e.angle ?? 0) * Math.PI) / 180;
    const place = ([x, y]) => to2(cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang));
    if (e.type === "circle") {
      const [x, y] = to2(cx, cy), c = id("p"), ci = id("c");
      geom.push({ id: c, t: "point", x, y }, { id: ci, t: "circle", c, r: e.r }); dimPt(c, x, y); cons.push({ id: id("d"), t: "dim", k: "diameter", a: ci, v: r4(2 * e.r) });
    } else if (e.type === "polygon") {
      const n = Math.round(e.sides); loop([...Array(n).keys()].map((i) => { const t = -(2 * Math.PI / n) * i; return place([e.r * Math.sin(t), e.r * Math.cos(t)]); }));
    } else if (e.type === "rect") {
      if (e.r) throw new Error(`sketch ${sk.id}: rounded rect not handled`);
      const w = e.w / 2, h = e.h / 2; loop([[-w, -h], [w, -h], [w, h], [-w, h]].map(place));
    } else if (e.type === "polyline") {
      loop(e.points.map(([x, y]) => to2(x, y)));
    } else throw new Error(`sketch ${sk.id}: ${e.type} not handled`);
  }
  for (const g of sk.geom ?? []) throw new Error(`sketch ${sk.id} already has geom (not expected here)`);
  const offset = r4(dot(o, S.n));
  let cut = null;
  if (cutAfter.length) cut = convertSketch({ ...sk, id: sk.id + "c", name: sk.name + " (cut)", entities: cutAfter.map((e) => ({ ...e, op: "add" })) }).sk;
  return { sk: { id: sk.id, type: "sketch", name: sk.name, plane: std, ...(offset ? { offset } : {}), geom, cons }, flip, cut };
}
// do any two shapes of a sketch overlap (bounding boxes, a little margin)? then they can't share one sketch
function shapeBox(e) {
  const cx = e.cx ?? 0, cy = e.cy ?? 0;
  if (e.type === "circle" || e.type === "polygon") return [cx - e.r, cy - e.r, cx + e.r, cy + e.r];
  if (e.type === "rect") { const a = ((e.angle ?? 0) * Math.PI) / 180, w = e.w / 2, h = e.h / 2, ex = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a)), ey = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)); return [cx - ex, cy - ey, cx + ex, cy + ey]; }
  const xs = e.points.map((q) => q[0]), ys = e.points.map((q) => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function overlapping(ents) {
  const b = ents.map(shapeBox), m = 0.01;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (b[i][0] < b[j][2] + m && b[j][0] < b[i][2] + m && b[i][1] < b[j][3] + m && b[j][1] < b[i][3] + m) return true;
  return false;
}
// (2) "make a tool, then subtract / add / intersect it" with the part as the only body -> one direct feature
// (Extrude remove / add / intersect), the way a person models it. Multi-shape subtract/add tools become one feature per shape.
const BODY = new Set(["extrude", "box", "cylinder", "revolve"]);
function simplify(feats) {
  const out = []; let i = 0;
  const isBody = (f) => BODY.has(f.type) && (f.mode ?? "add") === "new";
  while (i < feats.length) {
    // collect a tool run: body-making features (with their sketches) and joins between them, ending in a boolean on body 0
    let j = i, tools = [], joins = 0, ok = out.some((f) => isBody(f) || f.mode === "add" || f.mode === "cut");   // the part exists
    const seq = [];
    while (j < feats.length && (feats[j].type === "sketch" || isBody(feats[j]) || (feats[j].type === "boolean" && feats[j].a !== 0))) {
      seq.push(feats[j]); if (isBody(feats[j])) tools.push(feats[j]); if (feats[j].type === "boolean") { joins++; if (feats[j].op !== "union") ok = false; } j++;
    }
    const fin = feats[j];
    if (ok && tools.length && tools.length === joins + 1 && fin?.type === "boolean" && fin.a === 0 && fin.b === 1 && !(fin.op === "intersect" && tools.length > 1)) {
      const mode = { subtract: "cut", union: "add", intersect: "intersect" }[fin.op];
      for (const f of seq) if (f.type !== "boolean") out.push(isBody(f) ? { ...f, name: tools.length > 1 ? `${fin.name ?? f.name} (${f.name})` : (fin.name ?? f.name), mode } : f);
      i = j + 1; continue;
    }
    out.push(feats[i]); i++;
  }
  return out;
}
// ---- write the parts ----
fs.mkdirSync(OUT, { recursive: true });
const slug = (s) => s.replace(/\s*\(.*$/, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
const written = [];
for (const name of PARTS) {
  const ch = chains.get(name);
  if (!ch) { report.push(`${name}: no features found`); continue; }
  const feats = [], sketches = new Map();
  let count = 0;   // bodies in the extracted part: the part itself is 0, tools stack up after it
  const add = (f, base) => {
    let g = structuredClone(f);
    if (base !== null && g.type === "boolean") {
      if (Number(f.a) === base) { g.a = 0; g.b = count - 1; } else { g.a = count - 2; g.b = count - 1; }
      if (g.b < 1 || g.a < 0) report.push(`${name}: boolean "${g.name}" has no tool to use`);
    } else if (base !== null && ["transform", "mirror"].includes(g.type) && g.body !== undefined) g.body = count - 1;
    if (g.type === "extrude" && count > 0) {   // a tool made of overlapping shapes: one extrude each, joined
      const s = byId.get(g.sketch), addsE = (s.entities ?? []).filter((e) => (e.op ?? "add") === "add");
      if (addsE.length > 1 && overlapping(addsE)) {
        if (addsE.length !== (s.entities ?? []).length) report.push(`${name}: tool "${g.name}" has several shapes and holes`);
        addsE.forEach((e, i) => {
          const c = convertSketch({ ...s, id: `${s.id}_${i}`, name: `${s.name} (${e.type} ${i + 1})`, entities: [e] });
          feats.push(c.sk, { ...g, id: `${g.id}_${i}`, name: `${g.name} (${e.type} ${i + 1})`, sketch: c.sk.id, flip: c.flip ? !g.flip : g.flip, mode: "new" }); count++;
          if (i) { feats.push({ id: `${g.id}_u${i}`, type: "boolean", name: `${g.name}: join`, a: count - 2, b: count - 1, op: "union" }); count--; }
        });
        return;
      }
    }
    if (g.type === "extrude" && count === 0) {
      const s = byId.get(g.sketch), addsE = (s.entities ?? []).filter((e) => (e.op ?? "add") === "add");
      if (addsE.length > 1 && overlapping(addsE)) {
        const subs = (s.entities ?? []).filter((e) => (e.op ?? "add") !== "add");
        addsE.forEach((e, i) => {
          const c = convertSketch({ ...s, id: `${s.id}_${i}`, name: `${s.name} ${i ? `(${e.type} ${i})` : "(outline)"}`, entities: [e] });
          feats.push(c.sk, { ...g, id: `${g.id}_${i}`, name: i ? `${g.name}: ${e.type} ${i}` : g.name, sketch: c.sk.id, flip: c.flip ? !g.flip : g.flip, mode: "new" });
          if (i) feats.push({ id: `${g.id}_u${i}`, type: "boolean", name: `${g.name}: join ${e.type} ${i}`, a: 0, b: 1, op: "union" });
        });
        if (subs.length) {
          const c = convertSketch({ ...s, id: `${s.id}_h`, name: `${s.name} (holes)`, entities: subs.map((e) => ({ ...e, op: "add" })) });
          feats.push(c.sk, { ...g, id: `${g.id}_h`, name: `${g.name}: holes`, sketch: c.sk.id, flip: c.flip ? !g.flip : g.flip, mode: "cut" });
        }
        count = 1; return;
      }
    }
    if (g.type === "extrude") {
      const s = byId.get(g.sketch);
      if (!sketches.has(s.id)) { const c = convertSketch(s); sketches.set(s.id, c); feats.push(c.sk); }
      if (sketches.get(s.id).flip) g.flip = !g.flip;
      const cut = sketches.get(s.id).cut;
      if (cut) {
        if (feats.some((x) => x !== sketches.get(s.id).sk && x.type !== "sketch")) report.push(`${name}: "${g.name}" has shapes cut across its outline while other bodies exist`);
        feats.push(g, cut, { id: g.id + "c", type: "extrude", name: g.name + " (cut)", sketch: cut.id, distance: g.distance, flip: g.flip, mode: "cut" });
        if ((g.mode ?? "add") === "new") count++;
        return;
      }
    }
    feats.push(g);
    if ((g.mode ?? "add") === "new" && MAKES.has(g.type)) count++;
    if (g.type === "boolean") count--;
    if (g.type === "transform" && g.copy) count++;
  };
  const FLUSH = { "Funnel side A (3D-printed PETG, one solid)": { y0: 355.2, y1: 380 }, "Funnel side B (3D-printed PETG, one solid)": { y0: -80, y1: -53.8 } };
  for (const f of ch.main) add(f, null);
  for (const { f, base } of ch.items) {
    if (f.type === "transform" && /side plate . \(cutter\)/.test(f.name ?? "")) continue;   // a copy of the main side plate: replaced below
    if (f.type === "boolean" && /sit flush on the side plate/.test(f.name ?? "") && FLUSH[name]) {
      const { y0, y1 } = FLUSH[name];
      feats.push({ id: f.id + "s", type: "box", name: "Side plate's inner face (cutter)", position: [0, (y0 + y1) / 2, -300], w: 1000, d: y1 - y0, h: 600, mode: "new" }); count++;
      add({ ...f, a: base }, base); continue;
    }
    add(f, base);
  }
  const neg = feats.filter((f) => ["a", "b"].some((k) => typeof f[k] === "number" && f[k] < 0));
  if (neg.length) report.push(`${name}: ${neg.length} feature(s) refer to bodies outside the part (${neg.map((f) => f.name).slice(0, 3).join("; ")})`);
  const out = { name: name.replace(/\s*\(.*\)$/, ""), description: name, variables: {}, features: simplify(feats) };
  const file = path.join(OUT, `${slug(name)}.part.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  written.push({ name, file: path.basename(file), features: feats.length, booleans: feats.filter((f) => f.type === "boolean").length });
}
for (const [k, f] of F.entries()) if (f.type === "boolean" && !owner(f.name) && /floor|funnel|bracket|transfer|bumper|motor plate|wall/i.test(f.name ?? "") && !/side plate [AB] for|in side plate/i.test(f.name ?? "")) report.push(`unclaimed boolean #${k}: "${f.name}" (a=${f.a}, b=${f.b})`);
console.log(JSON.stringify({ written, report }, null, 1));
