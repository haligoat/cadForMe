import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { init } from "../src/kernel/geometry.js";

let ready;
export function initKernel() {
  ready ??= (async () => {
    const wasmBinary = fs.readFileSync(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
    init(await opencascade({ wasmBinary }));
  })();
  return ready;
}
