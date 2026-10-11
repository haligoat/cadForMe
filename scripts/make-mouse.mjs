// Generates the "laptop-mouse" example: a manufacturable travel mouse (injection-moulded ABS shells) as separate parts
// plus an assembly. Units mm. Run: node scripts/make-mouse.mjs [outDir]
import fs from "node:fs";
import path from "node:path";
import { formatPart } from "../src/kernel/format.js";
import { socketScrew } from "../src/kernel/standard.js";

const out = process.argv[2] ?? "examples/laptop-mouse";
const r2 = (x) => Math.round(x * 100) / 100;
const P = (rel) => `parts/${rel}.part.json`;
const ABS = { name: "ABS plastic", density: 1.05 };

// ---------- master shape ----------
const top = (x) => 15 + 19 * Math.exp(-(((x + 8) / 38) ** 2)); // side silhouette: palm hump
const crown = (y) => 47 - 0.026 * y * y;                       // front silhouette: rounded sides
const sideProfile = (inset) => { const pts = [[-56, -2], [56, -2]]; for (let x = 56; x >= -56; x -= 2) pts.push([x, r2(top(x) - inset)]); return pts; };
const frontProfile = (inset) => { const pts = [[-36, -2], [36, -2]]; for (let y = 36; y >= -36; y -= 2) pts.push([y, r2(crown(y) - inset)]); return pts; };
const bodyPart = (name, inset) => ({
  name, variables: { length: r2(96 - 2 * inset), width: r2(58 - 2 * inset) },
  features: [
    { id: "sk1", type: "sketch", name: "Footprint", plane: "XY", entities: [{ type: "ellipse", cx: 0, cy: 0, rx: "length/2", ry: "width/2" }] },
    { id: "ex1", type: "extrude", name: "Footprint block", sketch: "sk1", distance: 50, mode: "new" },
    { id: "sk2", type: "sketch", name: "Side profile", plane: "XZ", entities: [{ type: "polyline", points: sideProfile(inset) }] },
    { id: "ex2", type: "extrude", name: "Side shape", sketch: "sk2", distance: 120, symmetric: true, mode: "intersect" },
    { id: "sk3", type: "sketch", name: "Front profile", plane: "YZ", entities: [{ type: "polyline", points: frontProfile(inset) }] },
    { id: "ex3", type: "extrude", name: "Rounded sides", sketch: "sk3", distance: 140, symmetric: true, mode: "intersect" },
  ],
});
const WALL = 1.6, SPLIT = 3, FLOOR = 1.5;

// ---------- helpers that build features clipped to the shell ----------
let n = 0;
const id = (p) => `${p}${++n}`;
/** A feature grown from below up to the inside of the shell (posts, bosses): cylinder ∩ inner body, then merged. */
const toInside = (name, cyl) => [
  { id: id("c"), type: "cylinder", name, ...cyl, mode: "new" },
  { id: id("i"), type: "insert", name: `${name}: clip`, part: P("mouse-body-inner"), mode: "new" },
  { id: id("b"), type: "boolean", name: `${name}: trim to shell`, a: 1, b: 2, op: "intersect" },
  { id: id("b"), type: "boolean", name: `${name}: join`, a: 0, b: 1, op: "union" },
];
/** A thickening that follows the inside of the wall (snap ledges): box ∩ body − deeper inset, then merged. */
const onWall = (name, box) => [
  { id: id("x"), type: "box", name, ...box, mode: "new" },
  { id: id("i"), type: "insert", name: `${name}: outer`, part: P("mouse-body"), mode: "new" },
  { id: id("b"), type: "boolean", name: `${name}: inside body`, a: 1, b: 2, op: "intersect" },
  { id: id("i"), type: "insert", name: `${name}: depth`, part: P("mouse-body-inner2"), mode: "new" },
  { id: id("b"), type: "boolean", name: `${name}: on the wall`, a: 1, b: 2, op: "subtract" },
  { id: id("b"), type: "boolean", name: `${name}: join`, a: 0, b: 1, op: "union" },
];

