// Geometry runs off the UI thread. Messages: {id, type: "build"|"stl"|"step", part, upTo}
import opencascade from "replicad-opencascadejs";
import { initSolver } from "./sketch2.js";
import { runDrc } from "./drc.js";
import { init, buildPart, meshBodies, measure, exportSTL, exportSTEP, loadImports, disposeImports, collectParts, makeDrawing } from "./geometry.js";

const ready = (async () => {
  const wasmBinary = await (await fetch("./replicad_single.wasm")).arrayBuffer();
  init(await opencascade({ wasmBinary }));
  await initSolver(await (await fetch("./planegcs.wasm")).arrayBuffer());
})();

const disposeAll = (bodies) => bodies.forEach((b) => { try { b.delete(); } catch { /* already freed */ } });

self.onmessage = async ({ data }) => {
  const { id, type, part, upTo, files, rules } = data;
  try {
    await ready;
    if (type === "ping") { self.postMessage({ id, ok: true }); return; }
    const parts = collectParts(part, files);
    const imports = new Map();
    for (const p of [part, ...parts.values()]) for (const [k, v] of await loadImports(p, files)) imports.set(k, v);
    if (type === "drc") self.postMessage({ id, progress: { label: "Build", index: 0, total: 1 } });
    const tb = performance.now();
    const built = buildPart(part, { upTo, imports, parts });
    const buildMs = Math.round(performance.now() - tb);
    // the built bodies are copies, so free the loaded STEP files now (a big import is several hundred MB of the wasm heap)
    disposeImports(imports); imports.clear();
    try {
      if (type === "build") {
        const stats = measure(built.bodies, part.material?.density);
        const diag = Math.max(1, ...stats.map((m) => Math.hypot(...m.size)));
        const tolerance = Math.min(0.05, Math.max(0.005, diag * 0.0001));   // fine enough that holes and shafts look round
        const meshes = meshBodies(built.bodies, { tolerance, angularTolerance: 0.1 });
        const transfer = meshes.flatMap((m) => [m.vertices.buffer, m.normals.buffer, m.triangles.buffer, m.lines.buffer]);
        self.postMessage({ id, ok: true, result: { meshes, stats, owners: built.owners, errors: built.errors, variables: built.variables } }, transfer);
      } else if (type === "drc") {
        const result = runDrc(part, built, { rules, onStep: (st) => self.postMessage({ id, progress: st }) });
        result.stats = { ...result.stats, buildMs };
        self.postMessage({ id, ok: true, result });
      } else if (type === "interference") {
        // Every pair of bodies from different features/instances that overlap by more than a hair.
        const st = measure(built.bodies), hits = [];
        for (let i = 0; i < built.bodies.length; i++) for (let j = i + 1; j < built.bodies.length; j++) {
          if (built.owners[i] === built.owners[j]) continue;
          const a = st[i].bounds, b = st[j].bounds;
          if ([0, 1, 2].some((k) => a[1][k] <= b[0][k] + 1e-6 || b[1][k] <= a[0][k] + 1e-6)) continue;
          let v = 0; try { const x = built.bodies[i].clone().intersect(built.bodies[j].clone()); v = measure([x])[0]?.volume ?? 0; x.delete(); } catch { v = -1; }
          if (v > 0.5 || v < 0) hits.push({ a: i, b: j, ownerA: built.owners[i], ownerB: built.owners[j], volume: v });
        }
        self.postMessage({ id, ok: true, result: { hits } });
      } else if (type === "drawing") {
        const m = measure(built.bodies, part.material?.density);
        const svg = makeDrawing(built.bodies, { name: part.name || "Part", material: part.material?.name ?? "", mass: m.every((x) => x.mass !== null) && m.length ? m.reduce((a, x) => a + x.mass, 0) : null });
        self.postMessage({ id, ok: true, result: { bytes: new TextEncoder().encode(svg) } });
      } else if (type === "stepNew") {
        // Only what was added on top of big imported models (those are already in Onshape): leave out bodies owned by imports over 20 MB.
        const big = new Set(part.features.filter((f) => f.type === "import" && (files?.[f.file]?.length ?? 0) > 20e6).map((f) => f.id));
        const keep = built.bodies.filter((_, i) => !big.has(built.owners[i]));
        if (!keep.length) throw new Error("Nothing to send: everything in this part comes from the big imported model");
        const bytes = new Uint8Array(await exportSTEP(keep).arrayBuffer());
        self.postMessage({ id, ok: true, result: { bytes, count: keep.length, leftOut: built.bodies.length - keep.length } }, [bytes.buffer]);
      } else if (type === "stl" || type === "step") {
        if (!built.bodies.length) throw new Error("Nothing to export: the part has no solid bodies");
        const blob = type === "stl" ? exportSTL(built.bodies) : exportSTEP(built.bodies);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        self.postMessage({ id, ok: true, result: { bytes } }, [bytes.buffer]);
      } else throw new Error(`Unknown request ${type}`);
    } finally { disposeAll(built.bodies); disposeImports(imports); }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
