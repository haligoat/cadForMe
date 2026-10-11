// Push designed parts (projects/<project>/parts/*.part.json) to the Onshape document in <project>/onshape-target.json as
// native Part Studios: one tab per part, with sketches and features. Waits and retries when Onshape rate-limits (HTTP 429).
// Usage: node scripts/robot-rebuild/push-parts.mjs <project folder> <part file>...   (part files relative to the project)
import fs from "node:fs";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const [projectDir, ...partFiles] = process.argv.slice(2);
const { OnshapeClient } = await import(`${ROOT}/src/onshape/client.js`);
const { loadOnshapeKeys } = await import(`${ROOT}/src/onshape/keystore.js`);
const { linkNewPartStudio, pushToOnshape } = await import(`${ROOT}/src/onshape/sync.js`);
const c = new OnshapeClient(loadOnshapeKeys());
const dir = projectDir.startsWith("/") ? projectDir : `${ROOT}/projects/${projectDir}`;
const { did, wid } = JSON.parse(fs.readFileSync(`${dir}/onshape-target.json`, "utf8"));
const out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn) { for (let k = 0; ; k++) { try { return await fn(); } catch (e) { if (e.status !== 429) throw e; const wait = Number(e.retryAfter ?? 0); if (wait > 900 || k > 8) throw new Error(`Onshape is rate-limiting this account${wait ? ` (try again in ${Math.round(wait / 3600)} h)` : ""}`); console.error(`rate limited, waiting ${30 * (k + 1)} s`); await sleep(30000 * (k + 1)); } } }
const record = (o) => { const f = `${dir}/onshape-parts.json`; const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []; fs.writeFileSync(f, JSON.stringify([...all.filter((x) => x.part !== o.part), o], null, 1)); };
for (const rel of partFiles) {
  const part = JSON.parse(fs.readFileSync(`${dir}/${rel}`, "utf8"));
  let link = part.onshape;
  if (!link?.eid) {
    const ps = await retry(() => c.createPartStudio(did, wid, part.name));
    await retry(() => linkNewPartStudio(dir, c, rel, { url: `https://cad.onshape.com/documents/${did}/w/${wid}/e/${ps.id}` }));
    link = { did, wid, eid: ps.id };
  }
  const t0 = Date.now();
  const r = await retry(() => pushToOnshape(dir, c, rel));
  await sleep(3000);
  const f = await retry(() => c.req("GET", `/partstudios/d/${did}/w/${wid}/e/${link.eid}/features`));
  const bad = Object.values(f.featureStates ?? {}).filter((s) => s.featureStatus !== "OK").length;
  const mp = await retry(() => c.req("GET", `/partstudios/d/${did}/w/${wid}/e/${link.eid}/massproperties?massAsGroup=false`));
  const vols = Object.values(mp.bodies ?? {}).map((b) => Math.round(b.volume[0] * 1e9));
  out.push({ part: part.description, eid: link.eid, features: f.features.length, problems: bad, bodies: vols.length, volume: vols[0], warnings: (r.warnings ?? []).length, s: Math.round((Date.now() - t0) / 1000) });
  record(out.at(-1)); console.log(JSON.stringify(out.at(-1)));
}

