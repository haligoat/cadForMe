// Transfer / intake hardware for ~/cadSlop/test/parts/onshape-part.part.json (re-runnable: replaces earlier "tx" features).
// Rules: the user's own parts are never cut or reshaped (they may only be moved as a whole); every bought part is the vendor's own
// STEP file; shafts run in goBILDA bearings seated in the plates' existing bearing holes.
//   Swyft  SR-INTAKEWHEEL-15-7mm   1.5 in intake wheel (7 mm hex bore)   imports/SR-INTAKEWHEEL-15-7mm.step
//   goBILDA 1611-0514-4008         8 mm REX flanged bearing (14 mm OD)   imports/gobilda-1611-0514-4008-rex-flanged-bearing.step
//   goBILDA 2106-4008-1040         8 mm REX shaft 104 mm with e-clip     imports/gobilda-2106-4008-1040-rex-shaft-104mm.step
// Coordinates are the imported robot STEP's frame (mm): X = front(-)/back(+), Y = across, Z = up.
// Usage: node scripts/add-transfer-hardware.mjs [part file]
import fs from "node:fs";

const file = process.argv[2] ?? `${process.env.HOME}/cadSlop/test/parts/onshape-part.part.json`;
const part = JSON.parse(fs.readFileSync(file, "utf8"));
part.features = part.features.filter((f) => !String(f.id).startsWith("tx"));

// ---- the user's robot (measured) ----
const SHEET = 9, TRANSFER_PLATES = [25, 622];      // curved transfer sheet + both transfer plates
// shooter tower: vertical U-channels #2/#10, cross channel #8, shooter plate #4 and the six corner brackets
const TOWER = [2, 3, 4, 6, 8, 10, 12, 19, 20, 23];
const TOWER_PUSH = 32;                             // = one hole pitch of the side plates: two of each plate's five tower holes are reused
const PUSH = 28;                                   // transfer moves back by this (rear channel #22 stops the plates at ~30)
const SHEET_LIFT = 1.7;                            // floor raised so the 1.5 in wheels squeeze pollen 3 mm
// tower bolt holes in the side plates (x, z), measured; after the move these need new M4 holes (the other two reuse existing ones)
const SIDE_PLATES = [{ body: 0, y: [355.2, 358.2], holes: [[72, -8], [72, 88], [56, -56]] }, { body: 7, y: [-56.8, -53.8], holes: [[72, -8], [72, 88], [56, -56]] }];   // plate A after it is aligned to plate B
const Y_OUT = [102.6, 195.4], YC = 149.0;          // transfer plates' outer faces, centreline
// existing Ø14.5 bearing holes in the transfer plates (x, z) before the push: 4 floor shafts + 1 wall shaft
const BEARING_HOLES = [[-138.6, -27.5], [-88.6, -27.5], [-38.6, -27.5], [12.2, -27.5], [10.2, 11.5]];
const INTAKE_SHAFT = { x: -184, z: -56, y: [-48.3, 349.6] };     // after alignment: on the side plates' bearing hole centres  // the original full-width 7 mm hex intake shaft (#13) between its bearing blocks
// ---- vendor part facts (measured from their STEP files) ----
const WHEEL_W = 12.7;
const BEARING_BODY = 4, BEARING_FLANGE = 1, CLIP_FROM_END = 4.0;
const ROWS = [YC - 20, YC, YC + 20];
const F = {
  wheel: "imports/SR-INTAKEWHEEL-15-7mm.step", bearing: "imports/gobilda-1611-0514-4008-rex-flanged-bearing.step",
  shaft104: "imports/gobilda-2106-4008-1040-rex-shaft-104mm.step",
  bracket: "imports/gobilda-1141-0001-0001-round-end-angle-bracket.step",
  titan: "imports/SWYFT_Servo_Titan_Servo_Module.step", servoShaft: "imports/gobilda-1922-0025-0036-rex-servo-shaft-36mm.step",
};
const SHAFT104 = { file: F.shaft104, anchor: [-41.41, -14.25, 13.19], sku: "2106-4008-1040" };

const feats = [], bom = new Map();
let k = 0;
const id = (p) => `tx${p}${++k}`;
const r2 = (v) => Math.round(v * 100) / 100;
const count = (key, qty = 1) => bom.set(key, (bom.get(key) ?? 0) + qty);
let n = 623;                                        // bodies in the part before these features (622 imported solids + mirrored plate)
const imp = (name, fl, anchor, orient, position) => { feats.push({ id: id("i"), type: "import", name, file: fl, anchor, orient, position: position.map(r2), mode: "new" }); return n++; };
const box = (name, x0, x1, y0, y1, z0, z1) => { feats.push({ id: id("b"), type: "box", name, position: [r2((x0 + x1) / 2), r2((y0 + y1) / 2), r2(z0)], w: r2(x1 - x0), d: r2(y1 - y0), h: r2(z1 - z0), mode: "new" }); return n++; };
const cutWith = (name, a, b, op = "subtract") => { feats.push({ id: id("x"), type: "boolean", name, a, b, op }); n--; };
const spinZ = (name, body, deg, origin) => feats.push({ id: id("t"), type: "transform", name, body, rotate: r2(deg), axis: [0, 0, 1], origin: [origin[0], origin[1], 0], copy: false });
// 3D-printed 90° mount (parts/printed-mount.part.json): same frame, footprint and plate-side holes as a goBILDA 1141 bracket
// funnel rear tabs bolt to the new transfer plates: 2 M4 holes each (x, z), shared by plate A and B
const FUNNEL_REAR_TAB = { x: [-136, -96], z: -106, holes: [[-128, -102], [-104, -102], [-116, -120]] };   // 3 inserts in a triangle: the tab cannot pivot
const FUNNEL_FRONT_TAB = { x: [-182, -155], z: -106, holes: [[-177, -102], [-161, -102], [-169, -116]] };   // 3 inserts in a triangle, inside the side plate (bottom edge z -125)
const MOUNT = "parts/printed-mount.part.json";
const mount = (name, orient, position) => { feats.push({ id: id("m"), type: "insert", name, part: MOUNT, orient, position: position.map(r2), mode: "new" }); count("3D-printed 90° mount (parts/printed-mount, PETG or nylon)"); return n++; };
/** Cut a cylindrical hole (axis +y) out of body `a`. */
const cyl = (name, p, dir, d, h) => { feats.push({ id: id("c"), type: "cylinder", name, position: p.map(r2), direction: dir.map((v) => r2(v * 1e4) / 1e4), r: d / 2, h, mode: "new" }); return n++; };
const hole = (name, a, x, y0, z, d, h) => { feats.push({ id: id("c"), type: "cylinder", name: `${name} (cutter)`, position: [r2(x), r2(y0), r2(z)], direction: [0, 1, 0], r: d / 2, h, mode: "new" }); feats.push({ id: id("x"), type: "boolean", name, a, b: n, op: "subtract" }); };

// 0) alignment: the imported robot had parts a fraction of a millimetre to 5 mm off the holes they bolt to. Side plate B (#7) has
//    its holes on round numbers, so it is the reference; everything else is moved onto it (measured from hole centres).
const DRIVE = JSON.parse(fs.readFileSync(new URL("./drive-groups.json", import.meta.url), "utf8"));   // drive pods: channel + all parts on it
const MOTOR = [1, 14, 15, 16, 17, 18], MOTOR_DROP = 40;            // top-left motor (+ its mount) on side plate A
const PLATE_A_FIX = [-0.89, 0, 0.5];                               // side plate A's holes vs side plate B's mirror (measured)
const POD_A = DRIVE["24"].filter((i) => i !== 24), POD_B = DRIVE["11"].filter((i) => i !== 11);
const ALIGN = [
  // side plate A and everything built on it (drive pod A's spacers match its holes to 0.1-0.3 mm) move together onto plate B's mirror
  { name: "Align side plate A (+ drive pod A, bearing block A, top-left motor) to mirror side plate B", body: [0, ...POD_A, 5, ...MOTOR], t: PLATE_A_FIX },
  // the drive channels' flange holes sat 0.1-1.3 mm off the row of side-plate holes made for them, and 0.6-0.8 mm off the plate
  { name: "Drive channel #11 onto side plate B's hole row, flush", body: [11], t: [-0.1, -0.6, 0.1] },
  { name: "Drive channel #24 onto side plate A's hole row, flush", body: [24], t: [0.72 + PLATE_A_FIX[0], 0.8, -1.08 + PLATE_A_FIX[2]] },
  // intake bearing blocks were modelled ~5 mm low against their side-plate holes
  { name: "Intake bearing block B onto side plate B's holes, flush", body: [21], t: [0, -0.51, 5.2] },
  { name: "Intake bearing block A onto side plate A's holes, flush", body: [5], t: [0.4, 0.6, 4.75] },
  { name: "Intake shaft onto the bearing centres (was 5 mm low)", body: [13], t: [-0.65, 0, 5.03] },
  { name: `Lower the top-left motor ${MOTOR_DROP} mm`, body: MOTOR, t: [0, 0, -MOTOR_DROP] },
  // drive pod spacer plates: flush on their side plate, holes on the plate's holes (measured per spacer)
  { name: "Drive pod B spacer #272 flush + on its holes", body: [272], t: [0.02, -0.52, 0.15] },
  { name: "Drive pod B spacer #346 flush + on its holes", body: [346], t: [0, -0.9, 0.1] },
  { name: "Drive pod A spacer #34 flush + on its holes", body: [34], t: [-0.08, 0.3, 0.05] },
  { name: "Drive pod A spacer #497 flush + on its holes", body: [497], t: [-0.14, 0.13, -0.3] },
];
for (const a of ALIGN) feats.push({ id: id("t"), type: "transform", name: a.name, body: a.body, translate: a.t, copy: false });
// side B drive pods: their wheel plate was offset toward the back; mirror each whole pod about its wheel axle so all four wheel
// plates face the front (toward the intake), like side A's
const POD_B_FLIP = (() => {   // the whole pod (every part of drive group 11 except the channel #11 and the spacers #272/#346 on the side plate), so
  // its own holes and screws move with the wheel plate; split into front and rear pod by x
  return [
    { name: "front", x: -99.95, body: [175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323] },
    { name: "rear", x: 148.05, body: [324, 325, 326, 327, 328, 329, 330, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 347, 348, 349, 350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398, 399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428, 429, 430, 431, 432, 433, 434, 435, 436, 437, 438, 439, 440, 441, 442, 443, 444, 445, 446, 447, 448, 449, 450, 451, 452, 453, 454, 455, 456, 457, 458, 459, 460, 461, 462, 463, 464, 465, 466, 467, 468, 469, 470, 471, 472] },
  ]; })();
for (const fl of POD_B_FLIP) { feats.push({ id: id("r"), type: "mirror", name: `Side B ${fl.name} drive pod: wheel plate faces the front`, body: fl.body, normal: [1, 0, 0], origin: [fl.x, 0, 0], merge: false }); n += fl.body.length; }
// the intake motor mount's own M4 holes (measured from body #1) go right through it: screws from outside side plate A, captive nuts
// in hex pockets on the mount's motor face (fit the nuts before the motor goes on)
const INTAKE_MOUNT_HOLES = [[-142.0, 92.8], [-142.1, 61.7], [-173.1, 92.9]];   // the mount's 4th corner has no through hole
for (const [hx, hz] of INTAKE_MOUNT_HOLES) hole("New M4 hole in side plate A for the intake motor mount (motor lowered)", 0, hx + PLATE_A_FIX[0], 354.2, hz + PLATE_A_FIX[2] - MOTOR_DROP, 4.3, 5);

