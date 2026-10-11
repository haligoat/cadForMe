// Export ~/cadSlop/test's robot to STEP with a descriptive name and a colour on every part.
//   names:   the original robot's parts keep their Onshape names (read from imports/onshape-part.step by stepnames.py into
//            scripts/onshape-names.json, matched by bounding box); parts made here are named after the feature that made them;
//            copies and mirrors are named after their source part
//   colours: one colour per kind of part (all side plates one colour, all gecko wheels another, ...), so identical parts match
//            imported vendor parts and the original robot keep the colours their own STEP files give them (onshape-names.json,
//            import-colors.json, both made by stepnames.py); copies and mirrors take their source's colour; parts with the same
//            name always end up the same colour
// Writes 100-body chunks to <out dir>/cNN.step (the kernel runs out of memory on big writes, so run a few chunks per process:
// --from/--to are chunk numbers) and <out dir>/parts.json; scripts/merge-step.py merges them and sets the names and colours.
// Usage: node scripts/export-step.mjs <out dir> [--from N] [--to N]
import fs from "node:fs";
import { initKernel } from "../test/helpers.mjs";
import * as R from "replicad";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";

const OUT = process.argv[2]; if (!OUT) throw new Error("usage: node scripts/export-step.mjs <out dir> [--from N] [--to N]");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const FROM = arg("--from", 0), TO = arg("--to", 999);
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

// ---- the original robot's part names, by body index (matched on the imported file's own bounding boxes) ----
const leaves = JSON.parse(fs.readFileSync(new URL("./onshape-names.json", import.meta.url), "utf8"));
const clean = (s) => (s ?? "").split("__")[0].replace(/ <\d+>$/, "").replace(/_\d+$/, "").replace(/\s+v\d+$/, "").trim();
const generic = (s) => !s || /^(Component\d+|Part \d+|Assembly \d+.*)$/i.test(s);
const origName = {}, origColour = {};
{
  const imp = part.features[0];
  const b0 = buildPart({ name: "orig", features: [imp] }, { imports: await loadImports({ features: [imp] }, files), parts: {} }).bodies;
  const used = new Set();
  b0.forEach((s, i) => {
    const q = s.boundingBox.bounds;
    let best = -1, bd = 0.05;
    leaves.forEach((l, k) => { if (used.has(k)) return; const d = Math.max(...[0, 1].flatMap((m) => [0, 1, 2].map((a) => Math.abs(l.bbox[m][a] - q[m][a])))); if (d < bd) { bd = d; best = k; } });
    if (best < 0) return;
    used.add(best);
    const path = leaves[best].path.map(clean).filter((p) => p && !/^Assembly \d+/i.test(p));
    const leaf = path.at(-1), parent = path.length > 1 ? path.at(-2) : "";
    origName[i] = generic(leaf) ? (parent && !generic(parent) ? `${parent} part` : "") : leaf;
    origColour[i] = leaves[best].color;
  });
  for (const s of b0) { try { s.delete(); } catch { /* freed */ } }
}
const IMPORT_COLOURS = JSON.parse(fs.readFileSync(new URL("./import-colors.json", import.meta.url), "utf8"));
// names for original parts the Onshape file leaves generic (from what they are on the robot)
const KNOWN = {
  0: "Side plate A", 7: "Side plate B", 8: "Cross channel (under the shooter)", 11: "Drive channel B", 24: "Drive channel A",
  2: "Shooter tower channel A", 10: "Shooter tower channel B", 4: "Shooter mount plate (SWYFT ring mount)", 13: "Intake shaft (7 mm hex)",
  5: "Intake bearing block A", 21: "Intake bearing block B", 1: "Intake motor mount", 34: "Drive pod A rear spacer plate",
  497: "Drive pod A front spacer plate", 272: "Drive pod B front spacer plate", 346: "Drive pod B rear spacer plate",
};

const built = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const errs = Object.entries(built.errors ?? {}); if (errs.length) console.log("ERRORS", JSON.stringify(errs).slice(0, 400));
const byId = new Map(part.features.map((f) => [f.id, f]));
// copies and mirrors: which body each one came from
const SRC = new Map(), VIA = new Map();
{ const byOwner = new Map(); built.owners.forEach((o, i) => { if (!byOwner.has(o)) byOwner.set(o, []); byOwner.get(o).push(i); });
  for (const f of part.features) { const list = byOwner.get(f.id); if (!list) continue;
    if ((f.type === "transform" && f.copy) || (f.type === "mirror" && f.merge === false)) { const srcs = [].concat(f.body); list.forEach((i, k) => { if (srcs[k] !== undefined) { SRC.set(i, srcs[k]); VIA.set(i, f); } }); } } }
const tidy = (s) => s.replace(/\s*\((cutter|copy of [^)]*|same part as [^)]*)\)/gi, "").replace(/\s+/g, " ").trim();
const baseName = (i) => KNOWN[i] ?? origName[i] ?? `Robot part ${i}`;
function nameOf(i) {
  const f = byId.get(built.owners[i]);
  if (!f || !String(f.id).startsWith("tx")) return baseName(i);
  if (SRC.has(i)) {
    let s = i; while (SRC.has(s) && String(byId.get(built.owners[s])?.id).startsWith("tx")) s = SRC.get(s);
    const via = VIA.get(i), ctx = via.type === "mirror" ? via.name.split(":")[0].trim() : tidy(via.name).replace(/^(Copy of|Place) /i, "");
    if (via.type === "mirror" || /copy of/i.test(via.name)) return `${ctx}: ${baseName(s)}`;
    return tidy(via.name);
  }
  return tidy(f.name);
}

