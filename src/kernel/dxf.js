// Minimal ASCII DXF support for sketches: LINE, CIRCLE, ARC, LWPOLYLINE (with bulges) and POLYLINE/VERTEX.
const TAU = 2 * Math.PI;

export function parseDXF(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let units = 4; // millimetres unless the header says otherwise
  for (let i = 0; i < pairs.length; i++) if (pairs[i][0] === 9 && pairs[i][1] === "$INSUNITS" && pairs[i + 1]) units = parseInt(pairs[i + 1][1], 10);
  const scale = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 }[units] ?? 1;
  const start = pairs.findIndex((p, i) => p[0] === 2 && p[1] === "ENTITIES" && pairs[i - 1]?.[1] === "SECTION");
  if (start < 0) throw new Error("This doesn't look like an ASCII DXF file (no ENTITIES section)");
  const ents = []; let cur = null; let polyOpen = null;
  const flush = () => { if (cur) { ents.push(cur); cur = null; } };
  for (let i = start + 1; i < pairs.length; i++) {
    const [code, val] = pairs[i];
    if (code === 0) {
      if (val === "ENDSEC") { flush(); break; }
      if (val === "VERTEX" && polyOpen) { polyOpen.pts.push({ x: 0, y: 0, bulge: 0 }); cur = { type: "VERTEX" }; continue; }
      if (val === "SEQEND") { flush(); if (polyOpen) { ents.push(polyOpen); polyOpen = null; } continue; }
      flush();
      if (val === "POLYLINE") { polyOpen = { type: "LWPOLYLINE", pts: [], closed: false }; cur = { type: "POLYLINE" }; }
      else if (["LINE", "CIRCLE", "ARC", "LWPOLYLINE"].includes(val)) cur = { type: val, pts: [], closed: false };
      else cur = { type: "SKIP" };
      continue;
    }
    if (!cur || cur.type === "SKIP") continue;
    const n = parseFloat(val);
    if (cur.type === "LINE") { if (code === 10) cur.x1 = n; if (code === 20) cur.y1 = n; if (code === 11) cur.x2 = n; if (code === 21) cur.y2 = n; }
    else if (cur.type === "CIRCLE" || cur.type === "ARC") { if (code === 10) cur.cx = n; if (code === 20) cur.cy = n; if (code === 40) cur.r = n; if (code === 50) cur.a0 = n; if (code === 51) cur.a1 = n; }
    else if (cur.type === "LWPOLYLINE") { if (code === 70) cur.closed = (parseInt(val, 10) & 1) === 1; if (code === 10) cur.pts.push({ x: n, y: 0, bulge: 0 }); if (code === 20 && cur.pts.length) cur.pts.at(-1).y = n; if (code === 42 && cur.pts.length) cur.pts.at(-1).bulge = n; }
    else if (cur.type === "POLYLINE") { if (code === 70) polyOpen.closed = (parseInt(val, 10) & 1) === 1; }
    else if (cur.type === "VERTEX") { const v = polyOpen.pts.at(-1); if (code === 10) v.x = n; if (code === 20) v.y = n; if (code === 42) v.bulge = n; }
  }
  flush();
  return { entities: ents.filter((e) => e.type !== "SKIP" && e.type !== "POLYLINE" && e.type !== "VERTEX"), scale };
}