// 1) move the shooter tower back (new M4 holes in the side plates), then the transfer; raise the transfer floor for 3 mm squeeze
const TOWER_FIX = [-1.0, 0, -0.1];   // the tower's bolt holes sat ~1 mm off the side plates' holes in the imported CAD
feats.push({ id: id("t"), type: "transform", name: `Move shooter tower back ${TOWER_PUSH} mm (and onto the side plates' holes)`, body: TOWER, translate: [TOWER_PUSH + TOWER_FIX[0], 0, TOWER_FIX[2]], copy: false });
// the tower as designed had its parts inside each other (they all moved together, so this is the original CAD): make it buildable
// - the shooter mount plate sat 0.3 mm into cross channel #8: lift it (the shooter sits on it)
feats.push({ id: id("t"), type: "transform", name: "Lift the shooter mount plate 0.3 mm onto cross channel #8", body: 4, translate: [0, 0, 0.3], copy: false });
// - cross channel #8 is 400 mm, the tower channels leave 383 mm: notch the tower channels' flanges where #8 runs through
// - the printed end blocks (#19, #23 on #8's ends; #3, #6, #20 in the tower channels' ends) sat inside the channels and side plate A:
//   trim each to the shapes around it
for (const [cut, from, what] of [[8, 2, "Notch tower channel A for cross channel #8"], [8, 10, "Notch tower channel B for cross channel #8"],
  [0, 19, "Trim end block #19 to side plate A"], [2, 19, "Trim end block #19 to tower channel A"], [10, 23, "Trim end block #23 to tower channel B"],
  [8, 23, "Trim end block #23 to cross channel #8"], [8, 19, "Trim end block #19 to cross channel #8"], [2, 3, "Trim end block #3 to tower channel A"], [2, 6, "Trim end block #6 to tower channel A"], [10, 20, "Trim end block #20 to tower channel B"]]) {
  feats.push({ id: id("t"), type: "transform", name: `Copy of #${cut} (cutter)`, body: cut, copy: true });
  cutWith(what, from, n++);
}
// channel #8 runs under the shooter plate's Ø84 exit hole: saw it square into two pieces at the hole's edges (y 108.6 / 192.6),
// each piece still bolted to its side of the tower. Replaces the earlier round cut (cy1/bo1). The cut runs before the tower
// move, so it uses the hole's original position.
const cutter = part.features.findIndex((f) => f.id === "cy1");
if (cutter >= 0) part.features[cutter] = { id: "cy1", type: "box", name: "Gap between the two pieces of channel #8 (cutter)", position: [56, 150.6, 46], w: 60, d: 89, h: 16, mode: "new" };   // 89 mm: the shooter's screw heads clear the cut ends
const cut = part.features.find((f) => f.id === "bo1"); if (cut) cut.name = "Saw channel #8 into two pieces under the exit hole";
const TOWER_HOLES = fs.existsSync(new URL("./tower-holes.json", import.meta.url)) ? JSON.parse(fs.readFileSync(new URL("./tower-holes.json", import.meta.url), "utf8")) : null;
for (const sp of SIDE_PLATES) for (const [hx, hz] of TOWER_HOLES?.[sp.body] ?? sp.holes.map(([x, z]) => [x + TOWER_PUSH, z])) hole("New M4 hole in side plate for the moved tower (at the channel's hole)", sp.body, hx, sp.y[0] - 1, hz, 4.3, 5);

// 2) new transfer (replaces the original plates #25/#622 and curved sheet #9, deleted at the end): a printed floor that starts at the
//    ground right behind the intake, rises at 15°, curves up (r 150) into a vertical wall under the shooter hole; Swyft 2.5 in gecko
//    wheels on five goBILDA REX shafts 96 mm off the floor (squeeze 6.6 mm on 71 mm pollen, 8.6 mm on 73 mm), alternating a centre
//    wheel with two side wheels so neighbouring wheels never touch; goBILDA 1611 bearings in new 3 mm side plates.
const GROUND_Z = -143;
const TR = (() => {
  const deg = Math.PI / 180, th = 15 * deg, RHO = 150, XW = 125, LIP = [-140, -137], WALL_TOP = 59, OFF = 99.9, PLATE_FRONT = -144;
  const C = [XW - RHO, 0];
  const T1x = C[0] + RHO * Math.sin(th); C[1] = LIP[1] + (T1x - LIP[0]) * Math.tan(th) + RHO * Math.cos(th);
  const T1 = [T1x, C[1] - RHO * Math.cos(th)];
  const surf = [], nIn = [];                                       // floor surface polyline (ball side) + inward normals
  const rampLen = Math.hypot(T1[0] - LIP[0], T1[1] - LIP[1]);
  for (let t = 0; t < rampLen; t += 10) { surf.push([LIP[0] + t * Math.cos(th), LIP[1] + t * Math.sin(th)]); nIn.push([-Math.sin(th), Math.cos(th)]); }
  const arcI0 = surf.length;
  for (let a = -75; a <= 0.001; a += 5) { const r = [Math.cos(a * deg), Math.sin(a * deg)]; surf.push([C[0] + RHO * r[0], C[1] + RHO * r[1]]); nIn.push([-r[0], -r[1]]); }
  surf.push([XW, WALL_TOP]); nIn.push([-1, 0]);
  const rampIn = (t) => [LIP[0] + t * Math.cos(th) - OFF * Math.sin(th), LIP[1] + t * Math.sin(th) + OFF * Math.cos(th)];
  const arcIn = (a) => [C[0] + (RHO - OFF) * Math.cos(a * deg), C[1] + (RHO - OFF) * Math.sin(a * deg)];
  // ---- shafts for constant contact (2.7 mm squeeze on 71 mm pollen, ~4.7 mm on 73 mm) ----
  // Each wheel only touches the ball over ~36 mm at this squeeze, so shafts sit as close as a wheel allows (wheel radius + 4 mm
  // shaft + 0.5 mm). Shafts alternate: one centre wheel, then a pair of side wheels at ±15.25 mm; the side pair sits closer to the
  // floor so it squeezes the same. Where a 2.5 in wheel would hit the shooter plate, 1.5 in wheels take over.
  const R71 = 35.5, SQ = 2.7, LAT = 15.25, RW = { 25: 30.9, 15: 17.6 };   // wheel radius to the fin tips that always touch (conservative)
  const reach = (kind, size, sq = SQ) => (kind === "center" ? R71 : Math.sqrt(R71 * R71 - LAT * LAT)) + RW[size] - sq;   // ball centre to shaft
  const rows = (kind) => (kind === "center" ? [YC] : [YC - LAT, YC + LAT]);
  const INTAKE = [-184, -56], INTAKE_ROWS = Array.from({ length: 13 }, (_, j) => YC + (j - 6) * 30.5);
  // floor surface sampled by arc length: ramp, curve, wall (+ inward normal)
  const arcLen = RHO * (75 * deg), wallLen = WALL_TOP - C[1];
  const foot = (u) => {
    if (u <= rampLen) return { p: [LIP[0] + u * Math.cos(th), LIP[1] + u * Math.sin(th)], n: [-Math.sin(th), Math.cos(th)] };
    if (u <= rampLen + arcLen) { const a = -75 * deg + (u - rampLen) / RHO, r = [Math.cos(a), Math.sin(a)]; return { p: [C[0] + RHO * r[0], C[1] + RHO * r[1]], n: [-r[0], -r[1]] }; }
    return { p: [XW, C[1] + (u - rampLen - arcLen)], n: [-1, 0] };
  };
  const totalLen = rampLen + arcLen + wallLen;
  const rowsClash = (ra, rb) => ra.some((y1) => rb.some((y2) => Math.abs(y1 - y2) < WHEEL_W + 0.5));
  const fits = (sh, prev) => {
    for (const q of prev) {
      const d = Math.hypot(sh[0] - q[0], sh[1] - q[1]);
      if (d < Math.max(RW[sh.size], RW[q.size]) + 4.3) return false;                               // wheel vs the other shaft
      if (rowsClash(sh.rows, q.rows) && d < RW[sh.size] + RW[q.size] + 0.3) return false;          // wheel vs wheel in the same rows
    }
    const di = Math.hypot(sh[0] - INTAKE[0], sh[1] - INTAKE[1]);
    if (di < RW[sh.size] + 4.5) return false;                                                       // wheel vs the intake shaft
    if (rowsClash(sh.rows, INTAKE_ROWS) && di < RW[sh.size] + 17.97 + 0.5) return false;            // wheel vs an intake wheel
    return true;
  };
  const underShooter = (sh) => !(sh[0] > 2 && sh[0] < 174 && sh[1] + RW[sh.size] > 59.4);
  const make = (p, kind, size, n) => Object.assign([p[0], p[1]], { kind, size, rows: rows(kind), n });
  // first shaft: side pair slotted between the intake wheels, 36 mm behind the intake shaft, touching the ball as the intake lets go
  const shafts = [];
  // coverage: ball-centre path (ground, then floor / curve / wall) for both pollen sizes; a wheel touches the ball when the
  // centre-to-shaft distance is under ball radius (side wheels: the ball's radius 15.25 mm off centre) + wheel radius
  const pathPts = (R) => { const pts = []; for (let x = -200; x < LIP[0]; x += 1) pts.push([x, GROUND_Z + R]);
    for (let u = 0; u <= totalLen; u += 1) { const f = foot(u), p = [f.p[0] + f.n[0] * R, f.p[1] + f.n[1] * R]; if (p[1] >= GROUND_Z + R - 0.01) pts.push(p); }
    return pts.filter((p, i, a) => i === 0 || p[0] >= a[0][0]); };
  const PATHS = [35.5, 36.5].map((R) => ({ R, pts: pathPts(R) }));
  const touchR = (R, kind, size) => (kind === "center" ? R : Math.sqrt(R * R - LAT * LAT)) + RW[size];
  const covered = (P, S, kind, size) => P.pts.map((p) => Math.hypot(p[0] - S[0], p[1] - S[1]) < touchR(P.R, kind, size) - 0.3);
  // the shaft rod crosses the whole channel: it must stay clear of the ball everywhere (rod radius 4 + 0.5 mm)
  const rodClear = (sh) => PATHS.every((P) => P.pts.every((p) => Math.hypot(p[0] - sh[0], p[1] - sh[1]) >= P.R + 4.5));
  const PATHS0 = PATHS.map((P) => { const c = P.pts.map((p) => Math.hypot(p[0] - INTAKE[0], p[1] - INTAKE[1]) < P.R + 17.97 - 0.3); let e = c.indexOf(true); while (e < c.length && c[e]) e++; return { ...P, intakeEnd: e }; });
  // first shaft: a side pair of 1.5 in wheels slotted between the intake wheels. Try positions that still overlap the intake's
  // contact and keep the one whose own contact reaches furthest along the path.
  { let bestS = null;
    for (let d0 = 22.5; d0 <= 60; d0 += 1.5) for (let bx = -176; bx <= -140; bx += 2) for (const sq of [2.7, 3.1, 3.5]) {
      const B0 = [bx, GROUND_Z + R71], d1 = reach("side", 15, sq), dx = B0[0] - INTAKE[0], dz = B0[1] - INTAKE[1], L = Math.hypot(dx, dz);
      const a = (d0 * d0 - d1 * d1 + L * L) / (2 * L), h2 = d0 * d0 - a * a; if (h2 < 0) continue;
      const h = Math.sqrt(h2), m = [INTAKE[0] + (a * dx) / L, INTAKE[1] + (a * dz) / L];
      const p = [[m[0] + (h * dz) / L, m[1] - (h * dx) / L], [m[0] - (h * dz) / L, m[1] + (h * dx) / L]].sort((u, v) => v[0] - u[0])[0];   // the one behind the intake
      const sh = make(p, "side", 15, [-Math.sin(th), Math.cos(th)]);
      if (!fits(sh, []) || !rodClear(sh)) continue;
      let ok = true, score = 0;
      PATHS0.forEach((P, k) => { const c = covered(P, sh, "side", 15); const e = P.intakeEnd; if (!c[Math.max(0, e - 2)]) ok = false; let j = e; while (j < c.length && c[j]) j++; score += j; });
      if (ok && (!bestS || score > bestS.score)) bestS = { sh, score };
    }
    shafts.push(bestS.sh); }
  const ENDZ = 58;                                                 // drive the ball until its centre is this high (into the shooter hole)
  const cov = PATHS.map((P) => { const c = P.pts.map((p) => Math.hypot(p[0] - INTAKE[0], p[1] - INTAKE[1]) < P.R + 17.97 - 0.3);   // intake wheels
    const first = c.indexOf(true); for (let i = 0; i < first; i++) c[i] = true; return c; });   // before the intake grabs it the ball is just on the field
  const addCov = (sh) => PATHS.forEach((P, k) => covered(P, sh, sh.kind, sh.size).forEach((c, i) => { if (c) cov[k][i] = true; }));
  addCov(shafts[0]);
  // rear shaft: behind the wall, wheel through a slot in it, as high as the shooter plate allows; pushes the ball's back side up
  { const z = 59.4 - RW[15], x = XW - R71 + R71 + RW[15] - SQ;
    const rear = make([x, z], "center", 15, [1, 0]); rear.rear = true; shafts.push(rear); addCov(rear); }
  const reachEnd = (k) => { let i = 0; while (i < cov[k].length && cov[k][i]) i++; return i; };   // first uncovered sample
  for (let guard = 0; guard < 40; guard++) {
    const ends = PATHS.map((_, k) => reachEnd(k));
    if (PATHS.every((P, k) => ends[k] >= P.pts.length || P.pts[ends[k]][1] > ENDZ)) break;
    let best = null;
    for (let u = 0; u <= totalLen; u += 1) {
      const f = foot(u);
      // 2.5 in wheels on the straight 15° section; 1.5 in around the curve and up the wall (their touch zones are long enough to
      // overlap on the inside of a bend, a 2.5 in wheel's are not)
      for (const kind of ["center", "side"]) for (const size of u > 70 && u < rampLen - 15 ? [25, 15] : [15]) for (const sq of [2.7, 3.1, 3.5]) {
        const r = R71 + reach(kind, size, sq), sh = make([f.p[0] + f.n[0] * r, f.p[1] + f.n[1] * r], kind, size, f.n);
        if (!underShooter(sh) || !fits(sh, shafts) || !rodClear(sh)) continue;
        // must touch the ball where contact currently ends (both sizes), score = how far it then reaches
        let ok = true, score = 0;
        PATHS.forEach((P, k) => { const c = covered(P, sh, kind, size); const e = ends[k]; if (e < c.length && !c[Math.max(0, e - 2)]) ok = false; let j = e; while (j < c.length && (c[j] || cov[k][j])) j++; score += j; });
        if (!ok) continue;
        if (!best || score > best.score || (score === best.score && (size > best.sh.size || sq < best.sq))) best = { sh, score, sq };
      }
    }
    if (!best) break;
    shafts.push(best.sh); addCov(best.sh);
  }
  shafts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  shafts.gaps = PATHS.map((P, k) => { const e = reachEnd(k); return e >= P.pts.length || P.pts[e][1] > ENDZ ? null : P.pts[e].map((v) => Math.round(v)); });
  if (shafts.gaps.some(Boolean)) console.log("contact gap (71 / 73 mm) starts at:", JSON.stringify(shafts.gaps));
  return { arcI: [arcI0, arcI0 + 15], th, RHO, XW, LIP, WALL_TOP, OFF, C, T1, surf, nIn, shafts, PLATE_FRONT: Math.min(PLATE_FRONT, shafts[0][0] - 16), rampIn, arcIn, RW };
})();
const Y_IN = [Y_OUT[0] + 3, Y_OUT[1] - 3];                      // plate inner faces 105.6 / 192.4
const WHEEL25 = "imports/SR-INTAKEWHEEL-25-7mm.step";
const sideFrame = (y) => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] });   // sketch x = world X, sketch y = world Z
const add = (pts) => ({ type: "polyline", points: pts.map(([x, z]) => [r2(x), r2(z)]) });
const circ = (x, z, d, op = "subtract") => ({ type: "circle", cx: r2(x), cy: r2(z), r: d / 2, op });
const extrudeSketch = (name, entities, y, dist, flip = false) => {
  const sid = id("s"); feats.push({ id: sid, type: "sketch", name: `${name} profile`, plane: sideFrame(y), entities });
  feats.push({ id: id("e"), type: "extrude", name, sketch: sid, distance: dist, flip, mode: "new" }); return n++; };
