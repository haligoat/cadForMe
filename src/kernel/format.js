// Canonical on-disk format for .part.json: one variable / feature per line so diffs
// (in cadSlop or any text tool, or an AI) stay small and readable.

export function formatPart(part) {
  const lines = ["{"];
  const top = [];
  if (part.name !== undefined) top.push(`  "name": ${JSON.stringify(part.name)}`);
  const vars = Object.entries(part.variables ?? {});
  top.push(vars.length
    ? `  "variables": {\n${vars.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n  }`
    : `  "variables": {}`);
  const feats = part.features ?? [];
  top.push(feats.length
    ? `  "features": [\n${feats.map((f) => `    ${JSON.stringify(f)}`).join(",\n")}\n  ]`
    : `  "features": []`);
  for (const [k, v] of Object.entries(part)) {
    if (["name", "variables", "features"].includes(k)) continue;
    top.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  lines.push(top.join(",\n"), "}", "");
  return lines.join("\n");
}

export function parsePart(text) {
  const p = JSON.parse(text);
  p.variables ??= {};
  p.features ??= [];
  return p;
}

let counter = 0;
export function newId(prefix, part) {
  const used = new Set((part?.features ?? []).map((f) => f.id));
  let id;
  do { id = `${prefix}${++counter}`; } while (used.has(id));
  return id;
}
