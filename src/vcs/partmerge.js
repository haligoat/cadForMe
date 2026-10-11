// CAD-aware diff & 3-way merge of .part.json documents.
// Merges per variable and per feature (and per field inside a feature), so two people
// editing different features never conflict.

const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a, b) => stable(a) === stable(b);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 3-way merge of one value. Returns {value, deleted, conflict}. */
function merge3(base, ours, theirs, baseHas, oursHas, theirsHas) {
  const b = baseHas ? base : undefined, o = oursHas ? ours : undefined, t = theirsHas ? theirs : undefined;
  if (oursHas === theirsHas && same(o, t)) return { value: o, present: oursHas };
  if (baseHas === oursHas && same(b, o)) return { value: t, present: theirsHas };
  if (baseHas === theirsHas && same(b, t)) return { value: o, present: oursHas };
  return { conflict: true };
}

function mergeFields(base, ours, theirs) {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(ours ?? {}), ...Object.keys(theirs ?? {})]);
  const out = {}; const bad = [];
  for (const k of keys) {
    const r = merge3(base?.[k], ours?.[k], theirs?.[k], base && has(base, k), ours && has(ours, k), theirs && has(theirs, k));
    if (r.conflict) bad.push(k); else if (r.present) out[k] = r.value;
  }
  return { out, bad };
}

/**
 * mergeParts(base, ours, theirs, resolutions) -> { merged, conflicts }
 * resolutions: { [conflictKey]: "ours" | "theirs" }
 */
export function mergeParts(base, ours, theirs, resolutions = {}) {
  base ??= { variables: {}, features: [] };
  const conflicts = [];
  const pick = (key, o, t, oHas = true, tHas = true) => {
    const c = resolutions[key];
    if (c === "ours") return { present: oHas, value: o };
    if (c === "theirs") return { present: tHas, value: t };
    return null;
  };

  // variables
  const variables = {};
  for (const k of new Set([...Object.keys(base.variables ?? {}), ...Object.keys(ours.variables ?? {}), ...Object.keys(theirs.variables ?? {})])) {
    const bv = base.variables ?? {}, ov = ours.variables ?? {}, tv = theirs.variables ?? {};
    const r = merge3(bv[k], ov[k], tv[k], has(bv, k), has(ov, k), has(tv, k));
    if (r.conflict) {
      const key = `variable:${k}`;
      const p = pick(key, ov[k], tv[k], has(ov, k), has(tv, k));
      if (p) { if (p.present) variables[k] = p.value; } else conflicts.push({ key, label: `Variable "${k}"`, base: bv[k], ours: ov[k], theirs: tv[k] });
    } else if (r.present) variables[k] = r.value;
  }

  // features by id
  const idx = (p) => new Map((p.features ?? []).map((f) => [f.id, f]));
  const B = idx(base), O = idx(ours), T = idx(theirs);
  const feats = new Map();
  for (const id of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const bf = B.get(id), of = O.get(id), tf = T.get(id);
    const r = merge3(bf, of, tf, !!bf, !!of, !!tf);
    if (!r.conflict) { if (r.present) feats.set(id, r.value); continue; }
    if (bf && of && tf) {
      const { out, bad } = mergeFields(bf, of, tf);
      if (!bad.length) { feats.set(id, out); continue; }
    }
    const key = `feature:${id}`;
    const p = pick(key, of, tf, !!of, !!tf);
    if (p) { if (p.present) feats.set(id, p.value); }
    else conflicts.push({ key, label: `Feature "${(of ?? tf ?? bf)?.name ?? id}" (${(of ?? tf ?? bf)?.type})`, base: bf, ours: of, theirs: tf });
  }

  // order
  const ids = (p) => (p.features ?? []).map((f) => f.id);
  const bIds = ids(base), oIds = ids(ours), tIds = ids(theirs);
  const common = (a) => a.filter((i) => bIds.includes(i));
  const oursReordered = !same(common(oIds), bIds.filter((i) => oIds.includes(i)));
  const backbone = (oursReordered ? oIds : (same(common(tIds), bIds.filter((i) => tIds.includes(i))) ? oIds : tIds))
    .filter((i) => feats.has(i));
  const order = [...backbone];
  for (const src of [oIds, tIds]) {
    src.forEach((id, i) => {
      if (!feats.has(id) || order.includes(id)) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) { const pos = order.indexOf(src[j]); if (pos >= 0) { at = pos + 1; break; } }
      // Deterministic tie-break so both sides of a merge produce the same order.
      while (at < order.length && !bIds.includes(order[at]) && order[at] < id) at++;
      order.splice(at, 0, id);
    });
  }

  // other top level keys (name, ...)
  const rest = mergeFields(
    Object.fromEntries(Object.entries(base).filter(([k]) => !["variables", "features"].includes(k))),
    Object.fromEntries(Object.entries(ours).filter(([k]) => !["variables", "features"].includes(k))),
    Object.fromEntries(Object.entries(theirs).filter(([k]) => !["variables", "features"].includes(k))));
  for (const k of rest.bad) {
    const key = `meta:${k}`;
    const p = pick(key, ours[k], theirs[k]);
    if (p) { if (p.present) rest.out[k] = p.value; } else conflicts.push({ key, label: `Part ${k}`, base: base[k], ours: ours[k], theirs: theirs[k] });
  }

  return { merged: { ...rest.out, variables, features: order.map((i) => feats.get(i)) }, conflicts };
}

const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v));

/** Human readable list of changes between two part documents. */
export function diffPart(a, b) {
  a ??= { variables: {}, features: [] };
  b ??= { variables: {}, features: [] };
  const out = [];
  const av = a.variables ?? {}, bv = b.variables ?? {};
  for (const k of new Set([...Object.keys(av), ...Object.keys(bv)])) {
    if (!has(av, k)) out.push({ kind: "added", scope: "variable", id: k, text: `Variable ${k} = ${fmt(bv[k])}` });
    else if (!has(bv, k)) out.push({ kind: "removed", scope: "variable", id: k, text: `Removed variable ${k}` });
    else if (!same(av[k], bv[k])) out.push({ kind: "changed", scope: "variable", id: k, text: `Variable ${k}: ${fmt(av[k])} → ${fmt(bv[k])}` });
  }
  const A = new Map((a.features ?? []).map((f) => [f.id, f]));
  const B = new Map((b.features ?? []).map((f) => [f.id, f]));
  const label = (f) => f.name ?? f.id;
  for (const [id, f] of B) {
    const old = A.get(id);
    if (!old) { out.push({ kind: "added", scope: "feature", id, text: `Added ${f.type} "${label(f)}"` }); continue; }
    const changed = [...new Set([...Object.keys(old), ...Object.keys(f)])].filter((k) => !same(old[k], f[k]));
    if (changed.length) {
      out.push({ kind: "changed", scope: "feature", id, text: `${label(f)}: ${changed.map((k) => `${k} ${fmt(old[k] ?? "∅")} → ${fmt(f[k] ?? "∅")}`).join(", ")}` });
    }
  }
  for (const [id, f] of A) if (!B.has(id)) out.push({ kind: "removed", scope: "feature", id, text: `Removed ${f.type} "${label(f)}"` });
  const common = (m, other) => [...m.keys()].filter((k) => other.has(k));
  if (!same(common(A, B), common(B, A))) out.push({ kind: "changed", scope: "order", id: "", text: "Feature order changed" });
  if (a.name !== b.name) out.push({ kind: "changed", scope: "meta", id: "name", text: `Renamed part: ${a.name ?? ""} → ${b.name ?? ""}` });
  return out;
}