// every joint is a screw and a nut (no heat-set inserts): an M4 clearance hole, and in a printed part a hex pocket that holds the nut
// (7.4 mm across flats, 3.5 mm deep), with a slot out to the nearest outside face when the nut sits inside the part
const NUT = { af: 7.4, t: 3.5, hole: 4.4 };
const SCREWS = [];   // every M4 screw: { name, x, z, y0 (head side), y1 (nut side), captive } -> scripts/screws.json for check-fasteners.mjs
const deg = (v) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
function nutPocket(name, body, x, z, y0, dir, nutFrom, slot = null) {
  const ents = [{ type: "polygon", cx: r2(x), cy: r2(z), r: r2(NUT.af / Math.sqrt(3) + 0.05), sides: 6, angle: slot ? r2(deg(slot.dir)) : 0 }];
  if (slot) ents.push({ type: "rect", cx: r2(x + (slot.dir[0] * slot.len) / 2), cy: r2(z + (slot.dir[1] * slot.len) / 2), w: r2(slot.len), h: NUT.af, angle: r2(deg(slot.dir)) });
  const ys = y0 + dir * nutFrom;
  cutWith(`${name}: captive M4 nut pocket${slot ? " + slot" : ""}`, body, extrudeSketch("Nut pocket (cutter)", ents, dir < 0 ? ys + 0.05 : ys - 0.05, NUT.t + 0.1, dir > 0));
}
// y0: the face of the printed part the screw enters; headAt: where the screw head sits (default: on the 3 mm metal plate before it)
function nutJoint(name, body, x, z, y0, dir, depth, nutFrom, slot = null, headAt = y0 - dir * 3) {
  SCREWS.push({ name, x: r2(x), z: r2(z), face: r2(headAt), dir, nutAt: r2(y0 + dir * (nutFrom + NUT.t)), captive: true });
  cutWith(`${name}: M4 clearance hole`, body, cyl("M4 (cutter)", [x, y0 - dir * 0.1, z], [0, dir, 0], NUT.hole, depth + 0.1));
  nutPocket(name, body, x, z, y0, dir, nutFrom, slot);
  count("M4 screw + nut");
}
for (const [hx, hz] of INTAKE_MOUNT_HOLES) { const x = hx + PLATE_A_FIX[0], z = hz + PLATE_A_FIX[2] - MOTOR_DROP;
  nutPocket("Intake motor mount", 1, x, z, 326.1, 1, 0); count("M4 screw + nut"); SCREWS.push({ name: "Intake motor mount", x: r2(x), z: r2(z), face: 358.2, dir: -1, nutAt: 326.1, captive: true }); }
const BP = { src: 21, bore: [-184, -53.8, -56], holes: [-8, 0, 8].flatMap((w) => [18, -14].map((u) => [w, u])), w: 12, uMin: -18, uMax: 22 };
// bearing plates: every transfer bearing sits in a copy of the intake's bearing plate (#21: 24 x 40 x 5 mm, 14 mm bearing pocket 18 mm
// from one end, 2 x 3 M4 holes 8 mm apart at +18 / -14 mm from the pocket). Long side points away from the floor. Where two would
// overlap on one face, the next goes on the inside face of the transfer plate (clear of the ball and wheels).
const MOTOR_I = TR.shafts.map((sh, i) => [i, sh]).filter(([, sh]) => !sh.rear).sort((a, b) => (b[1].size - a[1].size) || (a[1].kind === "center" ? -1 : 1) || 0).filter((x, _, arr) => x[1].size === arr[0][1].size).sort((a, b) => Math.abs(a[1][0] + 60) - Math.abs(b[1][0] + 60))[0][0];
const rect = (sh, d) => { const wd = [d[1], -d[0]]; return [[-BP.w, BP.uMin], [BP.w, BP.uMin], [BP.w, BP.uMax], [-BP.w, BP.uMax]].map(([w, u]) => [sh[0] + w * wd[0] + u * d[0], sh[1] + w * wd[1] + u * d[1]]); };
const sepAxis = (A, B) => { for (const P of [A, B]) for (let i = 0; i < 4; i++) { const p = P[i], q = P[(i + 1) % 4], ax = [q[1] - p[1], p[0] - q[0]];
  const pa = A.map((v) => v[0] * ax[0] + v[1] * ax[1]), pb = B.map((v) => v[0] * ax[0] + v[1] * ax[1]); if (Math.max(...pa) < Math.min(...pb) - 0.5 * Math.hypot(...ax) || Math.max(...pb) < Math.min(...pa) - 0.5 * Math.hypot(...ax)) return true; } return false; };
const PLAN = { outer: [], inner: [] };
for (const [i, sh] of TR.shafts.entries()) {
  const d = sh.rear ? [-1, 0] : [-sh.n[0], -sh.n[1]];                        // long side away from the floor = toward the floor? (-n points at the floor)
  const r = rect(sh, d.map((v) => -v));                                   // 22 mm side away from the floor, 18 mm side toward it
  const motorShaft = i === MOTOR_I;
  const face = !motorShaft && i !== 0 && PLAN.outer.every((o) => sepAxis(o.r, r)) ? "outer" : "inner";   // shaft 1: outside would hit the funnel servos
  sh.face = face; sh.bpDir = d.map((v) => -v); sh.bpRect = r; PLAN[face].push({ i, r });
}
const bpHoles = TR.shafts.flatMap((sh) => { const d = sh.bpDir, wd = [d[1], -d[0]]; return BP.holes.map(([w, u]) => circ(sh[0] + w * wd[0] + u * d[0], sh[1] + w * wd[1] + u * d[1], 4.4)); });
// a bearing-plate hole takes a screw only if the screw can come out the other side: not into the solid of a bearing plate on the
// opposite face of the transfer plate (unless that plate has its own hole right there: then one longer screw clamps both)
const bpLocal = (sh, x, z) => { const d = sh.bpDir, wd = [d[1], -d[0]], r = [x - sh[0], z - sh[1]]; return [r[0] * wd[0] + r[1] * wd[1], r[0] * d[0] + r[1] * d[1]]; };
const keptFor = (side) => { const out = [];
  for (const sh of TR.shafts) { if (side === "B" && sh === TR.shafts[MOTOR_I]) continue; const d = sh.bpDir, wd = [d[1], -d[0]];
    for (const [w, u] of BP.holes) { const hx = sh[0] + w * wd[0] + u * d[0], hz = sh[1] + w * wd[1] + u * d[1];
      if (sh.face === "inner" && Math.hypot(hx - INTAKE_SHAFT.x, hz - INTAKE_SHAFT.z) < 19.05 + 3.8 + 1) continue;   // head would hit an intake wheel
      const blocked = TR.shafts.some((o) => { if (o === sh || o.face === sh.face || (side === "B" && o === TR.shafts[MOTOR_I])) return false; const od = o.bpDir, owd = [od[1], -od[0]], r = [hx - o[0], hz - o[1]];
        const ow = r[0] * owd[0] + r[1] * owd[1], ou = r[0] * od[0] + r[1] * od[1];
        if (!(Math.abs(ow) <= BP.w + 2.2 && ou >= BP.uMin - 2.2 && ou <= BP.uMax + 2.2)) return false;
        return !BP.holes.some(([a, c]) => Math.hypot(a - ow, c - ou) < 0.5); });
      if (blocked) continue;
      if (out.some((h) => Math.hypot(h.cx - hx, h.cy - hz) < 0.5)) continue;   // shared with the other plate's hole
      if (out.some((h) => Math.hypot(h.cx - hx, h.cy - hz) < 4.4 + 2)) { console.log(`bearing plate hole ${hx.toFixed(1)}, ${hz.toFixed(1)} left out: too close to another plate's screw`); continue; }
      out.push(circ(hx, hz, 4.4)); } }
  return out; };
