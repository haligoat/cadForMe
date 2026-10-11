import fs from "node:fs";
import * as R from "replicad";
import { initKernel } from "../test/helpers.mjs";
import { buildPart, loadImports, collectParts } from "../src/kernel/geometry.js";
await initKernel();
const dir = process.env.HOME + "/cadSlop/test/";
const p0 = JSON.parse(fs.readFileSync(dir + "parts/onshape-part.part.json", "utf8"));
const part = { ...p0, features: p0.features.filter((f) => f.type !== "deleteBody") };
const files = {}; for (const f of part.features) { if (f.type === "import" && !files[f.file]) files[f.file] = new Uint8Array(fs.readFileSync(dir + f.file)); if (f.type === "insert" && !files[f.part]) files[f.part] = new Uint8Array(fs.readFileSync(dir + f.part)); }
const b = buildPart(part, { imports: await loadImports(part, files), parts: collectParts(part, files) });
const byId = new Map(part.features.map((f) => [f.id, f]));
const nm = (i) => byId.get(b.owners[i])?.name ?? "";
const plates = b.bodies.map((_, i) => i).filter((i) => /^Transfer side plate [AB]/.test(nm(i)));
b.bodies.forEach((s, i) => { if (!/^M4 nut \(proof of fit\): Bearing/.test(nm(i))) return; const q = s.boundingBox.bounds;
  for (const p of plates) { let v = 0, r = null; try { r = s.clone().intersect(b.bodies[p].clone()); v = R.measureVolume(r); } catch { v = -1; } finally { try { r?.delete(); } catch {} }
    if (v > 1) console.log("NUT", nm(i).slice(40), JSON.stringify(q.map((t) => t.map((x) => +x.toFixed(1)))), "in", nm(p).slice(0, 22), v.toFixed(0)); } });
