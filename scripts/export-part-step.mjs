// Build a cadForMe part with the kernel and write its bodies to a STEP file (for checking a part against other CAD).
// Usage: node scripts/export-part-step.mjs <part.json> <out.step>
import fs from "node:fs";
import { initKernel } from "../test/helpers.mjs";
import { buildPart } from "../src/kernel/geometry.js";
import * as R from "replicad";
const [, , src, out] = process.argv;
await initKernel();
import { createRequire } from "node:module";
import { initSolver } from "../src/kernel/sketch2.js";
const req = createRequire(import.meta.url);
await initSolver(fs.readFileSync(req.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm")));
const r = buildPart(JSON.parse(fs.readFileSync(src, "utf8")), { cache: new Map() });
if (Object.keys(r.errors).length) console.error("errors:", JSON.stringify(r.errors));
const shape = r.bodies.length === 1 ? r.bodies[0] : R.makeCompound(r.bodies);
fs.writeFileSync(out, Buffer.from(await shape.blobSTEP().arrayBuffer()));
console.log(`${r.bodies.length} bod${r.bodies.length === 1 ? "y" : "ies"} -> ${out}`);