// ---------- top shell: one moulding, buttons are flexures hinged at x = 8 ----------
const SWX = 32, SWY = 11, SW_TOP = 5.1 + 6.5, PRETRAVEL = 0.3;
const SCREWS = [[-28, 12], [-28, -12]], HOOKS = [10, -10];
const WHEEL_X = 30, WHEEL_R = 8.5, WHEEL_W = 7, WHEEL_Z = r2(top(WHEEL_X) - WHEEL_R + 3);
const topShell = {
  name: "Top shell", material: ABS, variables: { slot_gap: 0.8, plunger_r: 1.6, boss_r: 3, pilot_r: 1.25 },
  features: [
    { id: "in1", type: "insert", name: "Outer shape", part: P("mouse-body"), mode: "new" },
    { id: "in2", type: "insert", name: "Hollow (1.6 mm wall)", part: P("mouse-body-inner"), mode: "cut" },
    { id: "sp1", type: "split", name: "Split from base", body: 0, origin: [0, 0, SPLIT], normal: [0, 0, 1], keep: "above" },
    { id: "cut1", type: "box", name: "Button centre gap", position: [34, 0, 0], w: 52, d: "slot_gap", h: 60, mode: "cut" },
    { id: "cut2", type: "box", name: "Button side slits", position: [34, 0, 13.5], w: 52, d: 80, h: "slot_gap", mode: "cut" },
    { id: "cut3", type: "box", name: "Wheel opening", position: [WHEEL_X, 0, 0], w: 24, d: 9.5, h: 60, mode: "cut" },
    ...toInside("Left plunger", { position: [SWX, SWY, SW_TOP + PRETRAVEL], r: "plunger_r", h: 40 }),
    ...toInside("Right plunger", { position: [SWX, -SWY, SW_TOP + PRETRAVEL], r: "plunger_r", h: 40 }),
    ...SCREWS.flatMap(([x, y], i) => toInside(`Screw boss ${i + 1}`, { position: [x, y, SPLIT], r: "boss_r", h: 40 })),
    ...SCREWS.map(([x, y], i) => ({ id: id("p"), type: "cylinder", name: `Pilot hole ${i + 1}`, position: [x, y, SPLIT], r: "pilot_r", h: 9, mode: "cut" })),
    ...HOOKS.flatMap((y, i) => onWall(`Snap ledge ${i + 1}`, { position: [45.7, y, 5], w: 8.6, d: 4, h: 1.5 })), // flat inner face at x = 41.4
  ],
};
n = 0;

// ---------- bottom shell ----------
const bottom = {
  name: "Bottom shell", material: ABS, variables: { floor: FLOOR, lip_h: 1.8, clearance: 0.2 },
  features: [
    { id: "in1", type: "insert", name: "Outer shape", part: P("mouse-body"), mode: "new" },
    { id: "sp1", type: "split", name: "Base slab", body: 0, origin: [0, 0, SPLIT], normal: [0, 0, 1], keep: "below" },
    { id: "sk1", type: "sketch", name: "Cavity", plane: "XY", offset: "floor", entities: [{ type: "ellipse", cx: 0, cy: 0, rx: 44.8, ry: 25.8 }] },
    { id: "ex1", type: "extrude", name: "Pocket", sketch: "sk1", distance: 5, mode: "cut" },
    { id: "sk2", type: "sketch", name: "Locating lip", plane: "XY", offset: SPLIT, entities: [{ type: "ellipse", cx: 0, cy: 0, rx: "46.4 - clearance", ry: "27.4 - clearance" }, { type: "ellipse", cx: 0, cy: 0, rx: 45, ry: 26, op: "subtract" }] },
    { id: "ex2", type: "extrude", name: "Lip", sketch: "sk2", distance: "lip_h", mode: "add" },
    ...HOOKS.map((y, i) => ({ id: `lr${i}`, type: "box", name: `Lip relief ${i + 1}`, position: [41.5, y, SPLIT], w: 8, d: 7, h: 3, mode: "cut" })),
    { id: "sk3", type: "sketch", name: "Sensor window", plane: "XY", entities: [{ type: "circle", cx: 14, cy: 0, r: 4 }] },
    { id: "ex3", type: "extrude", name: "Window", sketch: "sk3", through: true, mode: "cut" },
    { id: "sk4", type: "sketch", name: "Battery opening", plane: "XY", entities: [{ type: "rect", cx: -19.5, cy: 0, w: 44, h: 16 }] },
    { id: "ex4", type: "extrude", name: "Battery opening", sketch: "sk4", through: true, mode: "cut" },
    ...SCREWS.map(([x, y], i) => ({ id: `bb${i}`, type: "cylinder", name: `Screw boss ${i + 1}`, position: [x, y, 0], r: 4, h: SPLIT, mode: "add" })),
    ...SCREWS.map(([x, y], i) => ({ id: `bh${i}`, type: "cylinder", name: `Clearance hole ${i + 1}`, position: [x, y, -1], r: 1.7, h: 10, mode: "cut" })),
    ...SCREWS.map(([x, y], i) => ({ id: `bc${i}`, type: "cylinder", name: `Head counterbore ${i + 1}`, position: [x, y, -1], r: 3.1, h: 4.2, mode: "cut" })),
    ...[14, -14].map((y, i) => ({ id: `so${i}`, type: "cylinder", name: `Board standoff ${i + 1}`, position: [24, y, FLOOR], r: 2, h: 2, mode: "add" })),
    ...[14, -14].map((y, i) => ({ id: `pi${i}`, type: "cylinder", name: `Board locating pin ${i + 1}`, position: [24, y, 3.5], r: 1, h: 2.5, mode: "add" })),
    ...HOOKS.map((y, i) => ({ id: `ha${i}`, type: "box", name: `Snap hook arm ${i + 1}`, position: [40.5, y, FLOOR], w: 1, d: 3, h: 5.5, mode: "add" })),
    ...HOOKS.map((y, i) => ({ id: `hb${i}`, type: "box", name: `Snap hook barb ${i + 1}`, position: [41.15, y, 4.2], w: 1.3, d: 3, h: 0.8, mode: "add" })),
    { id: "sk5", type: "sketch", name: "Glide feet", plane: "XY", entities: [{ type: "slot", cx: 38, cy: 0, length: 26, width: 5, angle: 90 }, { type: "circle", cx: -40, cy: 12, r: 3 }, { type: "circle", cx: -40, cy: -12, r: 3 }] },
    { id: "ex5", type: "extrude", name: "Feet", sketch: "sk5", distance: 0.6, flip: true, mode: "add" },
  ],
};

