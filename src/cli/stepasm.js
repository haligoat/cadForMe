// Big flat STEP export -> real STEP assembly: identical solids become one part used many times, parts are grouped
// into subassemblies by their name prefix ("Side B front drive pod: ..."), names and colours kept, then the result is
// read back and every solid checked against the original. Runs the OpenCascade (OCP) scripts in scripts/step-assembly
// with a Python environment of its own (~/.cache/cadforme/ocp, set up on first use: needs python3 and internet once).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { ROOT } from "./core.js";

const SCRIPTS = path.join(ROOT, "scripts", "step-assembly");
const venv = () => process.env.CADFORME_OCP ?? path.join(os.homedir(), ".cache", "cadforme", "ocp");
const py = () => path.join(venv(), "bin", "python");

/** The OCP Python, installed on first use. */
export function ensureOcp(onProgress = () => {}) {
  try { execFileSync(py(), ["-I", "-c", "import OCP, numpy, scipy"], { stdio: "ignore" }); return py(); } catch { /* not set up yet */ }
  onProgress("First run: setting up OpenCascade for Python (about 300 MB, a few minutes)");
  if (!fs.existsSync(py())) execFileSync("python3", ["-m", "venv", venv()], { stdio: ["ignore", process.stderr, process.stderr] });
  execFileSync(py(), ["-m", "pip", "install", "-q", "cadquery-ocp", "numpy", "scipy"], { stdio: ["ignore", process.stderr, process.stderr] });
  return py();
}

function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(py(), ["-I", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", ob = "", eb = "";
    const lines = (buf, chunk) => { const parts = (buf + chunk).split("\n"); for (const l of parts.slice(0, -1)) onLine(l); return parts.at(-1); };
    child.stdout.on("data", (d) => { out += d; ob = lines(ob, String(d)); });
    child.stderr.on("data", (d) => { err += d; eb = lines(eb, String(d)); });
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(args[0])} failed: ${(err.match(/\w*Error.*$/m) ?? [err.trim().split("\n").at(-1)])[0]}`))));
  });
}

/**
 * Rebuild `stepFile` as an assembly in <project>/exports/<name>-assembly.step (+ .parts.json with every unique part and
 * its count). `groups` adds keyword subassemblies, e.g. { Transfer: "\\btransfer\\b" }. Working files go to
 * <project>/.cadforme/step-assembly/. Returns the check result.
 */
export async function stepToAssembly(dir, stepFile, { groups, onProgress = () => {} } = {}) {
  const src = path.resolve(stepFile);
  if (!fs.existsSync(src)) throw new Error(`No file ${stepFile}`);
  ensureOcp(onProgress);
  const stem = path.basename(src).replace(/\.(step|stp)$/i, "");
  const work = path.join(dir, ".cadforme", "step-assembly", stem);
  const out = path.join(dir, "exports", `${stem}-assembly.step`);
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.dirname(out), { recursive: true });
  const say = (l) => { if (/^(parsed|transferred|roots|\d+ solids|loaded|\d+\/\d+ solids|\d+ unique|groups|renamed|wrote)/.test(l.trim())) onProgress(l.trim()); };
  onProgress(`Reading ${path.basename(src)} (${Math.round(fs.statSync(src).size / 1e6)} MB)`);
  await run([path.join(SCRIPTS, "inspect.py"), src, work], say);
  onProgress("Finding identical parts and writing the assembly");
  await run([path.join(SCRIPTS, "build.py"), work, out, ...(groups && Object.keys(groups).length ? [JSON.stringify(groups)] : [])], say);
  fs.copyFileSync(path.join(work, "parts.json"), out.replace(/\.step$/, ".parts.json"));
  onProgress("Reading the assembly back to check every part");
  const res = JSON.parse((await run([path.join(SCRIPTS, "verify.py"), path.join(work, "solids.json"), out], () => {})).match(/^RESULT (.*)$/m)[1]);
  const parts = JSON.parse(fs.readFileSync(path.join(work, "parts.json"), "utf8"));
  return { file: out, rel: path.relative(dir, out), mb: Math.round(fs.statSync(out).size / 1e6), sourceMb: Math.round(fs.statSync(src).size / 1e6),
    ok: res.original === res.rebuilt && !res.unmatched && !res.duplicates && res.worstOffsetMm < 0.05 && res.volumeDiffPct < 0.01,
    unnamed: parts.filter((p) => / part \d+$/.test(p.name)).length, mostUsed: [...parts].sort((a, b) => b.count - a.count).slice(0, 5).map((p) => `${p.count}x ${p.name}`), ...res };
}

export function stepAssemblyReport(r) {
  return [`${r.rel}: ${r.unique} unique parts placed ${r.rebuilt} times (from ${r.original} solids), ${r.mb} MB (was ${r.sourceMb} MB)`,
    `Subassemblies: ${r.assemblies.slice(1).join(", ") || "none"}`,
    `Check: ${r.ok ? "every solid in place" : "PROBLEM"} (worst offset ${r.worstOffsetMm.toFixed(4)} mm, volume within ${r.volumeDiffPct.toExponential(1)}%, ${r.unmatched} missing, ${r.duplicates} doubled)`,
    `Most used: ${r.mostUsed.join(", ")}`,
    ...(r.unnamed ? [`${r.unnamed} parts had no name in the file and are called "<group> part N"`] : [])].join("\n");
}
