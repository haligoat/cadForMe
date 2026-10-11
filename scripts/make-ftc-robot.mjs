// Generates the BIOBUZZ FTC robot as one multi-part Part Studio (linked to Onshape), keeping its Onshape link, plus a BOM.
// Built from goBILDA / REV COTS parts modelled from their published sizes and hole patterns (goBILDA 1120 U-channel with the
// 14 mm + 4 mm hole pattern on a 24 mm pitch, 5203 Yellow Jacket motors inside the channel, 8 mm REX shafts, M4 hardware),
// plus a few custom plates. Every part is an offset construction plane + a fully dimensioned sketch + an extrude.
// Axes: X = robot width (right +), Y = forward (+, intake end), Z = up. Units mm. Fits the 18 in (457 mm) sizing cube.
// Usage: node scripts/make-ftc-robot.mjs <project dir> [part name]
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "examples/ftc-robot";
const rel = `parts/${process.argv[3] ?? "onshape-part"}.part.json`;
const file = path.join(dir, rel);
const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};

const V = {
  ch: 48,            // goBILDA 1120 U-channel outside size
  ch_t: 2.5,         // channel wall
  pitch: 24,         // goBILDA hole pitch
  big_hole: 14,      // channel centre-line holes (bearings / shafts)
  m4: 4,             // M4 clearance holes
  rail_len: 360,     // 1120-0015-0360 (15 holes)
  cross_len: 264,    // 1120-0011-0264 (11 holes)
  wheel_d: 104,      // goBILDA 104 mm mecanum
  wheel_w: 38,
  wheelbase: 288,    // axles in the rail's 14 mm holes, 12 holes apart
  axle_h: 52,        // = wheel radius, = channel centre height
  motor_d: 37,       // 5203 Yellow Jacket gearbox / can
  motor_len: 105,
  shaft: 8,          // REX shaft
  plate: 4,          // custom plates (6061)
  ball: 71,          // POLLEN
  squish: 12,        // shooter compression
  iw_d: 38,          // 1.5 in intake wheels
  iw_t: 12,
  spx_r: 95,         // spindexer radius
  fly_d: 96,
  fly_w: 100,
  hood_t: 4,
};
const ev = (e) => (typeof e === "number" ? e : Function(...Object.keys(V), `return (${e});`)(...Object.values(V)));

const features = [];
const bom = [];
let n = 0;
const uid = (p) => `${p}${++n}`;

// ---- construction planes (cached, so parts on the same plane share one; hidden so they don't cover the model) ----
const planes = new Map();
function plane(from, distance) {
  const key = `${from}@${distance}`;
  if (planes.has(key)) return planes.get(key);
  const id = uid("pl");
  const axis = { YZ: "X", XY: "Z", XZ: "-Y" }[from];
  features.push({ id, type: "plane", name: `${axis} = ${distance}`, mode: "offset", from, distance, hidden: true });
  planes.set(key, id);
  return id;
}