const door = {
  name: "Battery door", material: ABS, variables: { clearance: 0.2 },
  features: [
    { id: "b1", type: "box", name: "Door plate", position: [-19.5, 0, 0], w: "44 - 2*clearance", d: "16 - 2*clearance", h: FLOOR, mode: "new" },
    { id: "b2", type: "box", name: "Rear tongue", position: [-41.9, 0, FLOOR], w: 2, d: 10, h: 0.6, mode: "add" },
    { id: "b3", type: "box", name: "Front latch", position: [2.7, 0, FLOOR], w: 1.6, d: 6, h: 0.6, mode: "add" },
    { id: "c1", type: "cylinder", name: "Finger notch", position: [-1, 0, -0.1], r: 3, h: 0.8, mode: "cut" },
  ],
};
const battery = { name: "AA battery", variables: { dia: 14.5, length: 50.5 }, features: [
  { id: "c1", type: "cylinder", name: "Cell", position: [-41.9, 0, "2.1 + dia/2"], direction: [1, 0, 0], r: "dia/2", h: "length", mode: "new" }] };
const pcb = { name: "Circuit board", variables: { thickness: 1.6 }, features: [
  { id: "sk1", type: "sketch", name: "Board outline", plane: "XY", offset: 3.5, entities: [{ type: "ellipse", cx: 25, cy: 0, rx: 15.5, ry: 19 }, { type: "circle", cx: 24, cy: 14, r: 1.1, op: "subtract" }, { type: "circle", cx: 24, cy: -14, r: 1.1, op: "subtract" }] },
  { id: "ex1", type: "extrude", name: "Board", sketch: "sk1", distance: "thickness", mode: "new" }] };
const sensor = { name: "Optical sensor", variables: {}, features: [
  { id: "b1", type: "box", name: "Sensor chip", position: [14, 0, 1.6], w: 9, d: 9, h: 1.9, mode: "new" },
  { id: "c1", type: "cylinder", name: "Lens", position: [14, 0, 0.3], r: 3.6, h: 1.3, mode: "add" }] };
const switches = { name: "Click switches (Omron D2FC-F-7N size)", variables: {}, features: [
  { id: "b1", type: "box", name: "Left switch", position: [SWX, SWY, 5.1], w: 12.8, d: 5.8, h: 6.5, mode: "new" },
  { id: "b2", type: "box", name: "Right switch", position: [SWX, -SWY, 5.1], w: 12.8, d: 5.8, h: 6.5, mode: "new" }] };
