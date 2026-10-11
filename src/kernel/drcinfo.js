// What a DRC run depends on and which steps it has, without the geometry kernel (the window bundles this; drc.js runs the checks).

export const DRC_VERSION = 4;   // bump whenever a check changes, so saved results are redone
export const DEFAULT_RULES = { minFeature: 1.2, bed: [256, 256, 256], maxVariables: 5, overlap: 0.5 };

export const isAssembly = (part) => part.kind === "assembly" || (part.features ?? []).some((f) => f.type === "insert" && !f.suppressed);
export const drcSteps = (part) => (isAssembly(part) ? ["Build", "Stats", "Interference", "Onshape"] : ["Build", "Stats", "Pieces", "Thin spots", "Holes", "Printer bed", "Variables", "Onshape"]);

/**
 * Fingerprint of everything a part's DRC depends on: the part, the rules, and the bytes of each file it pulls in
 * (inserted parts, imported STEP files). `digest(bytes)` returns a hex hash (crypto.subtle in the window, node:crypto in Node).
 */
export async function drcKey(part, files, rules, digest) {
  const enc = new TextEncoder();
  const fileHashes = [];
  for (const k of Object.keys(files ?? {}).sort()) fileHashes.push([k, await digest(files[k])]);
  return digest(enc.encode(JSON.stringify({ v: DRC_VERSION, rules: { ...DEFAULT_RULES, ...rules }, part, files: fileHashes })));
}
