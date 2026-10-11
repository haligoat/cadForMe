// Swap the Robot assembly's STEP copies of designed parts for the native Part Studio parts (same place: their geometry is
// already in robot coordinates, so the instance goes in at the identity transform). A part is only swapped when its world
// bounding box matches the original's (<scratch>/out/bboxes.json from scripts/step-assembly inspect).
// Usage: node scripts/robot-rebuild/swap-parts.mjs <project> <scratch dir with out/solids.json + out/bboxes.json> [part file...]
import fs from "node:fs";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, ""), [project, S] = process.argv.slice(2, 4);
const dir = project.startsWith("/") ? project : `${ROOT}/projects/${project}`;
const { did, wid, robotAssembly, rebuiltAssembly } = JSON.parse(fs.readFileSync(`${dir}/onshape-target.json`, "utf8"));
const { OnshapeClient } = await import(`${ROOT}/src/onshape/client.js`);
const { loadOnshapeKeys } = await import(`${ROOT}/src/onshape/keystore.js`);
const c = new OnshapeClient(loadOnshapeKeys());
const robot = { did, wid, eid: rebuiltAssembly ?? robotAssembly };   // the rebuilt assembly when there is one (its subassembly tabs are shared with the original Robot)
const only = new Set(process.argv.slice(4));   // part files to swap (empty = all linked and built)
const rows = JSON.parse(fs.readFileSync(`${S}/out/solids.json`, "utf8"));
const parts = fs.readdirSync(`${dir}/parts`).filter((f) => f.endsWith(".part.json") && (!only.size || only.has(f))).map((f) => JSON.parse(fs.readFileSync(`${dir}/parts/${f}`, "utf8"))).filter((p) => p.onshape?.eid);
let a = await c.getAssembly(robot);
const subs = new Map(a.subAssemblies.map((s) => [s.elementId, s]));
const containers = [{ name: "Robot", ref: robot, insts: a.rootAssembly.instances }, ...a.rootAssembly.instances.filter((i) => i.type === "Assembly").map((i) => ({ name: i.name, ref: { did, wid, eid: i.elementId }, insts: subs.get(i.elementId).instances }))];
const out = [];
for (const p of parts) {
  const row = rows.find((r) => r.name === p.description);
  const ps = { did, wvm: "w", wid, eid: p.onshape.eid };
  const list = await c.req("GET", `/parts/d/${did}/w/${wid}/e/${p.onshape.eid}`);
  if (list.length !== 1) { out.push([p.description, `skipped: ${list.length} parts in its Part Studio`]); continue; }
  const B = JSON.parse(fs.readFileSync(`${S}/out/bboxes.json`, "utf8"))[rows.indexOf(row)];
  const bb = await c.req("GET", `/parts/d/${did}/w/${wid}/e/${p.onshape.eid}/partid/${encodeURIComponent(list[0].partId)}/boundingboxes`);
  const off = Math.max(...[bb.lowX, bb.lowY, bb.lowZ, bb.highX, bb.highY, bb.highZ].map((v, k) => Math.abs(v * 1000 - B[k])));   // world bounding box vs the original
  if (off > 0.05) { out.push([p.description, `skipped: its bounding box is ${off.toFixed(3)} mm from the original`]); continue; }
  const host = containers.find((k) => k.insts.some((i) => i.type === "Part" && i.name.startsWith(p.description)));
  if (!host) { out.push([p.description, "skipped: not in the Robot"]); continue; }
  const old = host.insts.find((i) => i.type === "Part" && i.name.startsWith(p.description));
  const before = new Set((await c.getAssembly(host.ref)).rootAssembly.instances.map((i) => i.id));
  await c.req("POST", `/assemblies/d/${did}/w/${wid}/e/${host.ref.eid}/instances`, { documentId: did, elementId: p.onshape.eid, partId: list[0].partId, isAssembly: false, isWholePartStudio: false });
  const now = (await c.getAssembly(host.ref)).rootAssembly.instances;
  const added = now.find((i) => !before.has(i.id));
  await c.deleteInstance(host.ref, old.id);
  out.push([p.description, `swapped in ${host.name} (bounding box ${off.toFixed(4)} mm from the original) -> ${added.name}`]);
}
for (const [n, r] of out) console.log(n.slice(0, 58).padEnd(58), r);
