// Pollen check for ~/cadSlop/test: rolls a ball (71 and 73 mm, the FTC pollen range) through the whole system and reports
//   - BLOCKED: any part the ball would pass through (wheels don't count: they're meant to squeeze it)
//   - squeeze: how far each wheel presses into the ball (mm), worst case per wheel
//   - no drive: stretches inside the transfer where no wheel touches the ball (it would stall there)
// Paths: down the middle and hugging each funnel wall to the transfer mouth, then the transfer: ramp -> floor -> curve -> wall ->
// up through the shooter plate's exit hole. Usage: node scripts/check-ball.mjs
import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const part0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const GONE = new Set(part0.features.filter((f) => f.type === "deleteBody").flatMap((f) => [].concat(f.body)));
const part = { ...part0, features: part0.features.filter((f) => f.type !== "deleteBody") };
const files = {};
for (const f of part.features) {
  if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file));
  if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part));
}
const built = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const name = (i) => { const f = part.features.find((g) => g.id === built.owners[i]); return f && String(f.id).startsWith("tx") ? f.name : `robot #${i}`; };
const names = built.bodies.map((_, i) => name(i));
const B = built.bodies.map((b) => b.boundingBox.bounds);
const isWheel = (nm) => /wheel/i.test(nm);
const isSupport = (nm) => /Transfer floor/.test(nm);          // surfaces the ball rolls on

// geometry of the new transfer, written by add-transfer-hardware.mjs: ground -> 15° floor from the lip -> curve -> vertical wall
const TG = JSON.parse(fs.readFileSync(dir + "transfer-geometry.json", "utf8"));
const GROUND = -143, MOUTH = TG.mouthX, th = (TG.th * Math.PI) / 180;
const FUN = { B: [[-198, -46], [MOUTH, 105.6]], A: [[-198, 347.6], [MOUTH, 192.4]] };
function centreline(R_) {        // [x, z, stage] for the ball centre, front of the robot to above the shooter plate
  const pts = [], E = 0.3, n = [-Math.sin(th), Math.cos(th)];
  const rampC = (t) => [TG.lip[0] + t * Math.cos(th) + n[0] * (R_ + E), TG.lip[1] + t * Math.sin(th) + n[1] * (R_ + E)];
  const t0 = (GROUND + R_ - rampC(0)[1]) / Math.sin(th);            // where the ball, rolling on the ground, meets the floor
  for (let x = -250; x < rampC(Math.max(t0, 0))[0]; x += 6) pts.push([x, GROUND + R_ + E, "intake"]);
  const tEnd = Math.hypot(TG.centre[0] + TG.rho * Math.sin(th) - TG.lip[0], TG.centre[1] - TG.rho * Math.cos(th) - TG.lip[1]);
  for (let t = Math.max(t0, 0); t <= tEnd; t += 6) { const [x, z] = rampC(t); pts.push([x, z, "floor"]); }
  for (let a = -75; a <= 0; a += 5) { const r = TG.rho - R_ - E; pts.push([TG.centre[0] + r * Math.cos((a * Math.PI) / 180), TG.centre[1] + r * Math.sin((a * Math.PI) / 180), "curve"]); }
  for (let z = TG.centre[1] + 6; z <= 66 + R_ + 2; z += 6) pts.push([TG.xw - R_ - E, z, z < TG.wallTop ? "wall" : "shooter hole"]);
  return pts;
}

for (const D of [71, 73]) {
  const R_ = D / 2;
  const main = centreline(R_);
  const lanes = { middle: main.map(([x, z, st]) => [x, 149, z, st]) };
  for (const side of ["B", "A"]) {      // hug the funnel wall until the mouth, then the transfer centreline
    const [F, M] = FUN[side], L = Math.hypot(M[0] - F[0], M[1] - F[1]), u = [(M[0] - F[0]) / L, (M[1] - F[1]) / L];
    const nIn = side === "B" ? [-u[1], u[0]] : [u[1], -u[0]];
    const pts = [];
    for (let s = 20; s <= L - 10; s += 8) { const x = F[0] + s * u[0] + (R_ + 0.5) * nIn[0], y = F[1] + s * u[1] + (R_ + 0.5) * nIn[1];
      const z = main.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) && p[0] < MOUTH ? p : best), main[0])[1];
      pts.push([x, y, z, "funnel"]); }
    lanes[`along funnel wall ${side}`] = pts;
  }
  console.log(`\n== ${D} mm pollen`);
  for (const [lane, pts] of Object.entries(lanes)) {
    const blocked = new Map(), squeeze = new Map(), noDrive = [];
    for (const [x, y, z, stage] of pts) {
      const sph = R.makeSphere(R_).translate(x, y, z), sb = sph.boundingBox.bounds;
      let driven = false;
      built.bodies.forEach((b, j) => {
        if (GONE.has(j) || ![0, 1, 2].every((q) => sb[0][q] < B[j][1][q] && B[j][0][q] < sb[1][q])) return;
        const nm = names[j];
        if (isWheel(nm)) {   // wheel contact by distance: the kernel's intersect can return empty for a ball pressed into gecko fins
          let d = 1; try { d = R.measureDistanceBetween(sph, b); } catch { /* unknown */ }
          if (d < 0.01) { driven = true; squeeze.set(nm, squeeze.get(nm) ?? 0); }
          return;
        }
        let v = 0; try { v = R.measureVolume(sph.clone().intersect(b.clone())); } catch { v = -1; }
        if (v < 0 && isWheel(nm)) { try { if (R.measureDistanceBetween(sph, b) < 0.01) { driven = true; squeeze.set(nm, Math.max(squeeze.get(nm) ?? 0, 0)); } } catch { /* unknown */ } return; }   // some wheel meshes won't intersect: touching = distance 0
        if (v <= 2) return;
        if (isWheel(nm)) { driven = true; const depth = (v / (Math.PI * R_)) ** 0.5 * 0.9; squeeze.set(nm, Math.max(squeeze.get(nm) ?? 0, depth)); return; }
        if (isSupport(nm) && v < 400) return;
        const e = blocked.get(nm); if (!e || v > e.v) blocked.set(nm, { v, at: `${stage} x ${x.toFixed(0)} y ${y.toFixed(0)} z ${z.toFixed(0)}` });
      });
      sph.delete();
      if (["floor", "curve", "wall"].includes(stage) && !driven) noDrive.push(`${stage} x ${x.toFixed(0)} z ${z.toFixed(0)}`);
    }
    console.log(`  ${lane}: ${blocked.size ? `${blocked.size} BLOCKED` : "nothing in the way"}`);
    for (const [nm, e] of blocked) console.log(`     BLOCKED ${Math.round(e.v)} mm3  ${nm}  @ ${e.at}`);
    const sq = [...squeeze.values()];
    if (sq.length) console.log(`     wheels squeezing it: ${sq.length}, deepest ~${Math.max(...sq).toFixed(1)} mm`);
    if (lane === "middle") console.log(noDrive.length ? `     no drive at: ${noDrive.join(" | ")}` : "     driven by a wheel the whole way through the transfer");
  }
}
