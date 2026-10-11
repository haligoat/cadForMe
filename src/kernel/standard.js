// Standard parts as editable parametric parts (variables + features). Dimensions per ISO 4762 / 4032 / 7089 and common bearings.
const SCREW = { M3: [3, 5.5, 3, 2.5], M4: [4, 7, 4, 3], M5: [5, 8.5, 5, 4], M6: [6, 10, 6, 5], M8: [8, 13, 8, 6], M10: [10, 16, 10, 8], M12: [12, 18, 12, 10] }; // d, head dia, head height, hex socket (across flats)
const NUT = { M3: [5.5, 2.4], M4: [7, 3.2], M5: [8, 4.7], M6: [10, 5.2], M8: [13, 6.8], M10: [16, 8.4], M12: [18, 10.8] }; // across flats, thickness
const WASHER = { M3: [3.2, 7, 0.5], M4: [4.3, 9, 0.8], M5: [5.3, 10, 1], M6: [6.4, 12, 1.6], M8: [8.4, 16, 1.6], M10: [10.5, 20, 2], M12: [13, 24, 2.5] }; // hole, outer, thickness
const BEARING = { "623": [3, 10, 4], "625": [5, 16, 5], "608": [8, 22, 7], "6000": [10, 26, 8], "6001": [12, 28, 8], "6200": [10, 30, 9], "6201": [12, 32, 10], "6202": [15, 35, 11] }; // bore, outer, width
export const SIZES = Object.keys(SCREW);
export const BEARINGS = Object.keys(BEARING);
export const hole = { clearance: { M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5 }, tap: { M3: 2.5, M4: 3.3, M5: 4.2, M6: 5, M8: 6.8, M10: 8.5, M12: 10.2 },
  cbore: { M3: [6.5, 3.4], M4: [8, 4.4], M5: [10, 5.4], M6: [11, 6.5], M8: [15, 8.6], M10: [18, 10.8], M12: [20, 13] } }; // cbore: [diameter, depth]

const poly = (id, name, r, extra = {}) => ({ id, type: "sketch", name, plane: "XY", offset: 0, entities: [{ type: "polygon", cx: 0, cy: 0, r, sides: 6, angle: 0 }], ...extra });
const circ = (id, name, r, extra = {}) => ({ id, type: "sketch", name, plane: "XY", offset: 0, entities: [{ type: "circle", cx: 0, cy: 0, r }], ...extra });

export function socketScrew(size, length) {
  const [d, hd, hh, s] = SCREW[size] ?? (() => { throw new Error(`Unknown screw size ${size}`); })();
  return { name: `${size}x${length} socket head screw`, variables: { d, length, head_d: hd, head_h: hh, socket: s },
    features: [
      { id: "head", type: "cylinder", name: "Head", position: [0, 0, 0], r: "head_d/2", h: "head_h", mode: "new" },
      { id: "shank", type: "cylinder", name: "Shank", position: [0, 0, "-length"], r: "d/2", h: "length", mode: "add" },
      poly("sk1", "Socket", "socket/sqrt(3)", { offset: "head_h" }),
      { id: "cut1", type: "extrude", name: "Hex socket", sketch: "sk1", distance: "head_h/2", flip: true, mode: "cut" },
    ] };
}
export function hexNut(size) {
  const [s, m] = NUT[size] ?? (() => { throw new Error(`Unknown nut size ${size}`); })(), d = SCREW[size][0];
  return { name: `${size} hex nut`, variables: { d, across_flats: s, thickness: m },
    features: [poly("sk1", "Hexagon", "across_flats/sqrt(3)"), { id: "ex1", type: "extrude", name: "Body", sketch: "sk1", distance: "thickness", mode: "new" },
      circ("sk2", "Thread hole", "d/2"), { id: "ex2", type: "extrude", name: "Hole", sketch: "sk2", through: true, mode: "cut" }] };
}
export function washer(size) {
  const [h, o, t] = WASHER[size] ?? (() => { throw new Error(`Unknown washer size ${size}`); })();
  return { name: `${size} washer`, variables: { inner: h, outer: o, thickness: t },
    features: [circ("sk1", "Outer", "outer/2"), { id: "ex1", type: "extrude", name: "Disc", sketch: "sk1", distance: "thickness", mode: "new" },
      circ("sk2", "Hole", "inner/2"), { id: "ex2", type: "extrude", name: "Hole", sketch: "sk2", through: true, mode: "cut" }] };
}
export function bearing(code) {
  const [d, o, w] = BEARING[code] ?? (() => { throw new Error(`Unknown bearing ${code}`); })();
  return { name: `${code} ball bearing`, variables: { bore: d, outer: o, width: w },
    features: [circ("sk1", "Outer", "outer/2"), { id: "ex1", type: "extrude", name: "Ring", sketch: "sk1", distance: "width", mode: "new" },
      circ("sk2", "Bore", "bore/2"), { id: "ex2", type: "extrude", name: "Bore", sketch: "sk2", through: true, mode: "cut" }] };
}
export function spurGear(module, teeth, thickness, bore) {
  return { name: `Gear m${module} z${teeth}`, variables: { module, teeth, thickness, bore, pitch_diameter: "module*teeth" },
    features: [{ id: "g1", type: "gear", name: "Spur gear", module: "module", teeth: "teeth", thickness: "thickness", bore: "bore", pressure: 20, mode: "new" }] };
}

/** Catalogue shown in the UI: each item builds a part from the chosen options. */
export const CATALOG = [
  { id: "screw", label: "Socket head cap screw (ISO 4762)", opts: [{ k: "size", label: "Size", values: SIZES, def: "M5" }, { k: "length", label: "Length (mm)", def: 16, num: true }], build: (o) => socketScrew(o.size, o.length) },
  { id: "nut", label: "Hex nut (ISO 4032)", opts: [{ k: "size", label: "Size", values: SIZES, def: "M5" }], build: (o) => hexNut(o.size) },
  { id: "washer", label: "Flat washer (ISO 7089)", opts: [{ k: "size", label: "Size", values: SIZES, def: "M5" }], build: (o) => washer(o.size) },
  { id: "bearing", label: "Ball bearing", opts: [{ k: "code", label: "Type", values: BEARINGS, def: "608" }], build: (o) => bearing(o.code) },
  { id: "gear", label: "Spur gear", opts: [{ k: "module", label: "Module", def: 1.5, num: true }, { k: "teeth", label: "Teeth", def: 24, num: true }, { k: "thickness", label: "Thickness (mm)", def: 6, num: true }, { k: "bore", label: "Bore (mm)", def: 8, num: true }], build: (o) => spurGear(o.module, o.teeth, o.thickness, o.bore) },
];