const wheel = { name: "Scroll wheel", variables: { radius: WHEEL_R, width: WHEEL_W }, features: [
  { id: "c1", type: "cylinder", name: "Wheel", position: [WHEEL_X, "-width/2", WHEEL_Z], direction: [0, 1, 0], r: "radius", h: "width", mode: "new" },
  { id: "c2", type: "cylinder", name: "Axle bore", position: [WHEEL_X, -5, WHEEL_Z], direction: [0, 1, 0], r: 1, h: 10, mode: "cut" }] };
const axle = { name: "Wheel axle (Ø2 steel pin)", variables: {}, features: [{ id: "c1", type: "cylinder", name: "Axle", position: [WHEEL_X, -5.5, WHEEL_Z], direction: [0, 1, 0], r: 1, h: 11, mode: "new" }] };
const bracket = { name: "Wheel bracket", material: ABS, variables: {}, features: [
  { id: "b1", type: "box", name: "Left cheek", position: [WHEEL_X, 4.55, 5.1], w: 6, d: 1.5, h: r2(WHEEL_Z + 2.5 - 5.1), mode: "new" },
  { id: "b2", type: "box", name: "Right cheek", position: [WHEEL_X, -4.55, 5.1], w: 6, d: 1.5, h: r2(WHEEL_Z + 2.5 - 5.1), mode: "new" },
  { id: "c1", type: "cylinder", name: "Axle holes", position: [WHEEL_X, -6, WHEEL_Z], direction: [0, 1, 0], r: 1.1, h: 12, mode: "cut" }] };

const asm = {
  name: "Laptop mouse (assembly)", variables: {},
  // body order follows the inserts
  colors: { 0: "#2a2e35", 1: "#3b6fd8", 2: "#343a44", 3: "#d8473a", 4: "#2f8f55", 5: "#c9a43a", 6: "#f0f0f0", 7: "#f0f0f0", 8: "#1d2026", 9: "#b8bec9", 10: "#4a505c", 11: "#4a505c", 12: "#8d939e", 13: "#8d939e" },
  features: [
    { id: "i1", type: "insert", name: "Bottom shell", part: P("bottom-shell") },
    { id: "i2", type: "insert", name: "Top shell", part: P("top-shell") },
    { id: "i3", type: "insert", name: "Battery door", part: P("battery-door") },
    { id: "i4", type: "insert", name: "Battery", part: P("aa-battery") },
    { id: "i5", type: "insert", name: "Circuit board", part: P("circuit-board") },
    { id: "i6", type: "insert", name: "Sensor", part: P("optical-sensor") },
    { id: "i7", type: "insert", name: "Switches", part: P("click-switches") },
    { id: "i8", type: "insert", name: "Scroll wheel", part: P("scroll-wheel") },
    { id: "i9", type: "insert", name: "Axle", part: P("wheel-axle") },
    { id: "i10", type: "insert", name: "Wheel bracket", part: P("wheel-bracket") },
    ...SCREWS.map(([x, y], i) => ({ id: `s${i}`, type: "insert", name: `Screw ${i + 1}`, part: P("M3x8-screw"), rotate: 180, axis: [1, 0, 0], position: [x, y, 3.2] })),
  ],
};

const parts = {
  "mouse-body": bodyPart("Mouse body (master shape)", 0), "mouse-body-inner": bodyPart("Mouse body, wall offset", WALL), "mouse-body-inner2": bodyPart("Mouse body, ledge depth", WALL + 1.5),
  "top-shell": topShell, "bottom-shell": bottom, "battery-door": door, "aa-battery": battery, "circuit-board": pcb, "optical-sensor": sensor,
  "click-switches": switches, "scroll-wheel": wheel, "wheel-axle": axle, "wheel-bracket": bracket, "M3x8-screw": socketScrew("M3", 8), "mouse-assembly": asm,
};
fs.mkdirSync(path.join(out, "parts"), { recursive: true });
for (const f of fs.readdirSync(path.join(out, "parts"))) if (!parts[f.replace(".part.json", "")]) fs.rmSync(path.join(out, "parts", f)); // drop parts from older revisions
for (const [name, part] of Object.entries(parts)) fs.writeFileSync(path.join(out, P(name)), formatPart(part));
console.log(`wrote ${Object.keys(parts).length} parts to ${out}`);