const keptBP_B = keptFor("B"), keptBP_A = keptFor("A"), keptBP = keptBP_B;
console.log(`bearing-plate screws through the transfer plates: B ${keptBP_B.length}, A ${keptBP_A.length}`);
// head on the bearing plate (outer plates: outside; inner plates: inside the transfer), nut on the plate's other face
for (const [yo, yi, side] of [[Y_OUT[0], Y_IN[0], "B"], [Y_OUT[1], Y_IN[1], "A"]]) {
  const outDir = side === "B" ? -1 : 1;
  for (const h of side === "B" ? keptBP_B : keptBP_A) { if (Math.hypot(h.cx - TR.shafts[0][0], h.cy - TR.shafts[0][1]) < 21 && Math.hypot(h.cx - INTAKE_SHAFT.x, h.cy - INTAKE_SHAFT.z) > 19.05 + 3.8 + 1) continue;   // shaft 1: nuts in the intake shaft support
    const on = TR.shafts.filter((sh) => { if (side === "B" && sh === TR.shafts[MOTOR_I]) return false; const [w, u] = bpLocal(sh, h.cx, h.cy); return Math.abs(w) <= BP.w && u >= BP.uMin && u <= BP.uMax; });
    const outer = on.some((sh) => sh.face === "outer"), inner = on.some((sh) => sh.face === "inner");
    const head = outer ? yo + outDir * 5 : yi - outDir * 5, nut = inner && outer ? yi - outDir * 5 : outer ? yi : yo;
    SCREWS.push({ name: `Bearing plate screw (transfer plate ${side})`, x: r2(h.cx), z: r2(h.cy), face: head, dir: Math.sign(nut - head), nutAt: nut, captive: false }); } }
// everything is bolted (screw + nut): a bearing plate's six M4 holes all go through the transfer plate, so no other hole may sit under
// a bearing plate (or within 5 mm of one, room for a screw head or nut beside it)
const underBP = (x, z, margin = 5) => TR.shafts.some((sh) => { const [w, u] = bpLocal(sh, x, z); return Math.abs(w) <= BP.w + margin && u >= BP.uMin - margin && u <= BP.uMax + margin; });
// floor: 10 mm thick outward of the surface, clipped 5.6 mm above the ground at the lip; printed in three pieces
const FLOOR_T = 10;
const outer = TR.surf.map(([x, z], i) => [x - TR.nIn[i][0] * FLOOR_T, z - TR.nIn[i][1] * FLOOR_T]);
const floorPoly = [...TR.surf, ...outer.reverse()];
// the exact floor: the 15° ramp and the vertical wall are straight slabs, the R150 curve is a true cylinder shell (R150 to R160)
// cut to its 75° wedge, so the ball-side surface is a real arc, not facets
const dirA = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const atC = (r, deg) => [TR.C[0] + r * dirA(deg)[0], TR.C[1] + r * dirA(deg)[1]];
const wedge = (deg0, deg1, far) => [TR.C, atC(far, deg0), atC(far * 1.6, (deg0 + deg1) / 2), atC(far, deg1)];
function exactFloor(name) {
  const nR = [-Math.sin(TR.th), Math.cos(TR.th)], T1 = atC(TR.RHO, -75), L0 = TR.LIP;
  const ramp = extrudeSketch(name, [add([L0, T1, [T1[0] - nR[0] * FLOOR_T, T1[1] - nR[1] * FLOOR_T], [L0[0] - nR[0] * FLOOR_T, L0[1] - nR[1] * FLOOR_T]])], Y_IN[1], Y_IN[1] - Y_IN[0]);
  const shell = cyl("Floor curve outer (R160)", [TR.C[0], Y_IN[0], TR.C[1]], [0, 1, 0], 2 * (TR.RHO + FLOOR_T), Y_IN[1] - Y_IN[0]);
  cutWith("Floor curve: hollow to R150", shell, cyl("Floor curve inner (R150, cutter)", [TR.C[0], Y_IN[0] - 1, TR.C[1]], [0, 1, 0], 2 * TR.RHO, Y_IN[1] - Y_IN[0] + 2));
  cutWith("Floor curve: keep the 75° wedge", shell, extrudeSketch("Floor curve wedge", [add(wedge(-75, 0, TR.RHO + FLOOR_T + 40))], Y_IN[1] + 1, Y_IN[1] - Y_IN[0] + 2), "intersect");
  cutWith("Floor: ramp + curve", ramp, shell, "union");
  if (TR.WALL_TOP > TR.C[1] + 0.5) cutWith("Floor: + wall", ramp, extrudeSketch("Floor wall", [add([[TR.XW, TR.C[1]], [TR.XW, TR.WALL_TOP], [TR.XW + FLOOR_T, TR.WALL_TOP], [TR.XW + FLOOR_T, TR.C[1]]])], Y_IN[1], Y_IN[1] - Y_IN[0]), "union");
  return ramp;
}
const FLOOR_SPLITS = [-140.5, -60, 40, 160];
const floorInserts = [], floorBodies = [];
for (let k = 0; k < 3; k++) {
  const fb = exactFloor(`Transfer floor piece ${k + 1} (3D-printed PETG)`); floorBodies.push(fb);
  cutWith(`Transfer floor piece ${k + 1}: trim to its length`, fb, box("cutter", FLOOR_SPLITS[k], FLOOR_SPLITS[k + 1], 90, 210, -137.5, 80), "intersect");
  // two M4 screws into each side face (mid-thickness of the floor), through the plates, nuts in slots from the underside
  const along = TR.surf.map(([x, z], i) => Object.assign([x - TR.nIn[i][0] * FLOOR_T / 2, z - TR.nIn[i][1] * FLOOR_T / 2], { out: [-TR.nIn[i][0], -TR.nIn[i][1]] })).filter(([x, z]) => x > FLOOR_SPLITS[k] + 12 && x < FLOOR_SPLITS[k + 1] - 12 && z > -134);
  const free = along.filter(([x, z]) => !underBP(x, z));
  const pickNear = (f) => free.length ? free.reduce((a, c) => (Math.abs(along.indexOf(c) - f * along.length) < Math.abs(along.indexOf(a) - f * along.length) ? c : a)) : null;
  const picks = [...new Set([pickNear(0.2), pickNear(0.8)].filter(Boolean))];
  if (picks.length < 2) console.log(`WARNING floor piece ${k + 1}: only ${picks.length} screw spot(s) clear of the bearing plates`);
  for (const p of picks) {
    const [x, z] = p, nOut = p.out;   // outward normal of the floor (away from the ball) at this spot
    floorInserts.push([x, z]);
    for (const [y0, dir] of [[Y_IN[0], 1], [Y_IN[1], -1]])   // screw through the transfer plate, nut slot from the floor's underside
      nutJoint(`Transfer floor piece ${k + 1}`, fb, x, z, y0, dir, 14, 8, { dir: nOut, len: FLOOR_T / 2 + 1 });
  }
  count("3D-printed transfer floor piece (PETG, print on its side)");
}
{ const [rx, rz] = TR.shafts.find((sh) => sh.rear);
  feats.push({ id: id("c"), type: "cylinder", name: "Wall slot for the rear wheel (cutter)", position: [r2(rx), YC - 8.5, r2(rz)], direction: [0, 1, 0], r: TR.RW[15] + 2.5, h: 18, mode: "new" }); n++;
  cutWith("Transfer wall (floor piece 3): slot for the rear push wheel", floorBodies[2], n - 1); }
// side plates (3 mm aluminium or polycarbonate): band from under the floor to past the shafts, a tab back to rear channel #22
const outerBand = TR.surf.map(([x, z], i) => [x - TR.nIn[i][0] * (FLOOR_T + 6), z - TR.nIn[i][1] * (FLOOR_T + 6)]).map(([x, z]) => [x, Math.max(z, -137)]);   // 6 mm above the ground
const innerBand = TR.shafts.filter((sh) => !sh.rear).map((sh) => [sh[0] + sh.n[0] * 28, sh[1] + sh.n[1] * 28]);
const inner = innerBand.reverse();
const rawPoly = [[-144, -137], ...outerBand.filter(([x]) => x > TR.PLATE_FRONT + 1), [TR.XW + FLOOR_T + 6, TR.WALL_TOP], [113, TR.WALL_TOP], [113, 47.5], [61, 47.5], [61, 54], [Math.min(...TR.shafts.map((p) => p[0])) > 0 ? 0 : 24, 54], ...inner, [TR.PLATE_FRONT, inner.at(-1)[1]], [TR.PLATE_FRONT, -60]];
// drop near-duplicate and collinear points (tiny or straight-through edges upset the kernel)
const platePoly = rawPoly.filter((p, i, a) => { const q = a[(i + a.length - 1) % a.length], r = a[(i + 1) % a.length];
  if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1) return false;
  return Math.abs((p[0] - q[0]) * (r[1] - q[1]) - (p[1] - q[1]) * (r[0] - q[0])) > 1e-3 * Math.hypot(r[0] - q[0], r[1] - q[1]) ** 2; });
const CH8 = { x: 56 + TOWER_PUSH + TOWER_FIX[0], zBot: 48.1 + TOWER_FIX[2] }, CH22 = { xFront: 152, zMid: -42 };
// intake shaft supports (one per transfer plate): the 7 mm hex intake shaft spans 432 mm between the side plates; a printed arm on
// each transfer plate's outer face (in the gap between intake wheels) carries it in a bushing, so the longest free span is ~170 mm
// it bolts through transfer shaft 1's bearing-plate screw holes (bearing plate, transfer plate, the arm, a nut in the arm), so
// the plate gets no new holes; 6 mm thick, it fits the 17.8 mm gap between two intake wheels with 2 mm to spare
const HANGER = { shaft: [-184, -56], T: 6 };
const plateHoles = [...FUNNEL_REAR_TAB.holes.map(([x, z]) => circ(x, z, 4.4)), ...TR.shafts.map(([x, z]) => circ(x, z, 14)), ...floorInserts.map(([x, z]) => circ(x, z, 4.4)),
  circ(CH8.x, CH8.zBot - 13.8, 4.4), circ(CH8.x, CH8.zBot - 37.1, 4.4), circ(CH22.xFront - 13.8, CH22.zMid, 4.4), circ(CH22.xFront - 37.1, CH22.zMid, 4.4)];