/** Convert parsed DXF entities into sketch geometry. `used` is a Set of ids already taken in the sketch. */
export function dxfToGeom(parsed, used = new Set()) {
  const { entities, scale } = parsed, geom = [];
  const take = (prefix) => { let n = 1; while (used.has(`${prefix}${n}`)) n++; used.add(`${prefix}${n}`); return `${prefix}${n}`; };
  const pmap = new Map();
  const point = (x, y) => {
    x *= scale; y *= scale;
    const key = `${Math.round(x * 1e3)},${Math.round(y * 1e3)}`; // merge points within 1 micron
    if (!pmap.has(key)) { const id = take("p"); pmap.set(key, id); geom.push({ id, t: "point", x: Math.round(x * 1e5) / 1e5, y: Math.round(y * 1e5) / 1e5 }); }
    return pmap.get(key);
  };
  const arcBy = (c, s, e, ccw = true) => geom.push({ id: take("a"), t: "arc", c, s: ccw ? s : e, e: ccw ? e : s });
  const bulgeSeg = (p1, p2, b) => {
    if (Math.abs(b) < 1e-9) { if (p1 !== p2) geom.push({ id: take("l"), t: "line", a: p1, b: p2 }); return; }
    const A = geom.find((g) => g.id === p1), B = geom.find((g) => g.id === p2);
    const chord = Math.hypot(B.x - A.x, B.y - A.y), theta = 4 * Math.atan(b), r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, h = r * Math.cos(theta / 2), nx = -(B.y - A.y) / chord, ny = (B.x - A.x) / chord, sgn = b > 0 ? 1 : -1;
    const c = point((mx + nx * h * sgn) / scale, (my + ny * h * sgn) / scale);
    arcBy(c, p1, p2, b > 0);
  };
  for (const e of entities) {
    if (e.type === "LINE") { const a = point(e.x1, e.y1), b = point(e.x2, e.y2); if (a !== b) geom.push({ id: take("l"), t: "line", a, b }); }
    else if (e.type === "CIRCLE") geom.push({ id: take("c"), t: "circle", c: point(e.cx, e.cy), r: Math.round(e.r * scale * 1e5) / 1e5 });
    else if (e.type === "ARC") {
      const a0 = (e.a0 * Math.PI) / 180, a1 = (e.a1 * Math.PI) / 180;
      arcBy(point(e.cx, e.cy), point(e.cx + e.r * Math.cos(a0), e.cy + e.r * Math.sin(a0)), point(e.cx + e.r * Math.cos(a1), e.cy + e.r * Math.sin(a1)));
    } else if (e.type === "LWPOLYLINE") {
      const ids = e.pts.map((p) => point(p.x, p.y));
      for (let i = 0; i < ids.length - (e.closed ? 0 : 1); i++) bulgeSeg(ids[i], ids[(i + 1) % ids.length], e.pts[i].bulge);
    }
  }
  if (!geom.length) throw new Error("No lines, arcs, circles or polylines found in that DXF");
  return geom;
}

const f = (x) => (Math.round(x * 1e6) / 1e6).toString();
/** Solved sketch geometry -> ASCII DXF (millimetres). Construction geometry is skipped. */
export function sketchToDXF(geom) {
  const G = new Map(geom.map((g) => [g.id, g]));
  const out = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  const add = (...a) => out.push(...a.map(String));
  let n = 0;
  for (const g of geom) {
    if (g.construction) continue;
    if (g.t === "line") { const a = G.get(g.a), b = G.get(g.b); add(0, "LINE", 8, "0", 10, f(a.x), 20, f(a.y), 30, 0, 11, f(b.x), 21, f(b.y), 31, 0); n++; }
    else if (g.t === "circle") { const c = G.get(g.c); add(0, "CIRCLE", 8, "0", 10, f(c.x), 20, f(c.y), 30, 0, 40, f(g.r)); n++; }
    else if (g.t === "arc") {
      const c = G.get(g.c), s = G.get(g.s), e = G.get(g.e), r = Math.hypot(s.x - c.x, s.y - c.y);
      const d = (a) => ((a * 180) / Math.PI + 360) % 360;
      add(0, "ARC", 8, "0", 10, f(c.x), 20, f(c.y), 30, 0, 40, f(r), 50, f(d(Math.atan2(s.y - c.y, s.x - c.x))), 51, f(d(Math.atan2(e.y - c.y, e.x - c.x)))); n++;
    }
  }
  add(0, "ENDSEC", 0, "EOF");
  if (!n) throw new Error("This sketch has no lines, arcs or circles to export");
  return out.join("\n") + "\n";
}
void TAU;