// ---- fully-dimensioned sketch builder ----
// Values can be numbers or expression strings like "wheelbase/2"; dimensions keep the expression.
function sketch(name, planeId) {
  const geom = [], cons = [];
  let k = 0;
  const id = (p) => `${p}${++k}`;
  const pt = (x, y) => { const i = id("p"); geom.push({ id: i, t: "point", x: +ev(x).toFixed(4), y: +ev(y).toFixed(4) }); return i; };
  const line = (a, b) => { const i = id("l"); geom.push({ id: i, t: "line", a, b }); return i; };
  const con = (t, a, b) => cons.push({ id: id("k"), t, a, ...(b ? { b } : {}) });
  const dim = (kind, a, b, v) => cons.push({ id: id("d"), t: "dim", k: kind, a, ...(b ? { b } : {}), v });
  const at = (p, x, y) => { dim("x", p, null, x); dim("y", p, null, y); };
  const s = {
    /** Rectangle from corner (x, y) with width w and height h. */
    rect(x, y, w, h) {
      const x1 = `(${x}) + (${w})`, y1 = `(${y}) + (${h})`;
      const a = pt(x, y), b = pt(x1, y), c = pt(x1, y1), d = pt(x, y1);
      const l1 = line(a, b), l2 = line(b, c), l3 = line(c, d), l4 = line(d, a);
      con("horizontal", l1); con("vertical", l2); con("horizontal", l3); con("vertical", l4);
      at(a, x, y); dim("length", l1, null, w); dim("length", l2, null, h);
      return s;
    },
    /** Circle by centre and diameter. */
    circle(cx, cy, d) { const c = pt(cx, cy); const i = id("c"); geom.push({ id: i, t: "circle", c, r: +(ev(d) / 2).toFixed(4) }); at(c, cx, cy); dim("diameter", i, null, d); return s; },
    /** Closed polygon, every corner dimensioned. */
    poly(pts) { const ids = pts.map(([x, y]) => { const p = pt(x, y); at(p, x, y); return p; }); ids.forEach((a, i) => line(a, ids[(i + 1) % ids.length])); return s; },
    /** Curved band between radii r0..r1, from angle a0 to a1 (deg, CCW), around (cx, cy). */
    band(cx, cy, r0, r1, a0, a1) {
      const P = (r, a) => [ev(cx) + ev(r) * Math.cos((a * Math.PI) / 180), ev(cy) + ev(r) * Math.sin((a * Math.PI) / 180)];
      const c = pt(cx, cy);
      const os = pt(...P(r1, a0)), oe = pt(...P(r1, a1)), is = pt(...P(r0, a0)), ie = pt(...P(r0, a1));
      const ao = id("a"), ai = id("a");
      geom.push({ id: ao, t: "arc", c, s: os, e: oe }, { id: ai, t: "arc", c, s: is, e: ie });
      const ls = line(is, os), le = line(ie, oe);
      at(c, cx, cy); dim("radius", ao, null, r1); dim("radius", ai, null, r0);
      con("on", c, ls); con("on", c, le);                         // ends are radial
      const h = pt(ev(cx) + 20, cy), ref = id("l"); geom.push({ id: ref, t: "line", a: c, b: h, construction: true });
      con("horizontal", ref); dim("length", ref, null, 20);
      if (a0 < 0) dim("angle", ls, ref, -a0); else dim("angle", ref, ls, a0);  // keep angle values positive
      dim("angle", ref, le, a1);
      return s;
    },
    done() { const i = uid("sk"); features.push({ id: i, type: "sketch", name, plane: planeId, offset: 0, geom, cons }); return i; },
  };
  return s;
}
/** Extrude; `item` adds a BOM line: [qty, source, part number, note]. */
function extrude(name, sk, distance, mode = "new", item) {
  const i = uid("ex"); features.push({ id: i, type: "extrude", name, sketch: sk, distance, mode });
  if (item) bom.push({ name, qty: item[0], source: item[1], sku: item[2], note: item[3] ?? "" });
  return i;
}

// Sketch-plane local axes: YZ -> (Y, Z), extrudes +X;  XY -> (X, Y), extrudes +Z;  XZ -> (X, Z), plane at Y = -offset, extrudes -Y.
const alongX = (name, x0, len, draw, item, mode) => extrude(name, draw(sketch(`${name} sketch`, plane("YZ", x0))).done(), len, mode, item);
const alongZ = (name, z0, len, draw, item, mode) => extrude(name, draw(sketch(`${name} sketch`, plane("XY", z0))).done(), len, mode, item);
const alongY = (name, yTop, len, draw, item, mode) => extrude(name, draw(sketch(`${name} sketch`, plane("XZ", -yTop))).done(), len, mode, item);
const range = (a, b, step) => { const out = []; for (let v = a; v <= b + 1e-9; v += step) out.push(+v.toFixed(3)); return out; };

const GB = "goBILDA", REV = "REV Robotics", CUSTOM = "Custom (cut from 6061 / printed)";
const RAIL_IN = 132, RAIL_OUT = 180, WEB = 177.5;           // rail X extents (inner flange edge, outside, web inner face)
const AX = 52, WY = 144;                                     // axle height, axle Y (= wheelbase/2)
const CH_Z0 = 28, CH_Z1 = 76;                                // channels sit with their centre on the axle line

// ================= frame: goBILDA 1120 U-channel =================
// Side rails run along Y, open toward the middle so the drive motors sit inside them (the goBILDA way).
const railProfile = (sgn) => (s) => s.poly([[sgn * RAIL_IN, CH_Z0], [sgn * RAIL_OUT, CH_Z0], [sgn * RAIL_OUT, CH_Z1], [sgn * RAIL_IN, CH_Z1],
  [sgn * RAIL_IN, CH_Z1 - 2.5], [sgn * WEB, CH_Z1 - 2.5], [sgn * WEB, CH_Z0 + 2.5], [sgn * RAIL_IN, CH_Z0 + 2.5]]);