const tab = { type: "rect", cx: 125, cy: -42, w: 52, h: 36 };
const REAR = TR.shafts.find((sh) => sh.rear), rearBoss = { type: "rect", cx: r2(REAR[0] - 2), cy: r2(REAR[1]), w: 48, h: 28 };
const MOTOR_I_LATE = TR.shafts.map((sh, i) => [i, sh]).filter(([, sh]) => !sh.rear).sort((a, b) => (b[1].size - a[1].size) || (a[1].kind === "center" ? -1 : 1) || 0).filter((x, _, arr) => x[1].size === arr[0][1].size).sort((a, b) => Math.abs(a[1][0] + 60) - Math.abs(b[1][0] + 60))[0][0];
const ms = TR.shafts[MOTOR_I];
// minimal transfer motor mount: a printed plate on the motor face (its 4 M3 screws, 16 mm square) held off transfer plate B by three
// goBILDA 32 mm M4 standoffs (1501-0006-0320). The coupler runs inside them. Standoff spots: on plate B with 4 mm round them, clear of
// the outside bearing plates and every bearing-plate screw, heads inside clear of the inside bearing plates and the floor, motor-side
// heads clear of the gearbox; of those, the three that make the biggest triangle round the motor axis
const MS = { motorFace: Y_OUT[0] - 40, plateT: 8, standoff: 32, file: "imports/gobilda-1501-0006-0320-standoff-32mm.step" };
const STANDOFFS = (() => {
  const P = platePoly, inPoly = (x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const segD = (p, a, b) => { const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2)); return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])); };
  const edgeD = (p) => Math.min(...P.map((a, i) => segD(p, a, P[(i + 1) % P.length])));
  const inFoot = (sh, x, z, m) => { const [w, u] = bpLocal(sh, x, z); return Math.abs(w) <= BP.w + m && u >= BP.uMin - m && u <= BP.uMax + m; };
  const floorIn = (x, z) => { let c = false; const F = floorPoly; for (let i = 0, j = F.length - 1; i < F.length; j = i++) { const [xi, yi] = F[i], [xj, yj] = F[j]; if ((yi > z) !== (yj > z) && x < ((xj - xi) * (z - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const ok = [];
  for (let r = 21; r <= 36; r += 1) for (let dg = 0; dg < 360; dg += 3) {
    const dx = r * Math.cos((dg * Math.PI) / 180), dz = r * Math.sin((dg * Math.PI) / 180), x = ms[0] + dx, z = ms[1] + dz;
    if (Math.max(Math.abs(dx), Math.abs(dz)) < 22.3) continue;                                         // motor-side head vs the 36 mm gearbox
    if (!inPoly(x, z) || edgeD([x, z]) < 4) continue;
    if (TR.shafts.some((sh) => sh !== ms && Math.hypot(sh[0] - x, sh[1] - z) < 12)) continue;
    if (TR.shafts.some((sh) => sh !== ms && sh.face === "outer" && inFoot(sh, x, z, 3.9))) continue;   // standoff vs outside bearing plates
    if (TR.shafts.some((sh) => sh !== ms && sh.face === "inner" && inFoot(sh, x, z, 4.3))) continue;   // inside head vs inside bearing plates
    if (keptBP_B.some((h) => Math.hypot(h.cx - x, h.cy - z) < 7.8)) continue;                        // bearing-plate screws, heads, nuts
    if ([...FUNNEL_REAR_TAB.holes, ...floorInserts].some(([hx, hz]) => Math.hypot(hx - x, hz - z) < 8)) continue;
    if (floorIn(x, z) || TR.surf.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 4.5)) continue;     // inside head vs the floor
    ok.push([dx, dz]); }
  let best = null, bestA = 0;
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) for (let k = j + 1; k < ok.length; k++) {
    const [a, b, c] = [ok[i], ok[j], ok[k]], A = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    const side = (p, q) => Math.sign(p[0] * q[1] - p[1] * q[0]); const has = side(a, b) === side(b, c) && side(b, c) === side(c, a);   // axis inside
    if (has && A > bestA) { bestA = A; best = [a, b, c]; } }
  if (!best) throw new Error(`no room for 3 motor standoffs (${ok.length} spots)`);
  console.log(`transfer motor standoffs at ${best.map(([dx, dz]) => `(${dx.toFixed(1)}, ${dz.toFixed(1)})`).join(" ")} from the motor axis (${ok.length} spots allowed)`);
  return best; })();
const mountHoles = STANDOFFS.map(([dx, dz]) => circ(ms[0] + dx, ms[1] + dz, 4.3));
// L-brackets from the transfer plates to cross channel #8 and rear channel #22 (replace the old 90° printed mounts): the channel
// screws go through the channels' own Ø4 holes; the plate screws through new holes picked clear of everything on both plates
const BRACKETS = [
  { ch: 8, plateLeg: { x: [71, 103], z: [8, 48] }, search: { x: [75, 99], z: [14, 38] }, avoidX: [80.4, 93.6] },   // nuts clear of the channel leg (z 43) and the gusset (x 85-89)
  { ch: 22, plateLeg: { x: [117, 152], z: [-56, -28] }, search: { x: [121, 142], z: [-47, -32] } },   // nuts clear of the channel leg (x 147) and the gusset (z -52)
];
for (const br of BRACKETS) {
  const P = platePoly, inPoly = (x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const segD = (p, a, b) => { const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2)); return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])); };
  const edgeD = (p) => Math.min(...P.map((a, i) => segD(p, a, P[(i + 1) % P.length])));
  const inFoot = (sh, x, z, m) => { const [w, u] = bpLocal(sh, x, z); return Math.abs(w) <= BP.w + m && u >= BP.uMin - m && u <= BP.uMax + m; };
  const floorIn = (x, z) => { let c = false; const F = floorPoly; for (let i = 0, j = F.length - 1; i < F.length; j = i++) { const [xi, yi] = F[i], [xj, yj] = F[j]; if ((yi > z) !== (yj > z) && x < ((xj - xi) * (z - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const others = [...keptBP_B, ...keptBP_A, ...mountHoles, ...[...FUNNEL_REAR_TAB.holes, ...floorInserts].map(([x, z]) => ({ cx: x, cy: z }))];
  const ok = [];
  for (let x = br.search.x[0]; x <= br.search.x[1]; x += 1) for (let z = br.search.z[0]; z <= br.search.z[1]; z += 1) {
    if (br.avoidX && x > br.avoidX[0] && x < br.avoidX[1]) continue;
    const inTab = Math.abs(x - tab.cx) <= tab.w / 2 - 5 && Math.abs(z - tab.cy) <= tab.h / 2 - 5;   // the plate's rear tab counts as plate
    if (!inTab && (!inPoly(x, z) || edgeD([x, z]) < 5)) continue;
    if (TR.shafts.some((sh) => Math.hypot(sh[0] - x, sh[1] - z) < 12)) continue;
    if (TR.shafts.some((sh) => inFoot(sh, x, z, 4.3))) continue;                           // heads and nuts clear of every bearing plate
    if (others.some((h) => Math.hypot(h.cx - x, h.cy - z) < 8.5)) continue;
    if (floorIn(x, z) || TR.surf.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 5)) continue;   // inside heads clear of the floor
    ok.push([x, z]); }
  let best = null, bd = 0; for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) { const d = Math.hypot(ok[i][0] - ok[j][0], ok[i][1] - ok[j][1]); if (d > bd) { bd = d; best = [ok[i], ok[j]]; } }
  if (!best) throw new Error(`no room for the channel #${br.ch} bracket's plate screws`);
  br.plateScrews = best; console.log(`channel #${br.ch} bracket: plate screws at ${best.map((p) => p.join(", ")).join(" and ")}`);
}
const bracketHoles = BRACKETS.flatMap((br) => br.plateScrews.map(([x, z]) => circ(x, z, 4.4)));
if (process.env.DUMP_PLATE) fs.writeFileSync(process.env.DUMP_PLATE, JSON.stringify(platePoly.map((p) => p.map(r2))));
// lightening holes in the transfer side plates: Ø24 where they fit, else Ø16, each with an 8 mm web to the plate edge, every hole
// and to the other lightening holes, and clear of everything bolted to the plate (bearing plates, mounts, motor mount)
const LIGHT = (() => {
  const P = platePoly, inPoly = (x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const edgeD = (x, y) => { let m = 1e9; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [ax, ay] = P[j], [bx, by] = P[i]; const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1; const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2)); m = Math.min(m, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay))); } return m; };
  const keep = [];                                                 // [x, z, radius] areas that must stay solid
  for (const sh of TR.shafts) keep.push([sh[0], sh[1], 24]);       // bearing plate footprint (reaches 22 mm) + bearing hole
  for (const [x, z] of floorInserts) keep.push([x, z, 6]);
  keep.push([CH8.x, CH8.zBot - 25, 24], [CH22.xFront - 20, CH22.zMid, 26], [-90, -106, 24]);   // printed mounts
  keep.push([TR.shafts[MOTOR_I][0], TR.shafts[MOTOR_I][1], 34]);   // motor mount flange
  const out = [];
  for (const r of [12, 8]) for (let x = -160; x <= 150; x += 2) for (let z = -138; z <= 58; z += 2) {
    if (!inPoly(x, z) || edgeD(x, z) < r + 8) continue;
    if (x > 99 && x < 151 && z > -60 && z < -24) continue;       // rear mount tab
    if (keep.some(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) < kr + r + 8)) continue;
    if (out.some(([ox, oz, or]) => Math.hypot(x - ox, z - oz) < or + r + 8)) continue;
    out.push([x, z, r]);
  }
  return out;
})();
const lightHoles = LIGHT.map(([x, z, r]) => circ(x, z, 2 * r));
console.log(`transfer side plates: ${LIGHT.length} lightening holes (${LIGHT.filter((h) => h[2] === 12).length} x Ø24, ${LIGHT.filter((h) => h[2] === 8).length} x Ø16)`);
// bearing-plate bolt holes: keep one only if it leaves >= 3 mm of material to every other hole and to the plate's edge
// (crowded shafts then use 4-5 of a bearing plate's 6 bolts instead of two holes running into each other)
const spaced = (base, extra, rects) => {
  const P = platePoly, inRect = (x, y) => rects.some((r) => (r.type === "rect" ? Math.abs(x - r.cx) <= r.w / 2 && Math.abs(y - r.cy) <= r.h / 2 : Math.hypot(x - r.cx, y - r.cy) <= r.r));
  const edgeD = (x, y) => { let m = 1e9; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [ax, ay] = P[j], [bx, by] = P[i]; const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1; const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2)); m = Math.min(m, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay))); } return m; };
  const kept = [...base], out = [];
  for (const h of extra) {
    if (kept.some((k) => Math.hypot(k.cx - h.cx, k.cy - h.cy) - k.r - h.r < 3)) continue;
    if (!inRect(h.cx, h.cy) && edgeD(h.cx, h.cy) - h.r < 3) continue;
    kept.push(h); out.push(h);
  }
  return out;
};
const motorBoss = { type: "circle", cx: r2(ms[0]), cy: r2(ms[1]), r: 30 };   // plate B carries the motor mount
// the plates' curved edge is a true R166 arc: the outline runs out past the curve, then (wedge minus an R166 cylinder) is cut away;
// the tab and the bosses that reach past the curve are a second extrude with the same holes, joined on after that cut
const R_PL = TR.RHO + FLOOR_T + 6, FAR_PL = R_PL + 60;
const buildPoly = (() => { const [i0, i1] = TR.arcI, ob = outerBand.map((p) => p.slice());
  ob.splice(i0, i1 - i0 + 1, atC(R_PL, -75), atC(FAR_PL, -74), atC(FAR_PL * 1.4, -37.5), atC(FAR_PL, -1), atC(R_PL, 0));   // far points 1° inside the cut wedge
  const raw = [[-144, -137], ...ob.filter(([x]) => x > TR.PLATE_FRONT + 1), ...rawPoly.slice(1 + outerBand.filter(([x]) => x > TR.PLATE_FRONT + 1).length)];
  return raw.filter((p, i, a) => { const q = a[(i + a.length - 1) % a.length], r = a[(i + 1) % a.length]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1) return false;
    return Math.abs((p[0] - q[0]) * (r[1] - q[1]) - (p[1] - q[1]) * (r[0] - q[0])) > 1e-3 * Math.hypot(r[0] - q[0], r[1] - q[1]) ** 2; }); })();
const exactPlate = (name, holes, bosses, y, flip) => {
  const pl = extrudeSketch(name, [add(buildPoly), ...holes], y, 3, flip);
  const cut = extrudeSketch(`${name}: outside the R${R_PL} curve (cutter)`, [add(wedge(-75, 0, FAR_PL + 5))], flip ? y - 1 : y + 1, 5, flip);
  cutWith(`${name}: R${R_PL} curve (cutter)`, cut, cyl("R166 (cutter)", [TR.C[0], y - 10, TR.C[1]], [0, 1, 0], 2 * R_PL, 20));
  cutWith(`${name}: true R${R_PL} curved edge`, pl, cut);
  cutWith(`${name}: tab and bosses`, pl, extrudeSketch(`${name} tab and bosses`, bosses.map((b) => ({ ...b, op: "add" })), y, 3, flip), "union");
  cutWith(`${name}: holes through the tab and bosses`, pl, extrudeSketch(`${name} holes (cutter)`, holes.map((h) => ({ ...h, op: "add" })), flip ? y - 1 : y + 1, 5, flip));
  return pl; };
{ const others = [...FUNNEL_REAR_TAB.holes.map(([x, z]) => ["funnel screw", x, z]), ...floorInserts.map(([x, z]) => ["floor screw", x, z]), ...mountHoles.map((h) => ["motor mount screw", h.cx, h.cy])];
  const underB = (x, z) => TR.shafts.some((sh) => { if (sh === TR.shafts[MOTOR_I]) return false; const [w, u] = bpLocal(sh, x, z); return Math.abs(w) <= BP.w + 3 && u >= BP.uMin - 3 && u <= BP.uMax + 3; });   // plate B has no bearing plate on the motor shaft
  for (const [what, x, z] of others) if ((what === "motor mount screw" ? underB(x, z) : underBP(x, z, 3))) console.log(`CONFLICT ${what} at ${x.toFixed(1)}, ${z.toFixed(1)} is under a bearing plate`);
  const all = [...keptBP_B.map((h) => ["bearing plate", h]), ...others.map(([w, x, z]) => [w, { cx: x, cy: z, r: 2.2 }])];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) { const [a, h] = all[i], [b, g] = all[j], dd = Math.hypot(h.cx - g.cx, h.cy - g.cy);
    if (dd > 0.05 && dd < h.r + g.r + 2) console.log(`CONFLICT ${a} hole ${h.cx.toFixed(1)},${h.cy.toFixed(1)} vs ${b} hole ${g.cx.toFixed(1)},${g.cy.toFixed(1)}: ${(dd - h.r - g.r).toFixed(1)} mm web`); } }
