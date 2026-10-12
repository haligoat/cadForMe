// Minimal Onshape REST client (API key auth over HTTPS).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const API = "/api/v9";

// ---- API budget: Onshape limits calls per account, so count them (per day, saved on disk), cache reads, and share
// identical in-flight reads. A write clears the cache. CADFORME_NO_CACHE=1 turns caching off.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const usageFile = () => process.env.CADFORME_USAGE_FILE ?? path.join(ROOT_DIR, ".cadforme", "api-usage.json");
const today = () => new Date().toISOString().slice(0, 10);
export function apiUsage() {
  try { const u = JSON.parse(fs.readFileSync(usageFile(), "utf8")); return u.day === today() ? u : { day: today(), calls: 0, cached: 0 }; }
  catch { return { day: today(), calls: 0, cached: 0 }; }
}
function bump(field) {
  const u = apiUsage(); u[field] = (u[field] ?? 0) + 1;
  try { fs.mkdirSync(path.dirname(usageFile()), { recursive: true }); fs.writeFileSync(usageFile(), JSON.stringify(u)); } catch { /* counting is best effort */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CACHE_MS = 30_000;
const LIVE = /\/translations\//;   // progress of a running job: never cached

export function parseOnshapeUrl(link) {
  const m = String(link).match(/documents\/([0-9a-f]{24})\/([wvm])\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i);
  if (!m) throw new Error("That doesn't look like an Onshape Part Studio link. Open the Part Studio tab in Onshape and copy the address bar URL");
  return { did: m[1], wvm: m[2].toLowerCase(), wid: m[3], eid: m[4] };
}

/** A link to a whole document (any tab, or none): { did, wvm, wid?, eid? }. Version (v) and microversion links are read-only snapshots. */
export function parseDocumentUrl(link) {
  const m = String(link).match(/documents\/([0-9a-f]{24})(?:\/([wvm])\/([0-9a-f]{24}))?(?:\/e\/([0-9a-f]{24}))?/i);
  if (!m) throw new Error("That doesn't look like an Onshape document link. Copy the address bar URL of the document (cad.onshape.com/documents/...)");
  return { did: m[1], wvm: m[2]?.toLowerCase(), wid: m[3], eid: m[4] };
}

export class OnshapeError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export class OnshapeClient {
  constructor({ accessKey, secretKey, baseUrl = "https://cad.onshape.com", fetch: f = globalThis.fetch }) {
    if (!accessKey || !secretKey) throw new Error("Add your Onshape API keys first (Onshape button → Connect)");
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") throw new Error("The Onshape address must use https so your keys stay private");
    Object.assign(this, { base: u.origin, f, auth: `Basic ${Buffer.from(`${accessKey}:${secretKey}`).toString("base64")}` });
  }

  /**
   * Every call goes through here: cached reads (unless `opts.fresh`), shared in-flight reads, retries on network/5xx
   * failures, usage counting, and limits remembered so a call Onshape is going to refuse isn't sent at all.
   */
  req(method, apiPath, body, opts = {}) {
    this.cache ??= new Map();
    if (method !== "GET" || LIVE.test(apiPath)) { if (method !== "GET") this.cache.clear(); return this.counted(method, apiPath, body, opts); }
    const hit = this.cache.get(apiPath);
    if (hit && !process.env.CADFORME_NO_CACHE && (hit.pending || (!opts.fresh && Date.now() - hit.at < CACHE_MS))) { bump("cached"); return hit.pending ? hit.pending.then(structuredClone) : Promise.resolve(structuredClone(hit.value)); }
    const pending = this.counted(method, apiPath, body, opts).then(
      (value) => { this.cache.set(apiPath, { at: Date.now(), value }); return value; },
      (e) => { this.cache.delete(apiPath); throw e; });
    this.cache.set(apiPath, { pending, at: Date.now() });
    return pending.then(structuredClone);
  }
  /** Onshape rate-limits per kind of call ("GET /metadata"), and a 402 means the account's allowance is used up. */
  static kind(method, apiPath) { return `${method} ${apiPath.split("/")[1] ?? ""}`; }
  async counted(method, apiPath, body, opts) {
    this.locks ??= new Map();
    const kind = OnshapeClient.kind(method, apiPath);
    for (const k of ["*", kind]) { const l = this.locks.get(k); if (l && l.until > Date.now()) throw l.error; }
    for (let attempt = 1; ; attempt++) {
      const gate = (this.gate ?? 0) - Date.now();   // another call just hit a short burst limit: everyone waits it out
      if (gate > 0) await sleep(gate);
      bump("calls");
      try { return await this.rawReq(method, apiPath, body, opts); }
      catch (e) {
        if (e.status === 402) this.locks.set("*", { until: Date.now() + 3600e3, error: e });   // re-checked after an hour (long-running servers)
        if (e.status === 429 && e.retryAfter) this.locks.set(kind, { until: Date.now() + e.retryAfter * 1000, error: e });
        const transient = e.status >= 500 || (e.status === undefined && !(e instanceof OnshapeError));
        if (!transient || method !== "GET" || attempt >= 3) throw e;   // writes aren't repeated: they may have gone through
        await sleep(1000 * attempt);
      }
    }
  }

  async rawReq(method, path, body, { tries = 3 } = {}) {
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) bump("calls");
      const res = await this.f(`${this.base}${API}${path}`, {
        method, headers: { Authorization: this.auth, Accept: "application/json;charset=UTF-8; qs=0.09", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429) {
        const wait = Number(res.headers?.get?.("retry-after") ?? 0);
        // a short wait is a burst limit: try again. A long one (hours) is Onshape's daily allowance for this kind of call: say so
        if (wait > 60) { const e = new OnshapeError(`Onshape has paused this kind of request for ${wait >= 5400 ? `${Math.round(wait / 3600)} hours` : `${Math.ceil(wait / 60)} minutes`} (its rate limit for your account). Try again then; other kinds of request still work`, 429); e.retryAfter = wait; throw e; }
        if (attempt < tries) { const ms = Math.max(1500 * attempt, wait * 1000); this.gate = Date.now() + ms; await sleep(ms); continue; }
      }
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (res.ok) return json ?? {};
      const why = json?.message ?? json?.error ?? text.slice(0, 200);
      if (res.status === 401) throw new OnshapeError("Onshape rejected your API keys (401). Check the access and secret keys", 401);
      if (res.status === 403) throw new OnshapeError(`Onshape says you don't have permission (403). ${why}`, 403);
      if (res.status === 404) throw new OnshapeError("Onshape couldn't find that document or tab (404). Check the link and your access to it", 404);
      throw new OnshapeError(`Onshape error ${res.status}: ${why}`, res.status);
    }
  }

  ps(ref) { return `/partstudios/d/${ref.did}/${ref.wvm ?? "w"}/${ref.wid}/e/${ref.eid}`; }

  /** fresh: skip the read cache (use it before anything that must see Onshape's latest state, like a pull or a real push). */
  async getFeatures(ref, { fresh = false } = {}) {
    const r = await this.req("GET", `${this.ps(ref)}/features`, undefined, { fresh });
    return { features: r.features ?? [], microversion: r.sourceMicroversion ?? null, states: r.featureStates ?? {} };
  }
  addFeature(ref, feature) { return this.req("POST", `${this.ps(ref)}/features`, { btType: "BTFeatureDefinitionCall-1406", feature }); }
  updateFeature(ref, fid, feature) { return this.req("POST", `${this.ps(ref)}/features/featureid/${encodeURIComponent(fid)}`, { btType: "BTFeatureDefinitionCall-1406", feature: { ...feature, featureId: fid } }); }
  deleteFeature(ref, fid) { return this.req("DELETE", `${this.ps(ref)}/features/featureid/${encodeURIComponent(fid)}`); }
  createDocument(name) { return this.req("POST", "/documents", { name, isPublic: false }); }
  createPartStudio(did, wid, name) { return this.req("POST", `/partstudios/d/${did}/w/${wid}`, { name }); }
  getDocument(did) { return this.req("GET", `/documents/${did}`); }
  listVersions(did) { return this.req("GET", `/documents/d/${did}/versions`); }
  createVersion(did, wid, name, description = "") { return this.req("POST", `/documents/d/${did}/versions`, { name, description, documentId: did, workspaceId: wid }); }
  listWorkspaces(did) { return this.req("GET", `/documents/d/${did}/workspaces`); }
  createWorkspace(did, name, parentId) { return this.req("POST", `/documents/d/${did}/workspaces`, { name, parentId }); }
  evalFeatureScript(ref, script) { return this.req("POST", `${this.ps(ref)}/featurescript`, { script, queries: {} }); }
  getPartMetadata(ref, pid) { return this.req("GET", `/metadata/d/${ref.did}/w/${ref.wid}/e/${ref.eid}/p/${encodeURIComponent(pid)}`); }
  setPartMetadata(ref, pid, properties) { return this.req("POST", `/metadata/d/${ref.did}/w/${ref.wid}/e/${ref.eid}/p/${encodeURIComponent(pid)}`, { properties }); }
  listElements(did, wid) { return this.req("GET", `/documents/d/${did}/w/${wid}/elements`); }
  // Assemblies
  asm(ref) { return `/assemblies/d/${ref.did}/w/${ref.wid}/e/${ref.eid}`; }
  createAssembly(did, wid, name) { return this.req("POST", `/assemblies/d/${did}/w/${wid}`, { name }); }
  getAssembly(ref) { return this.req("GET", this.asm(ref)); }
  insertPartStudio(asmRef, ps) { return this.req("POST", `${this.asm(asmRef)}/instances`, { documentId: ps.did, elementId: ps.eid, isWholePartStudio: true, includePartTypes: ["PARTS"] }); }
  deleteInstance(asmRef, nodeId) { return this.req("DELETE", `${this.asm(asmRef)}/instance/nodeid/${encodeURIComponent(nodeId)}`); }
  /** Upload a CAD file (STEP etc.) into the document the way Onshape's Import does, translated into Part Studio / Assembly tabs. */
  async translateFile(did, wid, { name, bytes, flattenAssemblies = false, options = {} }) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    form.append("encodedFilename", name); form.append("translate", "true"); form.append("formatName", "STEP");
    form.append("flattenAssemblies", String(flattenAssemblies)); form.append("yAxisIsUp", "false"); form.append("allowFaultyParts", "true");
    for (const [k, v] of Object.entries(options)) form.append(k, String(v));   // e.g. locationGroupId (a tab folder), importAppearances
    const res = await this.f(`${this.base}${API}/blobelements/d/${did}/w/${wid}`, { method: "POST", headers: { Authorization: this.auth, Accept: "application/json;charset=UTF-8; qs=0.09" }, body: form });
    const text = await res.text();
    if (!res.ok) throw new OnshapeError(`Onshape couldn't take the file (${res.status}): ${text.slice(0, 200)}`, res.status);
    return JSON.parse(text);
  }
  /** Ask Onshape to export a tab (assembly or part studio) as STEP; returns the translation record to poll. */
  exportStep(ref, kind) {
    const base = kind === "ASSEMBLY" ? `/assemblies/d/${ref.did}/${ref.wvm ?? "w"}/${ref.wid}/e/${ref.eid}` : this.ps(ref);
    return this.req("POST", `${base}/translations`, { formatName: "STEP", storeInDocument: false, flattenAssemblies: false, yAxisIsUp: false });
  }
  async downloadExternal(did, id) {
    const res = await this.f(`${this.base}${API}/documents/d/${did}/externaldata/${id}`, { headers: { Authorization: this.auth, Accept: "application/octet-stream" } });
    if (!res.ok) throw new OnshapeError(`Onshape wouldn't hand over the exported file (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
  /** Wait for a translation. Starts at 2 s and slows to `maxMs` between checks, so a long job costs tens of calls, not hundreds. */
  async waitTranslation(id, first = { requestState: "ACTIVE" }, { maxMs = 15000, limitMs = 2 * 3600e3, onState = () => {} } = {}) {
    let st = first;
    for (let wait = 2000, t0 = Date.now(); !["DONE", "FAILED"].includes(st.requestState); wait = Math.min(maxMs, Math.round(wait * 1.5))) {
      if (Date.now() - t0 > limitMs) throw new OnshapeError("Onshape is still working on it; check the document later");
      await sleep(wait);
      st = await this.getTranslation(id);
      onState(st.requestState);
    }
    return st;
  }
  getTranslation(id) { return this.req("GET", `/translations/${id}`); }
  insertAssembly(asmRef, src) { return this.req("POST", `${this.asm(asmRef)}/instances`, { documentId: src.did, elementId: src.eid, isAssembly: true }); }
  insertPartStudioElement(asmRef, src) { return this.req("POST", `${this.asm(asmRef)}/instances`, { documentId: src.did, elementId: src.eid, isWholePartStudio: true, includePartTypes: ["PARTS"] }); }
  transformOccurrences(asmRef, body) { return this.req("POST", `${this.asm(asmRef)}/occurrencetransforms`, body); }
  addAssemblyFeature(asmRef, feature) { return this.req("POST", `${this.asm(asmRef)}/features`, { feature }); }
}