alongY("Right rail U-channel", 180, "rail_len", railProfile(1), [1, GB, "1120-0015-0360", "1120 Series U-Channel, 15 hole (360 mm)"]);
alongY("Left rail U-channel", 180, "rail_len", railProfile(-1), [1, GB, "1120-0015-0360", "1120 Series U-Channel, 15 hole (360 mm)"]);
// The channel hole pattern in each rail web: 14 mm holes every 24 mm on the centre line, 4 mm holes between them.
const railHoles = (s) => {
  for (const y of range(-168, 168, 24)) s.circle(y, AX, "big_hole");
  for (const y of range(-156, 156, 24)) for (const z of [AX - 12, AX, AX + 12]) s.circle(y, z, "m4");
  return s;
};
alongX("Right rail hole pattern", 176, 6, railHoles, null, "cut");
alongX("Left rail hole pattern", -182, 6, railHoles, null, "cut");

// Cross members along X between the rails, open side down.
const crossProfile = (y0) => (s) => s.poly([[y0, CH_Z0], [y0 + 2.5, CH_Z0], [y0 + 2.5, CH_Z1 - 2.5], [y0 + 45.5, CH_Z1 - 2.5], [y0 + 45.5, CH_Z0], [y0 + 48, CH_Z0], [y0 + 48, CH_Z1], [y0, CH_Z1]]);
alongX("Front cross U-channel", -RAIL_IN, "cross_len", crossProfile(72), [1, GB, "1120-0011-0264", "1120 Series U-Channel, 11 hole (264 mm)"]);
alongX("Rear cross U-channel", -RAIL_IN, "cross_len", crossProfile(-96), [1, GB, "1120-0011-0264", "1120 Series U-Channel, 11 hole (264 mm)"]);
const crossTopHoles = (s) => {
  for (const yc of [96, -72]) {
    for (const x of range(-120, 120, 24)) s.circle(x, yc, "big_hole");
    for (const x of range(-108, 108, 24)) for (const dy of [-12, 12]) s.circle(x, yc + dy, "m4");
  }
  return s;
};
alongZ("Cross channel top holes", 72, 6, crossTopHoles, null, "cut");

// ================= drive: 4 x 5203 Yellow Jacket + 104 mm mecanum =================
// Motors sit inside the rails, gearbox face on the web, output shaft through the 14 mm hole.
const motorPair = (s) => s.circle(-WY, AX, "motor_d").circle(WY, AX, "motor_d");
alongX("Right drive motors 5203", WEB - 105, "motor_len", motorPair, [2, GB, "5203-2402-0019", "5203 Yellow Jacket, 19.2:1 (312 RPM)"]);
alongX("Left drive motors 5203", -WEB, "motor_len", motorPair, [2, GB, "5203-2402-0019", "5203 Yellow Jacket, 19.2:1 (312 RPM)"]);
// M4 screws through the rail's 4 mm holes into the gearbox face (heads shown on the outside of the web).
const motorScrews = (s) => { for (const y of [-WY, WY]) for (const dy of [-12, 12]) for (const z of [AX - 12, AX + 12]) s.circle(y + dy, z, 7); return s; };
alongX("Right motor screws M4x8", RAIL_OUT, 2.8, motorScrews, [8, GB, "2800-0004-0008", "M4 x 8 mm socket head cap screw"]);
alongX("Left motor screws M4x8", -RAIL_OUT - 2.8, 2.8, motorScrews, [8, GB, "2800-0004-0008", "M4 x 8 mm socket head cap screw"]);
const axles = (s) => s.circle(-WY, AX, "shaft").circle(WY, AX, "shaft");
alongX("Right wheel shafts REX", WEB, 48, axles, [2, GB, "2100-0008-0048", "8 mm REX shaft, 48 mm"]);
alongX("Left wheel shafts REX", -WEB - 48, 48, axles, [2, GB, "2100-0008-0048", "8 mm REX shaft, 48 mm"]);
// 104 mm mecanum: roller tread approximated as a 20-lobe outline, 8 mm REX bore.
const mecanum = (s) => {
  for (const cy of [-WY, WY]) {
    const pts = [];
    for (let i = 0; i < 40; i++) { const a = (i * Math.PI) / 20, r = i % 2 ? 49 : 52; pts.push([+(cy + r * Math.cos(a)).toFixed(3), +(AX + r * Math.sin(a)).toFixed(3)]); }
    s.poly(pts).circle(cy, AX, "shaft");
  }
  return s;
};
alongX("Right mecanum wheels 104mm", 186, "wheel_w", mecanum, [2, GB, "3213-3606-0002", "104 mm GripForce mecanum wheel (verify L/R handedness and SKU)"]);
alongX("Left mecanum wheels 104mm", -186 - 38, "wheel_w", mecanum, [2, GB, "3213-3606-0001", "104 mm GripForce mecanum wheel (verify L/R handedness and SKU)"]);

