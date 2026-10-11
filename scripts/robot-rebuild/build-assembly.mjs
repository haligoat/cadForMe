// Build a new Assembly tab from an existing one in a single batch (Onshape's transformedinstances call): every top-level
// part is inserted at its world transform, every subassembly as an instance, and one assembly can be placed with its own
// transform (the team shooter). Usage: node scripts/robot-rebuild/build-assembly.mjs <project> "<new name>" [shooter transform json]
import fs from "node:fs";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const [project, name, shooterFile] = process.argv.slice(2);
const dir = project.startsWith("/") ? project : `${ROOT}/projects/${project}`;
const { OnshapeClient } = await import(`${ROOT}/src/onshape/client.js`);
const { loadOnshapeKeys } = await import(`${ROOT}/src/onshape/keystore.js`);
const { did, wid, robotAssembly } = JSON.parse(fs.readFileSync(`${dir}/onshape-target.json`, "utf8"));
const c = new OnshapeClient(loadOnshapeKeys());
const src = await c.getAssembly({ did, wid, eid: robotAssembly });
const shooterT = shooterFile ? JSON.parse(fs.readFileSync(shooterFile, "utf8")) : null;
const groups = []; const key = (i) => ({ documentId: i.documentId, elementId: i.elementId, configuration: i.configuration ?? "default", ...(i.documentVersion ? { versionId: i.documentVersion } : {}) });
for (const i of src.rootAssembly.instances) {
  const occ = src.rootAssembly.occurrences.find((o) => o.path.length === 1 && o.path[0] === i.id);
  const team = i.type === "Assembly" && /^Static Pollen Shooter v1 </.test(i.name) && !/\(robot\)/.test(i.name);   // the team's shooter tab
  const transform = team && shooterT ? shooterT : occ.transform;
  groups.push({ instances: [i.type === "Part" ? { ...key(i), partId: i.partId, isAssembly: false, isWholePartStudio: false } : { ...key(i), isAssembly: true, isWholePartStudio: false }], transform });
}
const asm = await c.createAssembly(did, wid, name);
const ref = { did, wid, eid: asm.id };
const CH = 60;
for (let k = 0; k < groups.length; k += CH) {
  await c.req("POST", `/assemblies/d/${did}/w/${wid}/e/${asm.id}/transformedinstances`, { transformGroups: groups.slice(k, k + CH) });
  console.log(`placed ${Math.min(k + CH, groups.length)} of ${groups.length}`);
}
const out = await c.getAssembly(ref);
console.log(JSON.stringify({ assembly: name, eid: asm.id, source: src.rootAssembly.instances.length, built: out.rootAssembly.instances.length, url: `https://cad.onshape.com/documents/${did}/w/${wid}/e/${asm.id}` }));
