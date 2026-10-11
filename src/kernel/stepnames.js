// Clean, consistent names for imported CAD files: "<Vendor> <part number> <description>", e.g.
//   gobilda-2106-4008-1040-rex-shaft-104mm.step  -> "goBILDA 2106-4008-1040 REX shaft 104mm"
//   Swyft_Servo_SR-Servo-01.step                 -> "Swyft SR-Servo-01 servo"
// The vendor and part number come from the file name or the STEP file's PRODUCT names; the rest of the file name is the description.

// (?<![A-Za-z0-9]) instead of \b: file names glue words with "_", which \b treats as part of a word.
const B = "(?<![A-Za-z0-9])";
const VENDORS = [
  { name: "goBILDA", test: new RegExp(`gobilda|${B}\\d{4}-\\d{4}-\\d{4}(?![0-9])`, "i"), pn: new RegExp(`${B}(\\d{4}-\\d{4}-\\d{4})(?![0-9])`) },
  { name: "Swyft", test: new RegExp(`swyft|${B}SR-[A-Z]`, "i"), pn: new RegExp(`${B}(SR-[A-Z0-9]+(?:-[A-Z0-9]+)*)`, "i") },
  { name: "REV", test: new RegExp(`${B}REV-\\d{2}-\\d{4}`, "i"), pn: new RegExp(`${B}(REV-\\d{2}-\\d{4})`, "i") },
  { name: "AndyMark", test: new RegExp(`andymark|${B}am-\\d{3,5}`, "i"), pn: new RegExp(`${B}(am-\\d{3,5}[a-z]?)`, "i") },
];
const ACRONYMS = new Set(["rex", "gt2", "htd", "pla", "petg", "tpu", "abs", "cnc", "usb", "led", "imu", "ftc", "frc", "brg"]);
const GENERIC = /^(component\d*|part\d*|body\d*|none|solid\d*|configuration \d+|default|assembly\d*|untitled.*)$/i;

/** Names in a STEP file's PRODUCT records, without version suffixes ("SR-SERVO-TITAN-01 v13" -> "SR-SERVO-TITAN-01") or generic ones. */
export function productNames(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/PRODUCT\(\s*'([^']*)'\s*,\s*'([^']*)'/g)) {
    for (const raw of [m[2], m[1]]) {
      const n = raw.replace(/\s+v\d+$/i, "").trim();
      if (n && !GENERIC.test(n) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Conventional name for an imported file. `text` is the STEP file's contents (only the header part is needed), optional. */
export function importName(file, text) {
  const base = String(file).split("/").pop().replace(/\.(step|stp|stl|iges|igs)$/i, "");
  const products = productNames(text);
  const hay = [base, ...products].join(" ");
  const vendor = VENDORS.find((v) => v.test.test(hay));
  let pn = null;
  if (vendor) for (const s of [base, ...products]) { const m = s.match(vendor.pn); if (m) { pn = m[1]; break; } }
  let desc = base;
  if (vendor) desc = desc.replace(new RegExp(escape(vendor.name), "ig"), " ");
  if (pn) desc = desc.replace(new RegExp(escape(pn).replace(/-/g, "[-_ ]"), "ig"), " ");
  const seen = new Set(), words = [];
  for (const w of desc.replace(/[_-]+/g, " ").replace(/\bv\d+\b/ig, " ").split(/\s+/).filter(Boolean)) {
    const low = w.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    words.push(ACRONYMS.has(low) ? low.toUpperCase() : /^[A-Z][a-z]+$/.test(w) || /^[a-z]+$/.test(w) ? low : w);
  }
  if (!vendor && !words.length) return products[0] ?? base;
  return [vendor?.name, pn, words.join(" ")].filter(Boolean).join(" ").trim() || base;
}

const norm = (x) => String(x).toLowerCase().replace(/\bv\d+\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Name for an import that may already say what the part is for: "Transfer shaft 1 (goBILDA 2106-4008-1040)" keeps its role
 * and gets the standard name after it ("Transfer shaft 1 - goBILDA 2106-4008-1040 REX shaft 104mm").
 */
export function conventionalName(f, standard) {
  if (hasAutoName(f)) return standard;
  const role = String(f.name).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+-\s+.*$/, "").trim();
  const base = norm(String(f.file ?? "").split("/").pop().replace(/\.[^.]+$/, ""));
  if (!role || norm(role) === base || norm(role).includes(norm(standard)) || norm(standard).includes(norm(role))) return norm(role) === norm(standard) ? f.name : standard;
  return `${role} - ${standard}`;
}

/** True when an import feature still has an automatic name (its file name, id or "import"), so renaming it is safe. */
export function hasAutoName(f) {
  const base = String(f.file ?? "").split("/").pop();
  return !f.name || f.name === f.id || f.name === base || f.name === base.replace(/\.[^.]+$/, "") || /^import( \d+)?$/i.test(f.name);
}