// ================= electronics deck (custom plate on the cross channels) =================
const DECK_Z = CH_Z1;
alongZ("Electronics deck plate", DECK_Z, "plate", (s) => {
  s.rect(-RAIL_IN, -180, 2 * RAIL_IN, 320);
  for (const yc of [96, -72]) for (const x of [-108, -36, 36, 108]) for (const dy of [-12, 12]) s.circle(x, yc + dy, "m4"); // M4 to the cross channels
  s.circle(0, 40, 12);                                    // spindexer servo output
  s.circle(-40, -120, 24).circle(40, -120, 24);            // wire pass-throughs
  return s;
}, [1, CUSTOM, "—", "4 mm 6061 plate, 264 x 320 mm (export the sketch as DXF)"]);
const deckScrews = (s) => { for (const yc of [96, -72]) for (const x of [-108, 108]) for (const dy of [-12, 12]) s.circle(x, yc + dy, 7); return s; };
alongZ("Deck screws M4x10", DECK_Z + 4, 2.8, deckScrews, [8, GB, "2800-0004-0010", "M4 x 10 mm socket head cap screw"]);

// ================= intake (POLLEN 71 mm) =================
const IY = 205, IZ = 62;
const intakeBracket = (s) => s.rect(165, CH_Z0 + 2, 60, 110).circle(IY, IZ, "shaft");
alongX("Right intake bracket", RAIL_IN - 4, "plate", intakeBracket, [1, CUSTOM, "—", "4 mm 6061 plate"]);
alongX("Left intake bracket", -RAIL_IN, "plate", intakeBracket, [1, CUSTOM, "—", "4 mm 6061 plate"]);
alongX("Intake shaft REX", -RAIL_IN, 2 * RAIL_IN, (s) => s.circle(IY, IZ, "shaft"), [1, GB, "2100-0008-0264", "8 mm REX shaft, 264 mm"]);
for (const cx of [-100, -60, -20, 20, 60, 100]) alongX(`Intake wheel x${cx}`, cx - 6, "iw_t", (s) => s.circle(IY, IZ, "iw_d").circle(IY, IZ, "shaft"),
  [1, "Swyft Robotics", "SR-INTAKEWHEEL-15", "1.5 in compliant intake wheel (needs the 8 mm REX bore version)"]);
alongX("Intake motor 5203", RAIL_IN - 4 - 105, "motor_len", (s) => s.circle(IY, 120, "motor_d"), [1, GB, "5203-2402-0003", "5203 Yellow Jacket, 3.7:1 (1620 RPM), face-mounted to the right intake bracket; belt to the intake shaft"]);
alongX("Intake ramp", -24, 48, (s) => s.poly([[190, 8], [140, 82], [140, 86], [190, 12]]), [1, CUSTOM, "—", "Printed PETG ramp"]);
alongZ("Color sensor V3", 95, 10, (s) => s.rect(-12.5, 148, 25, 10), [1, REV, "REV-31-1557", "Color Sensor V3 (sorts POLLEN / NECTAR)"]);

// ================= 4-pocket spindexer on a goBILDA servo =================
const SPY = 40, SPZ = DECK_Z + 4;
alongZ("goBILDA servo (spindexer)", 36, 40, (s) => s.rect(-20, 30, 40, 20), [1, GB, "2000-0025-0002", "2000 Series dual-mode servo (25-2, torque)"]);
alongZ("Spindexer floor", SPZ, 4, (s) => s.circle(0, SPY, "2*spx_r").circle(0, SPY, 12), [1, CUSTOM, "—", "Printed / 4 mm plate"]);
alongZ("Spindexer pockets", SPZ + 4, 70, (s) => {
  s.circle(0, SPY, "2*spx_r").circle(0, SPY, 12);
  for (const a of [45, 135, 225, 315]) {
    const c = Math.cos((a * Math.PI) / 180), si = Math.sin((a * Math.PI) / 180);
    s.circle(`55 * ${c.toFixed(6)}`, `${SPY} + 55 * ${si.toFixed(6)}`, "ball + 3");
  }
  return s;
}, [1, CUSTOM, "—", "Printed spindexer, 4 pockets for 71 mm POLLEN"]);

