// Bundles the renderer + geometry worker into dist/.
import { build, context } from "esbuild";
import fs from "node:fs";

const watch = process.argv.includes("--watch");
fs.mkdirSync("dist", { recursive: true });
const common = {
  bundle: true, platform: "browser", target: "chrome130", sourcemap: true, logLevel: "info",
  external: ["fs", "path", "url", "module", "crypto", "os", "worker_threads", "child_process", "perf_hooks", "node:*"],
  define: { "process.env.NODE_ENV": '"production"' },
};
const jobs = [
  { bundle: true, platform: "node", target: "node20", format: "esm", entryPoints: ["src/main/ai-providers.js"], outfile: "dist/ai-providers.mjs", logLevel: "info" },
  { ...common, entryPoints: ["src/renderer/main.js"], outfile: "dist/renderer.js", format: "iife",
    define: { ...common.define, "import.meta.url": '"app://cadslop/renderer.js"' } },
  { ...common, entryPoints: ["src/kernel/worker.js"], outfile: "dist/worker.js", format: "iife",
    define: { ...common.define, "import.meta.url": '"app://cadslop/worker.js"' } },
];
for (const f of ["index.html", "styles.css"]) fs.copyFileSync(`src/renderer/${f}`, `dist/${f}`);
fs.copyFileSync("node_modules/replicad-opencascadejs/dist/replicad_single.wasm", "dist/replicad_single.wasm");
fs.copyFileSync("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", "dist/planegcs.wasm");

if (watch) { for (const j of jobs) await (await context(j)).watch(); console.log("watching…"); }
else await Promise.all(jobs.map((j) => build(j)));
