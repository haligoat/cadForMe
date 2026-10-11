// Small vector helpers shared by the kernel and the UI.
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Orthonormal x direction for a plane with the given normal (must match everywhere). */
export function perpendicular(n) {
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return norm(cross(ref, n));
}

export const STD_FRAMES = {
  XY: { x: [1, 0, 0], n: [0, 0, 1] },
  XZ: { x: [1, 0, 0], n: [0, -1, 0] },
  YZ: { x: [0, 1, 0], n: [1, 0, 0] },
};

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
/** Rotate vector v about unit axis k by `deg` degrees (Rodrigues). */
export function rotateAbout(v, k, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), kv = cross(k, v), kd = dot(k, v);
  return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * kd * (1 - c));
}

/** Frame of a standard plane name or a construction-plane feature id. */
export function resolveFrame(ref, planes) {
  if (STD_FRAMES[ref]) { const f = STD_FRAMES[ref]; return { origin: [0, 0, 0], x: f.x, y: cross(f.n, f.x), n: f.n }; }
  const f = planes?.get(ref);
  if (!f) throw new Error(`Unknown plane "${ref}" (construction planes must come before the sketch that uses them)`);
  return f;
}

/** Compute a construction plane feature's frame. */
export function planeFrame(f, ev, planes) {
  switch (f.mode ?? "offset") {
    case "offset": { const b = resolveFrame(f.from ?? "XY", planes), d = ev(f.distance ?? 10); return { ...b, origin: add3(b.origin, mul3(b.n, d)) }; }
    case "threePoint": {
      const [p0, p1, p2] = (f.pts ?? []).map((p) => ev.vec(p));
      if (!p2) throw new Error("A three-point plane needs three points");
      const x = norm(sub3(p1, p0)), n = norm(cross(x, sub3(p2, p0)));
      if (Math.hypot(...cross(x, sub3(p2, p0))) < 1e-9) throw new Error("Those three points are in a line");
      return { origin: p0, x, y: cross(n, x), n };
    }
    case "pointNormal": { const n = norm(ev.vec(f.normal, [0, 0, 1])), x = perpendicular(n); return { origin: ev.vec(f.origin, [0, 0, 0]), x, y: cross(n, x), n }; }
    case "midplane": {
      const a = resolveFrame(f.a, planes), b = resolveFrame(f.b, planes);
      return { ...a, origin: mul3(add3(a.origin, b.origin), 0.5) };
    }
    case "angle": {
      const b = resolveFrame(f.from ?? "XY", planes), k = norm(ev.vec(f.axis, [1, 0, 0])), pt = ev.vec(f.point, [0, 0, 0]), ang = ev(f.angle ?? 45);
      const origin = add3(rotateAbout(sub3(b.origin, pt), k, ang), pt), x = norm(rotateAbout(b.x, k, ang)), n = norm(rotateAbout(b.n, k, ang));
      return { origin, x, y: cross(n, x), n };
    }
    default: throw new Error(`Unknown plane mode "${f.mode}"`);
  }
}

/** Frames of all construction planes in a part (errors are skipped here; the kernel reports them). */
export function planeFrames(part, ev) {
  const planes = new Map();
  for (const f of part?.features ?? []) if (f.type === "plane" && !f.suppressed) { try { planes.set(f.id, planeFrame(f, ev, planes)); } catch { /* reported by the kernel */ } }
  return planes;
}

/** World frame of a sketch feature: {origin, x, y, n}. `ev` evaluates expressions; `planes` are construction planes. */
export function sketchFrame(sk, ev, planes) {
  const off = ev.opt(sk.offset, 0);
  const p = sk.plane ?? "XY";
  let x, n, o;
  if (typeof p === "string") {
    const f = resolveFrame(p, planes);
    x = f.x; n = f.n; o = f.origin;
  } else {
    n = norm(ev.vec(p.normal, [0, 0, 1]));
    x = p.xDir ? norm(ev.vec(p.xDir)) : perpendicular(n);
    o = ev.vec(p.origin, [0, 0, 0]);
  }
  return { origin: [o[0] + n[0] * off, o[1] + n[1] * off, o[2] + n[2] * off], x, y: cross(n, x), n };
}