// ================= flywheel shooter =================
const FY = -110, FZ = 190;
const shooterPlate = (s) => {
  s.rect(-180, DECK_Z + 4, 140, 200).circle(FY, FZ, "big_hole");
  for (const y of range(-168, -60, 24)) for (const z of range(100, 256, 24)) if (Math.hypot(y - FY, z - FZ) > 20) s.circle(y, z, "m4");
  return s;
};
alongX("Right shooter plate", 60, "plate", shooterPlate, [1, CUSTOM, "—", "4 mm 6061 plate on the goBILDA 24 mm grid"]);
alongX("Left shooter plate", -64, "plate", shooterPlate, [1, CUSTOM, "—", "4 mm 6061 plate on the goBILDA 24 mm grid"]);
alongX("Flywheel 96mm", -50, "fly_w", (s) => s.circle(FY, FZ, "fly_d").circle(FY, FZ, "shaft"), [1, CUSTOM, "—", "96 mm flywheel stack (e.g. 2 x goBILDA 96 mm wheels + printed core)"]);
alongX("Flywheel shaft REX", -64, 128, (s) => s.circle(FY, FZ, "shaft"), [1, GB, "2100-0008-0128", "8 mm REX shaft, 128 mm"]);
alongX("Shooter motor 5203", -169, "motor_len", (s) => s.circle(FY, FZ, "motor_d"), [1, GB, "5203-2402-0001", "5203 Yellow Jacket, 1:1 (6000 RPM)"]);
alongX("Shooter hood", -58, 116, (s) => s.band(FY, FZ, "fly_d/2 + ball - squish", "fly_d/2 + ball - squish + hood_t", -10, 120), [1, CUSTOM, "—", "Printed TPU/PETG hood, 12 mm compression"]);

// ================= electronics =================
alongX("REV Control Hub", 66, 32, (s) => s.rect(-180, DECK_Z + 6, 143, 103), [1, REV, "REV-31-1595", "Control Hub (mounted on edge, ports up)"]);
alongX("REV Slim Battery", -102, 32, (s) => s.rect(-175, DECK_Z + 6, 140, 70), [1, REV, "REV-31-1302", "12 V Slim Battery"]);
alongZ("REV Switch", DECK_Z + 4, 20, (s) => s.rect(-120, 114, 40, 26), [1, REV, "REV-31-1387", "Switch cable & bracket"]);

const part = { name: "BIOBUZZ robot", ...(old.onshape ? { onshape: old.onshape } : {}), variables: V, material: { name: "Aluminium 6061", density: 2.7 }, features };
const lines = [`{`, `  "name": ${JSON.stringify(part.name)},`];
if (part.onshape) lines.push(`  "onshape": ${JSON.stringify(part.onshape)},`);
lines.push(`  "variables": ${JSON.stringify(V)},`, `  "material": ${JSON.stringify(part.material)},`, `  "features": [`);
features.forEach((f, i) => lines.push(`    ${JSON.stringify(f)}${i < features.length - 1 ? "," : ""}`));
lines.push(`  ]`, `}`, ``);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, lines.join("\n"));

// ---- bill of materials (grouped by part number) ----
const rows = new Map();
for (const b of bom) { const k = `${b.source}|${b.sku}|${b.note}`; const r = rows.get(k) ?? { ...b, qty: 0, where: [] }; r.qty += b.qty; r.where.push(b.name); rows.set(k, r); }
const order = [GB, REV, "Swyft Robotics", CUSTOM];
const table = [...rows.values()].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
const md = `# BIOBUZZ robot: bill of materials

Generated by \`node scripts/make-ftc-robot.mjs\` from the CAD. Units mm. Robot envelope ≈ 451 x 405 x 301 mm (18 in cube = 457 mm).

COTS parts are modelled from the vendors' published sizes and hole patterns (envelopes, not the vendor's own CAD files).
**Check part numbers and lengths against gobilda.com / revrobotics.com before ordering.**

| Qty | Source | Part number | Description | Used in |
|---:|---|---|---|---|
${table.map((r) => `| ${r.qty} | ${r.source} | ${r.sku} | ${r.note} | ${r.where.join(", ")} |`).join("\n")}

## Not modelled (add when ordering)
- Wire: XT30 battery lead, 4 x motor power cables + encoder cables, servo extension, JST-PH sensor cable.
- Intake belt drive: 2 x GT2/HTD pulleys (8 mm REX bore) + belt, motor to intake shaft.
- Bearings: goBILDA 1611 flanged ball bearings (14 mm OD, 8 mm REX) for the shooter and intake shafts.
- Shaft collars (8 mm REX clamping collars) on every shaft; M4 nyloc nuts for the deck screws.
- Motor mounts are the channel itself (gearbox face screwed to the rail web with 4 x M4); add goBILDA 1203 face-mount brackets if you prefer.
`;
fs.writeFileSync(path.join(dir, "BOM.md"), md);
console.log(`wrote ${file}: ${features.length} features, ${features.filter((f) => f.type === "extrude").length} extrudes, ${planes.size} planes; BOM ${table.length} lines`);
