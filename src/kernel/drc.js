// Design rule check (DRC) for one part, run on an already built part (in the geometry worker, or in Node for the CLI).
// A part file is checked on its own; an assembly only checks how its parts fit together (each inserted part has its
// own result), so nothing is checked twice. Callers cache results per part (keyed by drcKey in drcinfo.js).
import * as replicad from "replicad";
import { measure } from "./geometry.js";
import { nativizePart } from "../onshape/nativize.js";
import { DRC_VERSION, DEFAULT_RULES, isAssembly, drcSteps } from "./drcinfo.js";

export { DRC_VERSION, DEFAULT_RULES, isAssembly, drcSteps };
export { drcKey } from "./drcinfo.js";

// ISO metric screws: nominal size and normal clearance hole
const SCREWS = [[2, 2.4], [2.5, 2.9], [3, 3.4], [4, 4.5], [5, 5.5], [6, 6.6], [8, 9]];
// Features Onshape gets natively once push has converted boxes/cylinders (see onshape/nativize.js + map.js)
const SENDABLE = new Set(["sketch", "plane", "extrude", "fillet", "chamfer", "shell", "boolean", "transform", "mirror", "deleteBody", "box", "cylinder", "onshape"]);

const num = (v) => (typeof v === "number" ? v : null);
const fmt = (x) => String(Math.round(x * 100) / 100);
const nameOf = (part, id) => part.features?.find((f) => f.id === id)?.name ?? id;