const plateB = exactPlate("Transfer side plate B (3 mm, new profile)", [...plateHoles, ...mountHoles, ...bracketHoles, ...keptBP_B], [tab, rearBoss, motorBoss], Y_IN[0], false);
const plateA = exactPlate("Transfer side plate A (3 mm, new profile)", [...plateHoles, ...bracketHoles, ...keptBP_A], [tab, rearBoss], Y_IN[1], true);
count("Transfer side plate, 3 mm aluminium or polycarbonate (new profile)", 2);
{ const s1 = TR.shafts[0], hull = (pts) => { const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = []; for (const p of P) { while (lo.length > 1 && cr(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
    for (const p of [...P].reverse()) { while (up.length > 1 && cr(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); } return [...lo.slice(0, -1), ...up.slice(0, -1)]; };
  for (const [side, y, flip, dir] of [["B", Y_OUT[0], false, -1], ["A", Y_OUT[1], true, 1]]) {
    const kept = side === "B" ? keptBP_B : keptBP_A;
    const bolts = kept.filter((h) => Math.hypot(h.cx - s1[0], h.cy - s1[1]) < 21 && Math.hypot(h.cx - HANGER.shaft[0], h.cy - HANGER.shaft[1]) > 19.05 + 3.8 + 1).map((h) => [h.cx, h.cy]);   // heads clear of the intake wheels
    console.log(`intake shaft support ${side}: ${bolts.length} inserts on shaft 1's bearing-plate holes`);
    // outline = the convex hull of circles (r10 round the shaft, r6.5 round each insert): the straight outer tangents between them
    // plus the circles themselves, so every rounded end is a true arc
    const discs = [[...HANGER.shaft, 10], ...bolts.map(([x, z]) => [x, z, 6.5])], H = hull(discs.map(([x, z]) => [x, z])), rOf = (p) => discs.find((d) => d[0] === p[0] && d[1] === p[1])[2];
    const tang = H.flatMap((c1, k) => { const c2 = H[(k + 1) % H.length], r1 = rOf(c1), r2_ = rOf(c2), d = [c2[0] - c1[0], c2[1] - c1[1]], L = Math.hypot(...d), u = [d[0] / L, d[1] / L];
      const a = (r1 - r2_) / L, b = Math.sqrt(1 - a * a), nrm = [a * u[0] + b * u[1], a * u[1] - b * u[0]];
      return [[c1[0] + r1 * nrm[0], c1[1] + r1 * nrm[1]], [c2[0] + r2_ * nrm[0], c2[1] + r2_ * nrm[1]]]; });
    const h = extrudeSketch(`Intake shaft support ${side} (3D-printed PETG, on the transfer plate)`, [add([...tang, tang[0]]), ...discs.map(([x, z, r]) => circ(x, z, 2 * r, "add")), circ(...HANGER.shaft, 8.5), circ(s1[0], s1[1], 18)], y, HANGER.T, flip);
    // the bearing plate's screws come through the transfer plate and the arm; nuts sit in hex pockets in the arm's outer face
    for (const [bx, bz] of bolts) nutJoint(`Intake shaft support ${side}`, h, bx, bz, y, dir, HANGER.T, HANGER.T - NUT.t, null, y - dir * (3 + 5));
    count("3D-printed intake shaft support (PETG, Ø8.5 bushing for the 7 mm hex shaft)");
  } }
// shafts, bearings, wheels
// belt pair: the rear push shaft + the driven shaft, both extended out of side A so a belt can join them
// The partner is the motor-driven shaft, so the belt powers the rear wheel. Its belt runs under cross channel #8 (bottom z 48) and
// the shooter plate (z 59.8) and outboard of the 90° mount (y 235.4): checked clear with Ø24 pulleys (16T HTD5) at y 238-252.
const BELT = (() => { const ri = TR.shafts.findIndex((sh) => sh.rear), r = TR.shafts[ri];
  const ni = MOTOR_I;
  console.log(`belt pair: transfer shafts ${ri + 1} (rear) and ${ni + 1}, ${Math.hypot(TR.shafts[ni][0] - r[0], TR.shafts[ni][1] - r[1]).toFixed(1)} mm apart`);
  return new Set([ri, ni]); })();
for (const [i, sh] of TR.shafts.entries()) {
  const [x, z] = sh;
  const label = `Transfer shaft ${i + 1}`;
  if (i === MOTOR_I) {   // driven shaft: 112 mm, e-clip on the A side, long end into the transfer motor's coupler on the B side
    if (BELT.has(i)) {   // also the belt's driving shaft: 168 mm, same B end in the coupler, 56 mm more out of side A for the pulley
      imp(`${label} (goBILDA 2106-4008-1680, driven, belt pair: extended on side A)`, "imports/gobilda-2106-4008-1680-rex-shaft-168mm.step", [-43.35, 23.42, 6.97], [0, 0, 180], [x, Y_OUT[1] + BEARING_FLANGE + CLIP_FROM_END + 56, z]); count("goBILDA 2106-4008-1680 8 mm REX shaft 168 mm with e-clip (belt pair)");
    } else { imp(`${label} (goBILDA 2106-4008-1120, driven)`, "imports/gobilda-2106-4008-1120-rex-shaft-112mm.step", [-43.35, 23.42, 6.97], [0, 0, 180], [x, Y_OUT[1] + BEARING_FLANGE + CLIP_FROM_END, z]); count("goBILDA 2106-4008-1120 8 mm REX shaft 112 mm with e-clip"); }
    // same motor as the intake (bodies 14-18), copied onto this shaft with its face 40 mm off plate B (room for the 4007 coupler)
    const EXT = 11, INTAKE_AXIS = [-157.6 + PLATE_A_FIX[0], 77.3 + PLATE_A_FIX[2] - MOTOR_DROP], MOUNT_BACK = 355.1;
    const dM = [x - INTAKE_AXIS[0], Y_OUT[0] - EXT - MOUNT_BACK, z - INTAKE_AXIS[1]];
    for (const src of [14, 15, 16, 17, 18]) { feats.push({ id: id("t"), type: "transform", name: `Transfer motor (copy of intake motor part #${src})`, body: src, translate: dM.map(r2), copy: true }); n++; }
    count("goBILDA 5203 Yellow Jacket motor (transfer, same as the intake's)");
    // the minimal mount: printed plate on the motor face + 3 standoffs to transfer plate B (outline: hull of a disc round the motor
    // face screws and the standoff bosses, true arcs)
    { const discs = [[x, z, 19], ...STANDOFFS.map(([dx, dz]) => [x + dx, z + dz, 6])];
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const P = discs.map(([px, pz]) => [px, pz]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), lo = [], up = [];
      for (const p of P) { while (lo.length > 1 && cr(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
      for (const p of [...P].reverse()) { while (up.length > 1 && cr(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); }
      const H = [...lo.slice(0, -1), ...up.slice(0, -1)], rOf = (p) => discs.find((d) => d[0] === p[0] && d[1] === p[1])[2];
      const tang = H.flatMap((c1, k) => { const c2 = H[(k + 1) % H.length], ra = rOf(c1), rb = rOf(c2), d = [c2[0] - c1[0], c2[1] - c1[1]], L = Math.hypot(...d), u = [d[0] / L, d[1] / L];
        const aa = (ra - rb) / L, bb = Math.sqrt(1 - aa * aa), nrm = [aa * u[0] + bb * u[1], aa * u[1] - bb * u[0]];
        return [[c1[0] + ra * nrm[0], c1[1] + ra * nrm[1]], [c2[0] + rb * nrm[0], c2[1] + rb * nrm[1]]]; });
      const mp = extrudeSketch("Transfer motor plate (3D-printed PETG, minimal mount)", [add([...tang, tang[0]]), ...discs.map(([px, pz, r]) => circ(px, pz, 2 * r, "add")),
        circ(x, z, 15), ...[[8, 8], [-8, 8], [8, -8], [-8, -8]].map(([dx, dz]) => circ(x + dx, z + dz, 3.4)), ...STANDOFFS.map(([dx, dz]) => circ(x + dx, z + dz, 4.3))], MS.motorFace, MS.plateT, true);
      TR.motorMount = mp;
      count("3D-printed transfer motor plate (PETG, 8 mm)"); count("M3 screw, motor face to motor plate", 4);
      for (const [dx, dz] of STANDOFFS) {
        imp("Transfer motor standoff (goBILDA 1501-0006-0320, M4 x 32 mm)", MS.file, [0, -16, 0], undefined, [x + dx, MS.motorFace + MS.plateT, z + dz]);
        count("goBILDA 1501-0006-0320 M4 standoff, 32 mm"); count("M4 screw into a standoff", 2);
        SCREWS.push({ name: "Motor standoff, plate B end", x: r2(x + dx), z: r2(z + dz), face: Y_IN[0], dir: -1, nutAt: Y_OUT[0], captive: true });
        SCREWS.push({ name: "Motor standoff, motor plate end", x: r2(x + dx), z: r2(z + dz), face: MS.motorFace, dir: 1, nutAt: MS.motorFace + MS.plateT, captive: true }); } }
    imp("Transfer motor coupler (goBILDA 4007-4008-4008 hyper coupler)", "imports/gobilda-4007-4008-4008-hyper-coupler.step", [-16.4, 4.6, 12.65], undefined, [x, Y_OUT[0] - BEARING_FLANGE - 0.5 - 5.4, z]); count("goBILDA 4007-4008-4008 hyper coupler (8 mm REX to 8 mm REX)");
    TR.motorShaft = [x, z];
  } else if (BELT.has(i)) {   // belt pair: same B end as before, 168 mm so the pulleys sit outboard of the 90° mount to cross channel #8 (ends y 235.4)
    const yB = sh.face === "outer" ? Y_OUT[0] - 5 - BEARING_FLANGE - CLIP_FROM_END : Y_OUT[0] - BEARING_FLANGE - CLIP_FROM_END;
    imp(`${label} (goBILDA 2106-4008-1680, belt pair: extended on side A)`, "imports/gobilda-2106-4008-1680-rex-shaft-168mm.step", [-43.35, 23.42, 6.97], undefined, [x, yB, z]); count("goBILDA 2106-4008-1680 8 mm REX shaft 168 mm with e-clip (belt pair)");
  } else if (sh.face === "outer") {   // bearing plates on the outside: bearings sit in their pockets, so the shaft is 112 mm
    imp(`${label} (goBILDA 2106-4008-1120)`, "imports/gobilda-2106-4008-1120-rex-shaft-112mm.step", [-43.35, 23.42, 6.97], undefined, [x, Y_OUT[0] - 5 - BEARING_FLANGE - CLIP_FROM_END, z]); count("goBILDA 2106-4008-1120 8 mm REX shaft 112 mm with e-clip");
  } else { imp(`${label} (goBILDA ${SHAFT104.sku})`, SHAFT104.file, SHAFT104.anchor, undefined, [x, Y_OUT[0] - BEARING_FLANGE - CLIP_FROM_END, z]); count(`goBILDA ${SHAFT104.sku} 8 mm REX shaft 104 mm with e-clip`); }
  const outer = sh.face === "outer";
  imp(`${label} bearing B (goBILDA 1611)`, F.bearing, [0, BEARING_BODY, 0], [0, 0, 180], [x, outer ? Y_OUT[0] - 5 : Y_OUT[0], z]);
  imp(`${label} bearing A (goBILDA 1611)`, F.bearing, [0, BEARING_BODY, 0], undefined, [x, outer ? Y_OUT[1] + 5 : Y_OUT[1], z]); count("goBILDA 1611-0514-4008 flanged bearing", 2);
  // the two bearing plates (copies of the intake's): outside faces y 102.6 / 195.4, or inside faces y 105.6 / 192.4
  const th = (Math.atan2(sh.bpDir[0], sh.bpDir[1]) * 180) / Math.PI;
  for (const [side, faceY, thick] of outer ? [["B", Y_OUT[0], -1], ["A", Y_OUT[1], 1]] : [["B", Y_IN[0], 1], ["A", Y_IN[1], -1]]) {
    if (i === MOTOR_I && side === "B") continue;   // the motor mount sits over this bearing: no bearing plate here (1611 in the plate's Ø14 hole)
    feats.push({ id: id("t"), type: "transform", name: `${label} bearing plate ${side} (same part as the intake's)`, body: BP.src, rotate: thick < 0 ? 180 : 0, axis: [0, 0, 1], origin: BP.bore, copy: true });
    const bi = n++; (TR.bp ??= {})[`${i}${side}`] = bi;
    feats.push({ id: id("t"), type: "transform", name: `Place ${label.toLowerCase()} bearing plate ${side}`, body: bi, rotate: r2(th), axis: [0, 1, 0], origin: BP.bore, translate: [r2(x - BP.bore[0]), r2(faceY - BP.bore[1]), r2(z - BP.bore[2])], copy: false });
    count("bearing plate, same part as the intake's (24 x 40 x 5 mm, 14 mm pocket)");
  }
  for (const y of sh.rows) {
    if (sh.size === 25) { imp(`${label} gecko wheel (Swyft 2.5in)`, WHEEL25, [0, 0, WHEEL_W / 2], [-90, 0, 0], [x, y, z]); count("Swyft SR-INTAKEWHEEL-25-7mm 2.5 in wheel"); }
    else { imp(`${label} gecko wheel (Swyft 1.5in)`, F.wheel, [0, 0, WHEEL_W / 2], [-90, 0, 0], [x, y, z]); count("Swyft SR-INTAKEWHEEL-15-7mm 1.5 in wheel"); }
  }
}
// bearing-plate screws whose nut lands inside the transfer, against a floor piece: captive nut pocket in that floor piece
for (const sc of SCREWS) { if (!/^Bearing plate screw/.test(sc.name) || sc.captive) continue;
  const inside = Math.abs(sc.nutAt - Y_IN[0]) < 0.01 || Math.abs(sc.nutAt - Y_IN[1]) < 0.01; if (!inside) continue;
  const k = FLOOR_SPLITS.findIndex((x0, j) => j < 3 && sc.x >= x0 && sc.x < FLOOR_SPLITS[j + 1]); if (k < 0) continue;
  const wallZone = sc.x > TR.XW - 1 && sc.z > TR.C[1] - 25;   // the vertical wall of piece 3 (and the top of its curve)
  if (!wallZone) continue;
  nutPocket(`Transfer floor piece ${k + 1}`, floorBodies[k], sc.x, sc.z, sc.nutAt, sc.dir, 0); sc.captive = true; }
// mounts: up to cross channel #8 and back to rear channel #22, both sides
// the L-brackets (3D-printed PETG, 5 mm legs, one gusset): plate leg on the transfer plate's outer face, channel leg on the channel
{ const CH_SCREWS = { 8: { B: [[79, 83], [95, 75]], A: [[79, 219], [95, 227]] }, 22: { B: [74.39, 90.39], A: [210.39, 226.39] } };
  for (const [side, yo, out] of [["B", Y_OUT[0], -1], ["A", Y_OUT[1], 1]]) {
    const yr = (a, b) => (out < 0 ? [yo - b, yo - a] : [yo + a, yo + b]);
    for (const br of BRACKETS) {
      const L = br.plateLeg, nm = `Bracket ${side}, transfer plate to ${br.ch === 8 ? "cross channel #8" : "rear channel #22"} (3D-printed PETG)`;
      let leg;
      if (br.ch === 8) {
        leg = box(nm, L.x[0], L.x[1], ...yr(0, 5), L.z[0], L.z[1]);
        cutWith(`${nm}: channel leg`, leg, box("leg", L.x[0], L.x[1], ...yr(0, 40), 43, 48), "union");
        const sid = id("s"), g = [[yo + out * 4.5, 43.5], [yo + out * 30, 43.5], [yo + out * 4.5, 18]];
        feats.push({ id: sid, type: "sketch", name: `${nm} gusset profile`, plane: { origin: [85, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }, entities: [{ type: "polyline", points: g.map(([y, z]) => [r2(y), r2(z)]) }] });
        feats.push({ id: id("e"), type: "extrude", name: `${nm} gusset`, sketch: sid, distance: 4, mode: "new" }); n++; cutWith(`${nm}: gusset`, leg, n - 1, "union");
        for (const [x, y] of CH_SCREWS[8][side]) {   // down through the channel's web holes and the channel leg, nut underneath
          cutWith(`${nm}: M4 hole under the channel's web hole`, leg, cyl("M4 (cutter)", [x, y, 42], [0, 0, 1], NUT.hole, 7));
          SCREWS.push({ name: `${nm.split(" (")[0]}, channel screw`, axis: "z", x, y, face: 50, dir: -1, nutAt: 43, captive: false }); count("M4 screw + nut"); }
      } else {
        leg = box(nm, L.x[0], 147, ...yr(0, 5), L.z[0], L.z[1]);
        cutWith(`${nm}: channel leg`, leg, box("leg", 147, 152, ...yr(0, 40), L.z[0], L.z[1]), "union");
        const sid = id("s"), g = [[146.5, yo + out * 4.5], [122, yo + out * 4.5], [146.5, yo + out * 29]];
        feats.push({ id: sid, type: "sketch", name: `${nm} gusset profile`, plane: { origin: [0, 0, L.z[0]], normal: [0, 0, 1], xDir: [1, 0, 0] }, entities: [{ type: "polyline", points: g.map(([x, y]) => [r2(x), r2(y)]) }] });
        feats.push({ id: id("e"), type: "extrude", name: `${nm} gusset`, sketch: sid, distance: 4, mode: "new" }); n++; cutWith(`${nm}: gusset`, leg, n - 1, "union");
        for (const y of CH_SCREWS[22][side]) {      // through the channel's front-flange holes and the channel leg, nut in front of it
          cutWith(`${nm}: M4 hole behind the channel's flange hole`, leg, cyl("M4 (cutter)", [146, y, -40], [1, 0, 0], NUT.hole, 7));
          SCREWS.push({ name: `${nm.split(" (")[0]}, channel screw`, axis: "x", y, z: -40, face: 154, dir: -1, nutAt: 147, captive: false }); count("M4 screw + nut"); }
      }
      for (const [x, z] of br.plateScrews) {         // through the transfer plate and the plate leg, head inside the transfer, nut outside
        cutWith(`${nm}: M4 hole`, leg, cyl("M4 (cutter)", [x, out < 0 ? yo - 6 : yo - 1, z], [0, 1, 0], NUT.hole, 7));
        SCREWS.push({ name: `${nm.split(" (")[0]}, plate screw`, x, z, face: yo - out * 3, dir: out, nutAt: yo + out * 5, captive: false }); count("M4 screw + nut"); }
      count("3D-printed L-bracket (PETG)");
    } } }
fs.writeFileSync(file.replace(/parts\/[^/]+$/, "transfer-geometry.json"), JSON.stringify({ lip: TR.LIP, th: 15, rho: TR.RHO, centre: TR.C.map(r2), xw: TR.XW, wallTop: TR.WALL_TOP, mouthX: TR.PLATE_FRONT, shafts: TR.shafts.map((p) => p.map(r2)) }, null, 1));

// 4) funnel, 3D-printed (PETG): per side one solid block between the side plate and the transfer plate (below); M4 screws through both
//    metal plates into it, captive nuts in slots from its underside
// funnel walls end at the floor lip (x -144); the transfer plates reach further forward only above them
const MOUTH_X = -144, T = 4, WALL_Z = [-140, -90], DECK_Z = [-90, -82], BALL_Z = -107.5, DECK_W = 80;
const FUNNEL = [
  { side: "B", F: [-182, -44], M: [MOUTH_X, 105.6], plate: 622, sidePlate: 7, sideY: -53.8, plateY: Y_OUT[0], out: -1, pods: [-127, -40, -60, 37] },
  { side: "A", F: [-182, 345.6], M: [MOUTH_X, 192.4], plate: 25, sidePlate: 0, sideY: 355.2, plateY: Y_OUT[1], out: 1, pods: [-152, -40, 264, 360] },
];
// one solid block per side (print top face down, 3 walls + 15% gyroid): plan-view outline extruded from z -136 to -94 (42 mm tall).
// Ball face: a straight line from the front corner to the transfer plate's front edge. Back: flat on the side plate's inner face
// (front part) and on the transfer plate's outer face (rear part); stepped around the drive pod with 4-6 mm clearance.
// M4 screws through the two metal plates into the block, captive nuts in slots from the block's underside.
const FZ = [-136, -94];
// the inside corner where the block steps around the drive pod is filled with an exact R25 curve (no sharp notch to crack from):
// the outline takes in the R x R square in that corner, then a true circle of radius R centred on the square's far corner is cut out
// corner c, the empty quadrant lies toward (sx, sy)
const FILLET_R = 25;
const arcFill = ([cx, cy], sx, sy, R = FILLET_R) => ({ pts: [[cx + sx * R, cy], [cx + sx * R, cy + sy * R], [cx, cy + sy * R]], cut: { type: "circle", cx: r2(cx + sx * R), cy: r2(cy + sy * R), r: R, op: "subtract" } });
for (const fn of FUNNEL) {
  const B = fn.out < 0, sy = fn.sideY, py = fn.plateY;
  let fillet = null;
  const outline = B
    ? [[-182, sy], [-182, -44], [MOUTH_X, py], [-96, py], [-96, 40], ...(fillet = arcFill([-156, 40], 1, -1)).pts, [-156, sy]]
    : [[-182, sy], [-182, 345.6], [MOUTH_X, py], [-96, py], [-96, 262], ...(fillet = arcFill([-155, 262], 1, 1)).pts, [-155, sy]];
  const sid = id("s");
  feats.push({ id: sid, type: "sketch", name: `Funnel ${fn.side} outline`, plane: { origin: [0, 0, FZ[0]], normal: [0, 0, 1], xDir: [1, 0, 0] }, entities: [{ type: "polyline", points: [...outline, outline[0]].map((q) => q.map(r2)) }, fillet.cut] });
  feats.push({ id: id("e"), type: "extrude", name: `Funnel side ${fn.side} (3D-printed PETG, one solid)`, sketch: sid, distance: FZ[1] - FZ[0], mode: "new" });
  const piece = n++; fn.piece = piece;
  // screws through the metal plate into the block, nuts dropped into slots from the block's underside (depth 8 mm from the face)
  for (const [hx, hz] of FUNNEL_FRONT_TAB.holes)   // from the side plate
    nutJoint(`Funnel side ${fn.side}, side-plate screw`, piece, hx, hz, sy, B ? 1 : -1, 14, 8, { dir: [0, -1], len: hz - FZ[0] + 1 });
  for (const [hx, hz] of FUNNEL_REAR_TAB.holes)    // from the transfer plate
    nutJoint(`Funnel side ${fn.side}, transfer-plate screw`, piece, hx, hz, py, B ? -1 : 1, 14, 8, { dir: [0, -1], len: hz - FZ[0] + 1 });
  for (const [hx, hz] of FUNNEL_FRONT_TAB.holes) hole(`New M4 hole in side plate ${fn.side} for the funnel`, fn.sidePlate, hx, B ? -57.8 : 354.2, hz, 4.3, 5);
  // flush on the side plate even where its imported face is not perfectly flat
  feats.push({ id: id("t"), type: "transform", name: `Copy of side plate ${fn.side} (cutter)`, body: fn.sidePlate, copy: true });
  cutWith(`Funnel side ${fn.side}: sit flush on the side plate`, piece, n++);
}
// 5) the shooter (imports/static-pollen-shooter-v1.step, the team's Onshape design, 53 parts): its ball inlet (file x 129.2, y -70.8)
//    over the shooter mount plate's Ø84 exit hole, its base (file z -45.2) on the plate's top face (z 65.8); turned so the hood is on the
//    robot's rear side, where the transfer's vertical wall already guides the ball, and the flywheel toward the front
// The inlet sits on the ball's path: centred across the transfer (y 149.0) and with its rear edge flush with the transfer's vertical
// wall (x 125 - 37.5). The plate's Ø84 exit hole becomes the Ø75 bore of the team's ring sketch, on that same centre, and gets
// Ø4.3 holes under the shooter's four bottom insert holes (M4 screws up through the plate into the shooter).
const SHOOTER = { file: "imports/static-pollen-shooter-v1.step", inlet: [129.2, -70.8, -45.2], at: [TR.XW - 37.5, YC, 66.1], turn: -90,
  holes: [[19.67, 38.04], [-28.6, 38.04], [-28.6, -37.96], [19.67, -37.96]], bore: 75 };   // bottom holes, robot x/y from the inlet (measured)
const shooterFirst = n;
imp("Static Pollen Shooter v1", SHOOTER.file, SHOOTER.inlet, [0, 0, SHOOTER.turn], SHOOTER.at);
count("Static Pollen Shooter v1 (the team's shooter assembly)");
{ const z0 = 60.1, z1 = 66.1;
  cutWith("Shooter mount plate: fill the old Ø84 exit hole", 4, cyl("Fill", [87.1, 150.6, z0], [0, 0, 1], 84.2, z1 - z0), "union");
  cutWith(`Shooter mount plate: Ø${SHOOTER.bore} ball bore under the shooter inlet`, 4, cyl("Bore (cutter)", [SHOOTER.at[0], SHOOTER.at[1], z0 - 1], [0, 0, 1], SHOOTER.bore, z1 - z0 + 2));
  for (const [dx, dy] of SHOOTER.holes) {
    cutWith("Shooter mount plate: M4 clearance hole for the shooter's bottom screws", 4, cyl("M4 (cutter)", [SHOOTER.at[0] + dx, SHOOTER.at[1] + dy, z0 - 1], [0, 0, 1], 4.3, z1 - z0 + 2));
    count("M4 screw, shooter to shooter mount plate");
    SCREWS.push({ name: "Shooter screw (into the shooter's insert)", axis: "z", x: r2(SHOOTER.at[0] + dx), y: r2(SHOOTER.at[1] + dy), face: z0, dir: 1, nutAt: z1 + 6, captive: true });
  } }
// 7) front bumper: a 17-hole Swyft 48 mm U-channel (imports/SR-CHANNEL-L48-17.step, 424 mm) standing across the front above the
//    intake, web forward (x -215), open toward the robot. Both side plates reach forward into the U (between its flanges, to the web);
//    a printed block on the inside of each plate ties them together: 2 M4 through the side plate and 2 M4 through the channel's own
//    Ø4 web holes, all with captive nuts (slots from the block's underside / inner face)
{ const BUMP = { front: -215, zc: -6, yc: (-56.8 + 358.2) / 2, web: 2, depth: 12, half: 24 };
  imp("Front bumper (Swyft 17-hole 48 mm U-channel, SR-CHANNEL-L48-17)", "imports/SR-CHANNEL-L48-17.step", [0, 216, 0], [180, -90, 0], [BUMP.front, BUMP.yc, BUMP.zc]);
  count("Swyft SR-CHANNEL-L48-17 U-channel, 17 holes (front bumper)");
  const xIn = BUMP.front + BUMP.web, ext = { x: [xIn, -197], z: [BUMP.zc - BUMP.half + 2 + 2, BUMP.zc + BUMP.half - 2 - 2] };
  for (const [pl, side, yP, inDir] of [[7, "B", [-56.8, -53.8], 1], [0, "A", [355.2, 358.2], -1]]) {
    cutWith(`Side plate ${side}: forward extension into the bumper channel`, pl, box("Side plate extension", ext.x[0], ext.x[1], yP[0], yP[1], ext.z[0], ext.z[1]), "union");
    const face = inDir > 0 ? yP[1] : yP[0], blockY = inDir > 0 ? [face, face + 33] : [face - 33, face];
    const blk = box(`Bumper bracket ${side} (3D-printed PETG)`, xIn, -199, blockY[0], blockY[1], ext.z[0], ext.z[1]);
    count("3D-printed bumper bracket (PETG)");
    for (const bz of [-16, 4]) {   // through the side plate (y), nut slot down to the block's underside
      hole(`M4 hole in side plate ${side} for the bumper bracket`, pl, -206, inDir > 0 ? yP[0] - 1 : yP[1] + 1 - 5, bz, 4.3, 5);
      nutJoint(`Bumper bracket ${side}, side-plate screw`, blk, -206, bz, face, inDir, 14, 8, { dir: [0, -1], len: bz - ext.z[0] + 1 });
    }
    const yWeb = r2(BUMP.yc - (inDir > 0 ? 400 : 32) + 216);   // the channel's Ø4 web holes at local y 400 / 32 (20.5 mm in from each plate)
    for (const lz of [-8, 8]) {     // through the channel web (x), nut pocket 6 mm in with a slot out of the block's inner face
      const bz = BUMP.zc + lz;
      cutWith(`Bumper bracket ${side}, web screw: M4 clearance hole`, blk, cyl("M4 (cutter)", [xIn - 0.1, yWeb, bz], [1, 0, 0], NUT.hole, 14.2));
      const sid = id("s"), xp = xIn + 6, sl = inDir * 1;
      feats.push({ id: sid, type: "sketch", name: "Bumper web nut pocket profile", plane: { origin: [r2(xp), 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
        entities: [{ type: "polygon", cx: yWeb, cy: bz, r: r2(NUT.af / Math.sqrt(3) + 0.05), sides: 6, angle: 0 }, { type: "rect", cx: r2(yWeb + sl * 10), cy: bz, w: 20, h: NUT.af, angle: 0 }] });
      feats.push({ id: id("e"), type: "extrude", name: "Bumper web nut pocket (cutter)", sketch: sid, distance: NUT.t + 0.1, mode: "new" }); n++;
      cutWith(`Bumper bracket ${side}, web screw: captive M4 nut pocket + slot`, blk, n - 1);
      SCREWS.push({ name: `Bumper bracket ${side}, web screw`, axis: "x", y: yWeb, z: bz, face: BUMP.front, dir: 1, nutAt: r2(xp + NUT.t), captive: true });
      count("M4 screw + nut");
    }
  } }
// 6) intake: gecko wheels straight onto the original full-width 7 mm hex shaft (Swyft 7 mm hex bore), 13 rows, 30.5 mm apart
for (let j = -6; j <= 6; j++) { imp(`Intake gecko wheel ${j + 7} (Swyft 1.5in)`, F.wheel, [0, 0, WHEEL_W / 2], [-90, 0, 0], [INTAKE_SHAFT.x, r2(YC + j * 30.5), INTAKE_SHAFT.z]); count("Swyft SR-INTAKEWHEEL-15-7mm 1.5 in wheel"); }

// side plate triangle (truss) cutouts, planned by scripts/measure-sideplate-cutouts.mjs (8 mm webs, clear of everything bolted on)
const SIDE_POCKETS = false;   // side plates stay solid (no cutouts)
{ const url = new URL("./sideplate-cutouts.json", import.meta.url);
  if (SIDE_POCKETS && fs.existsSync(url)) for (const [pl, { faces, tris }] of Object.entries(JSON.parse(fs.readFileSync(url, "utf8")))) {
    if (!tris.length) continue;
    const cutter = extrudeSketch(`Side plate ${pl === "7" ? "B" : "A"} triangle cutouts (cutter)`, tris.map((T) => add(T)), faces[1] + 0.5, faces[1] - faces[0] + 1);
    cutWith(`Side plate ${pl === "7" ? "B" : "A"} triangle cutouts (weight reduction)`, Number(pl), cutter);
  } }
feats.push({ id: id("d"), type: "deleteBody", name: "Remove the original transfer (plates + curved sheet) and side B's back-facing pod parts (replaced by their mirrors)", body: [SHEET, ...TRANSFER_PLATES, ...POD_B_FLIP.flatMap((fl) => fl.body)] });
// proof of fit: every joint gets a modelled M4 socket-head screw (Ø7 x 4 head, Ø3.8 shank) and, where it has one, a hex nut (7 mm
// across flats, 3.2 mm); remove this block when the build no longer needs them in the model
const SHOW_HARDWARE = true;
if (SHOW_HARDWARE) for (const sc of SCREWS) {
  const ax = sc.axis ?? "y", k = "xyz".indexOf(ax), at = (t) => { const p = [sc.x ?? 0, sc.y ?? 0, sc.z ?? 0]; p[k] = t; return p; }, dv = [0, 0, 0]; dv[k] = sc.dir;
  const tip = sc.nutAt + sc.dir * (sc.captive ? 1 : 3.2 + 1);
  const scr = cyl(`M4 screw (proof of fit): ${sc.name}`, at(sc.face), dv, 3.8, Math.abs(tip - sc.face));
  cutWith("M4 screw head", scr, cyl("Head", at(sc.face - sc.dir * 4), dv, 7, 4), "union");
  count("M4 socket-head screw (modelled)");
  if (/standoff|shooter screw|motor face/i.test(sc.name)) continue;   // threads into a standoff / the shooter's insert: no nut
  const n0 = sc.captive ? sc.nutAt - sc.dir * 3.35 : sc.nutAt, n1 = n0 + sc.dir * 3.2, lo = Math.min(n0, n1);
  const normal = [0, 0, 0]; normal[k] = 1; const xDir = ax === "x" ? [0, 1, 0] : [1, 0, 0];
  const cu = ax === "x" ? sc.y : sc.x, cv = ax === "y" ? -sc.z : ax === "x" ? sc.z : sc.y;   // sketch y = normal x xDir
  const sid = id("s");
  const org = [0, 0, 0]; org[k] = r2(lo);   // the plane passes through the axis line's level only; the hexagon carries the position
  feats.push({ id: sid, type: "sketch", name: "M4 nut profile", plane: { origin: org, normal, xDir }, entities: [{ type: "polygon", cx: r2(cu), cy: r2(cv), r: r2(7 / Math.sqrt(3)), sides: 6, angle: 0 }] });
  feats.push({ id: id("e"), type: "extrude", name: `M4 nut (proof of fit): ${sc.name}`, sketch: sid, distance: 3.2, mode: "new" }); n++;
  { const c0 = [sc.x ?? 0, sc.y ?? 0, sc.z ?? 0]; c0[k] = lo - 0.5; cutWith("M4 nut thread hole", n - 1, cyl("Thread (cutter)", c0, normal, 4, 4.2)); }
  count("M4 hex nut (modelled)");
}
fs.writeFileSync(new URL("./screws.json", import.meta.url), JSON.stringify(SCREWS, null, 1));
console.log(`screws: ${SCREWS.length} (M4 + nut each)`);
part.features.push(...feats);
const lines = [`{`, `  "name": ${JSON.stringify(part.name)},`];
for (const k2 of Object.keys(part)) if (!["name", "features"].includes(k2)) lines.push(`  ${JSON.stringify(k2)}: ${JSON.stringify(part[k2])},`);
lines.push(`  "features": [`, part.features.map((f) => `    ${JSON.stringify(f)}`).join(",\n"), `  ]`, `}`, ``);
fs.writeFileSync(file, lines.join("\n"));
const rows = [...bom].map(([name, qty]) => `| ${qty} | ${name} |`).join("\n");
if (/\/parts\/[^/]+$/.test(file)) fs.writeFileSync(file.replace(/parts\/[^/]+$/, "TRANSFER-BOM.md"), `# Transfer / intake: vendor parts\n\nGenerated by scripts/add-transfer-hardware.mjs. All CAD is the vendor's own STEP file; the robot's own parts are not cut or reshaped.\n\n| Qty | Part |\n|---:|---|\n${rows}\n\nNot modelled yet: wheel spacers / shaft collars, the drive for the transfer shafts, the funnel, the blocker servo.\n`);
console.log(`wrote ${file}: +${feats.length} features`);
