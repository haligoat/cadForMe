// Assemblies: a part file with kind "assembly" whose features are instances ("insert" features placed with
// position + orient) and mates. Mates are solved here, before the geometry kernel runs, by moving instances.
import * as THREE from "three";

export const isAssembly = (part) => part?.kind === "assembly";
export const instances = (part) => (part?.features ?? []).filter((f) => f.type === "insert");
export const mates = (part) => (part?.features ?? []).filter((f) => f.type === "mate");

const D = Math.PI / 180;
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : d);
const vec = (v, d = [0, 0, 0]) => (Array.isArray(v) ? v.map((x, i) => num(x, d[i])) : d);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** Rotation of an instance: orient = [x, y, z] degrees applied about X, then Y, then Z (same as the kernel). */
export function instQuat(f) {
  const [x, y, z] = vec(f.orient);
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x * D, y * D, z * D, "ZYX"));
}
export function instMatrix(f) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...vec(f.position)), instQuat(f), new THREE.Vector3(1, 1, 1));
}
export function placement(position, quat) {
  const e = new THREE.Euler().setFromQuaternion(quat, "ZYX");
  return { position: position.toArray().map(r4), orient: [e.x / D, e.y / D, e.z / D].map(r4) };
}

/** A picked face (world point + normal) expressed in the instance's own coordinates, so it survives moves. */
export function toLocal(f, p, n) {
  const inv = instMatrix(f).invert();
  const lp = new THREE.Vector3(...p).applyMatrix4(inv);
  const ln = new THREE.Vector3(...n).applyQuaternion(instQuat(f).invert()).normalize();
  return { p: lp.toArray().map(r4), n: ln.toArray().map(r4) };
}

/**
 * Fasten mates: put face b of the moving instance flat against face a of the other (normals opposite, points together,
 * plus an optional offset gap). Starts from fixed instances and walks outwards. Mutates `part`; returns problems.
 */
export function solveMates(part) {
  const insts = new Map(instances(part).map((f) => [f.id, f]));
  const ms = mates(part).filter((m) => !m.suppressed && insts.has(m.a?.inst) && insts.has(m.b?.inst));
  const problems = [];
  problems.driven = new Set();
  if (!ms.length) return problems;
  const placed = new Set([...insts.values()].filter((f) => f.fixed).map((f) => f.id));
  if (!placed.size && insts.size) placed.add(insts.keys().next().value); // nothing fixed: the first instance stays put
  const done = new Set();
  for (let pass = 0; pass < ms.length + 1; pass++) {
    let progress = false;
    for (const m of ms) {
      if (done.has(m.id)) continue;
      let anchor = m.a, mover = m.b;
      if (!placed.has(anchor.inst) && placed.has(mover.inst)) [anchor, mover] = [mover, anchor];
      if (!placed.has(anchor.inst)) continue;
      const A = insts.get(anchor.inst), B = insts.get(mover.inst);
      if (placed.has(B.id)) { done.add(m.id); problems.push(`${m.name ?? m.id}: both parts are already placed, so this mate is ignored`); continue; }
      const MA = instMatrix(A), qA = instQuat(A);
      const P = new THREE.Vector3(...anchor.p).applyMatrix4(MA);
      const nA = new THREE.Vector3(...anchor.n).applyQuaternion(qA).normalize();
      const target = nA.clone().negate();
      const qB = instQuat(B);
      const nB = new THREE.Vector3(...mover.n).applyQuaternion(qB).normalize();
      const qNew = new THREE.Quaternion().setFromUnitVectors(nB, target).multiply(qB);
      if (m.angle) qNew.premultiply(new THREE.Quaternion().setFromAxisAngle(target, num(m.angle) * D)); // spin about the mate axis
      const pB = new THREE.Vector3(...mover.p).applyQuaternion(qNew);
      const t = P.clone().sub(pB).addScaledVector(nA, num(m.offset));
      Object.assign(B, placement(t, qNew));
      placed.add(B.id); problems.driven.add(B.id); done.add(m.id); progress = true;
    }
    if (!progress) break;
  }
  for (const m of ms) if (!done.has(m.id)) problems.push(`${m.name ?? m.id}: neither part is fixed or connected to a fixed part`);
  return problems;
}

/** Bill of materials: one row per inserted Part Studio (+ variable overrides), with quantity and mass. */
export function bom(part, build) {
  const rows = new Map();
  const massOf = new Map();
  (build?.owners ?? []).forEach((o, i) => { const m = build.stats?.[i]; if (m) massOf.set(o, (massOf.get(o) ?? 0) + (m.mass ?? 0)); });
  for (const f of instances(part)) {
    if (f.suppressed) continue;
    const key = `${f.part}|${JSON.stringify(f.vars ?? {})}`;
    const r = rows.get(key) ?? { part: f.part, name: String(f.part ?? "").split("/").pop().replace(".part.json", "").replace(/[-_]+/g, " "), vars: f.vars ?? {}, qty: 0, mass: massOf.get(f.id) ?? null };
    r.qty++; rows.set(key, r);
  }
  return [...rows.values()];
}