/** Run every check. onStep({ label, index, total, frac? }) reports progress. Returns { status, checks, stats }. */
export function runDrc(part, built, { rules = DEFAULT_RULES, onStep = () => {} } = {}) {
  const R = { ...DEFAULT_RULES, ...rules };
  const list = drcSteps(part), checks = [];
  let stats = null, index = 0;
  const run = (label, fn) => {
    onStep({ label, index, total: list.length });
    const t0 = performance.now();
    let r;
    try { r = fn((frac) => onStep({ label, index, total: list.length, frac })); } catch (e) { r = { status: "fail", detail: `The check itself failed: ${e?.message ?? e}` }; }
    checks.push({ label, status: r.status, detail: r.detail, items: r.items ?? [], ms: Math.round(performance.now() - t0) });
    index++;
  };
  const feats = (part.features ?? []).filter((f) => !f.suppressed);
  const sketches = new Map(feats.filter((f) => f.type === "sketch").map((f) => [f.id, f]));

  run("Build", () => {
    const errs = Object.entries(built.errors ?? {});
    return errs.length ? { status: "fail", detail: `${errs.length} feature(s) fail to build`, items: errs.map(([id, m]) => `${nameOf(part, id)}: ${m}`) } : { status: "pass", detail: `${feats.length} features build` };
  });

  run("Stats", () => {
    const m = measure(built.bodies, part.material?.density);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const x of m) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], x.bounds[0][k]); hi[k] = Math.max(hi[k], x.bounds[1][k]); }
    const size = m.length ? hi.map((v, k) => v - lo[k]) : [0, 0, 0];
    const volume = m.reduce((a, x) => a + (x.volume ?? 0), 0);
    // real solids: a body can hold pieces that only touched before a cut separated them (Onshape shows those as separate parts)
    const pieces = built.bodies.reduce((a, b) => a + Math.max(1, Array.from(replicad.iterTopo(b.wrapped, "solid")).length), 0);
    stats = {
      bodies: built.bodies.length, pieces, features: feats.length, variables: Object.keys(part.variables ?? {}).length,
      volume, area: m.every((x) => x.area !== null) ? m.reduce((a, x) => a + x.area, 0) : null,
      mass: m.length && m.every((x) => x.mass !== null) ? m.reduce((a, x) => a + x.mass, 0) : null,
      size, smallest: m.length ? Math.min(...m.map((x) => Math.min(...x.size))) : 0,
    };
    return { status: "pass", detail: `${stats.bodies} bod${stats.bodies === 1 ? "y" : "ies"}, ${fmt(volume / 1000)} cm³, ${size.map(fmt).join(" × ")} mm` };
  });

  if (isAssembly(part)) {
    run("Interference", (progress) => {
      const m = measure(built.bodies), hits = [], n = built.bodies.length, pairs = (n * (n - 1)) / 2;
      let done = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++, done++) {
          if (built.owners[i] === built.owners[j]) continue;
          const a = m[i].bounds, b = m[j].bounds;
          if ([0, 1, 2].some((k) => a[1][k] <= b[0][k] + 1e-6 || b[1][k] <= a[0][k] + 1e-6)) continue;
          let v = 0;
          try { const x = built.bodies[i].clone().intersect(built.bodies[j].clone()); v = measure([x])[0]?.volume ?? 0; x.delete(); } catch { v = -1; }
          if (v > R.overlap || v < 0) hits.push(`${nameOf(part, built.owners[i])} ↔ ${nameOf(part, built.owners[j])}: ${v < 0 ? "couldn't measure" : `${fmt(v)} mm³`}`);
        }
        if (i % 8 === 0) progress(pairs ? done / pairs : 1);
      }
      return hits.length ? { status: "warn", detail: `${hits.length} overlapping pair(s)`, items: hits } : { status: "pass", detail: `${n} bodies, no overlaps` };
    });
  } else {
    run("Pieces", () => {
      const solids = stats?.pieces ?? built.bodies.length;
      return !built.bodies.length ? { status: "fail", detail: "No solid at all" }
        : solids > 1 ? { status: "warn", detail: `${solids} separate pieces: a single part should be one solid (something isn't joined, it would print as loose pieces)` }
          : { status: "pass", detail: "One solid" };
    });

    run("Thin spots", () => {
      const items = [];
      if (stats && stats.smallest < R.minFeature) items.push(`A body is only ${fmt(stats.smallest)} mm thick overall`);
      for (const f of feats) {
        if (f.type === "extrude" && f.mode !== "cut" && num(f.distance) !== null && Math.abs(f.distance) < R.minFeature) items.push(`${f.name ?? f.id}: extruded only ${fmt(f.distance)} mm`);
        if (f.type === "sketch") for (const c of f.cons ?? []) {
          const v = num(c.v);
          if (c.t === "dim" && v !== null && v > 0 && ((c.k === "length" && v < R.minFeature) || (c.k === "radius" && v * 2 < R.minFeature) || (c.k === "diameter" && v < R.minFeature))) items.push(`${f.name ?? f.id}: ${c.k} ${fmt(v)} mm`);
        }
      }
      return items.length ? { status: "warn", detail: `${items.length} size(s) under ${R.minFeature} mm (hard to print or machine)`, items } : { status: "pass", detail: `Nothing under ${R.minFeature} mm` };
    });

    run("Holes", () => {
      const dias = [];
      for (const f of feats) {
        if (f.type === "extrude" && f.mode === "cut") for (const g of sketches.get(f.sketch)?.geom ?? []) if (g.t === "circle" && !g.construction && num(g.r) !== null) dias.push([g.r * 2, f.name ?? f.id]);
        if (f.type === "cylinder" && num(f.r) !== null) dias.push([f.r * 2, f.name ?? f.id]);
        if (f.type === "hole" && num(f.diameter) !== null) dias.push([f.diameter, f.name ?? f.id]);
      }
      const items = [];
      for (const [d, where] of dias) {
        const s = SCREWS.find(([n, c]) => d > n - 0.35 && d < c - 0.15);
        if (s) items.push(`${where}: Ø${fmt(d)} is tight for M${s[0]} (clearance Ø${s[1]})`);
      }
      const counts = Object.entries(dias.reduce((a, [d]) => ({ ...a, [fmt(d)]: (a[fmt(d)] ?? 0) + 1 }), {})).map(([d, n]) => `${n}× Ø${d}`).join(", ");
      return items.length ? { status: "warn", detail: `${items.length} hole(s) too tight for a screw to pass`, items } : { status: "pass", detail: dias.length ? counts : "No holes" };
    });

    run("Printer bed", () => {
      const s = [...(stats?.size ?? [0, 0, 0])].sort((a, b) => a - b), b = [...R.bed].sort((a, c) => a - c);
      return s.every((v, k) => v <= b[k] + 1e-6) ? { status: "pass", detail: `Fits a ${R.bed.join(" × ")} mm bed` } : { status: "warn", detail: `${s.map(fmt).join(" × ")} mm doesn't fit a ${R.bed.join(" × ")} mm bed in any orientation` };
    });

    run("Variables", () => {
      const names = Object.keys(part.variables ?? {});
      return names.length > R.maxVariables ? { status: "warn", detail: `${names.length} variables: keep it to the ${R.maxVariables} or so sizes someone would actually change`, items: names } : { status: "pass", detail: names.length ? `${names.length}: ${names.join(", ")}` : "None" };
    });
  }

  run("Onshape", () => {
    const { warnings } = nativizePart(part);
    const stuck = feats.filter((f) => !SENDABLE.has(f.type));
    const items = [...warnings, ...stuck.map((f) => `${f.name ?? f.id} (${f.type}) stays cadSlop-only`)];
    return items.length ? { status: "warn", detail: `${items.length} thing(s) won't be editable in Onshape`, items } : { status: "pass", detail: "Everything goes over as native Onshape features" };
  });

  const status = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  return { status, checks, stats, version: DRC_VERSION };
}