// ---- one colour per kind of part ----
const KINDS = [
  [/^side plate [AB]$/i, "#8D99AE", "side plate"],
  [/transfer side plate/i, "#3D5A80", "transfer side plate"],
  [/gecko wheel|intakewheel/i, "#2A9D8F", "gecko wheel"],
  [/bearing plate|bearing block|1616|pillow/i, "#F2A541", "bearing plate"],
  [/\bbearing\b|6708zz|1611/i, "#495057", "bearing"],
  [/shaft support/i, "#E4572E", "3D-printed part"],
  [/shaft|2106-4008|axle/i, "#C3C9D1", "shaft"],
  [/coupler/i, "#B08968", "coupler"],
  [/motor mount|printed|petg|funnel|floor piece|mount to/i, "#E4572E", "3D-printed part"],
  [/motor|gearbox|5203|matrix/i, "#E9C46A", "motor"],
  [/lock nut|nut\b|washer|screw|bolt|standoff/i, "#2B2D42", "hardware"],
  [/shooter mount|ring mount/i, "#577590", "shooter mount"],
  [/sr-drive|swyft drive|drive pod/i, "#7B5EA7", "Swyft drive part"],
  [/channel|bracket|pattern|tower/i, "#ADB5BD", "goBILDA structure"],
];
const hashColour = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; const hue = h % 360, l = 0.55, a = 0.45 * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + hue / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0"); }; return `#${f(0)}${f(8)}${f(4)}`; };
function colourOf(name) {
  for (const [re, col, kind] of KINDS) if (re.test(name)) return [col, kind];
  const kind = name.replace(/^.*?: /, "").replace(/\b[AB]\b|#?\d+|\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  return [hashColour(kind), kind];
}

// the colour a part's own file gives it: the original robot's, an imported vendor file's, or (copies, mirrors) its source's
function fileColour(i) {
  const f = byId.get(built.owners[i]);
  if (!f || !String(f.id).startsWith("tx")) return origColour[i] ?? null;
  if (SRC.has(i)) return fileColour(SRC.get(i));
  if (f.type === "import") return IMPORT_COLOURS[f.file] ?? null;
  return null;
}
const live = built.bodies.map((_, i) => i).filter((i) => !GONE.has(i));
const rows = live.map((i) => { const name = nameOf(i), [kc, kind] = colourOf(name), own = fileColour(i); return { i, name, color: own ?? kc, kind, from: own ? "file" : "kind" }; });
// assemblies imported as one body (the shooter): merge-step.py puts the file's own named, coloured parts there instead
for (const r of rows) { const f = byId.get(built.owners[r.i]);
  if (f?.type === "import" && fs.existsSync(new URL(`./import-names/${f.file.split("/").pop().replace(/\.step$/i, "")}.json`, import.meta.url)))
    Object.assign(r, { file: dir + f.file, anchor: f.anchor ?? [0, 0, 0], orient: f.orient ?? [0, 0, 0], position: f.position ?? [0, 0, 0], kind: "assembly (own names and colours)" }); }
// same part, same colour: group by the name without side letters, numbers and "Side B front drive pod:"-style prefixes
const key = (n) => n.replace(/^.*?: /, "").replace(/\b[AB]\b|#?\d+(\.\d+)?|\(.*?\)/g, "").replace(/\s+/g, " ").trim().toLowerCase();
{ const groups = new Map(); for (const r of rows) { const k = key(r.name); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  for (const g of groups.values()) { const c = new Map(); for (const r of g) c.set(r.color, (c.get(r.color) ?? 0) + 1); const top = [...c].sort((a, b) => b[1] - a[1])[0][0]; for (const r of g) r.color = top; } }
// the chunks carry each part's row number as its name; merge-step.py swaps in the real name and colour from parts.json (colours
// are set there in sRGB, as STEP stores them)
fs.mkdirSync(OUT, { recursive: true });
if (FROM === 0) for (const f of fs.readdirSync(OUT)) if (/^c\d+\.step$/.test(f)) fs.rmSync(`${OUT}/${f}`);
for (let k = 0, c = 0; k < rows.length; k += 100, c++) {
  if (c < FROM || c > TO) continue;
  const blob = R.exportSTEP(rows.slice(k, k + 100).map((r, j) => ({ shape: built.bodies[r.i], name: `row ${k + j}` })));
  fs.writeFileSync(`${OUT}/c${String(c).padStart(2, "0")}.step`, new Uint8Array(await blob.arrayBuffer()));
}
fs.writeFileSync(`${OUT}/parts.json`, JSON.stringify(rows.map(({ name, color, kind, from, file, anchor, orient, position }) => ({ name, color, kind, from, file, anchor, orient, position })), null, 1));
const kinds = {}; for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
console.log("EXPORTED", rows.length, "bodies (chunks", FROM, "to", Math.min(TO, Math.ceil(rows.length / 100) - 1) + "), errors", JSON.stringify(Object.fromEntries(errs)), "| colours from files", rows.filter((r) => r.from === "file").length);
console.log("kinds:", Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" | "));
console.log("unnamed:", rows.filter((r) => /^Robot part \d+$/.test(r.name)).length);
