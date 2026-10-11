// Minimal Onshape REST client (API key auth over HTTPS).
const API = "/api/v9";

export function parseOnshapeUrl(link) {
  const m = String(link).match(/documents\/([0-9a-f]{24})\/([wvm])\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i);
  if (!m) throw new Error("That doesn't look like an Onshape Part Studio link. Open the Part Studio tab in Onshape and copy the address bar URL");
  return { did: m[1], wvm: m[2].toLowerCase(), wid: m[3], eid: m[4] };
}

export class OnshapeError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export class OnshapeClient {
  constructor({ accessKey, secretKey, baseUrl = "https://cad.onshape.com", fetch: f = globalThis.fetch }) {
    if (!accessKey || !secretKey) throw new Error("Add your Onshape API keys first (Onshape button → Connect)");
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") throw new Error("The Onshape address must use https so your keys stay private");
    Object.assign(this, { base: u.origin, f, auth: `Basic ${Buffer.from(`${accessKey}:${secretKey}`).toString("base64")}` });
  }

  async req(method, path, body, { tries = 3 } = {}) {
    for (let attempt = 1; ; attempt++) {
      const res = await this.f(`${this.base}${API}${path}`, {
        method, headers: { Authorization: this.auth, Accept: "application/json;charset=UTF-8; qs=0.09", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && attempt < tries) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
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

  async getFeatures(ref) {
    const r = await this.req("GET", `${this.ps(ref)}/features`);
    return { features: r.features ?? [], microversion: r.sourceMicroversion ?? null, states: r.featureStates ?? {} };
  }
  addFeature(ref, feature) { return this.req("POST", `${this.ps(ref)}/features`, { btType: "BTFeatureDefinitionCall-1406", feature }); }
  updateFeature(ref, fid, feature) { return this.req("POST", `${this.ps(ref)}/features/featureid/${encodeURIComponent(fid)}`, { btType: "BTFeatureDefinitionCall-1406", feature: { ...feature, featureId: fid } }); }
  deleteFeature(ref, fid) { return this.req("DELETE", `${this.ps(ref)}/features/featureid/${encodeURIComponent(fid)}`); }
  createDocument(name) { return this.req("POST", "/documents", { name, isPublic: false }); }
  createPartStudio(did, wid, name) { return this.req("POST", `/partstudios/d/${did}/w/${wid}`, { name }); }
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
  async translateFile(did, wid, { name, bytes, flattenAssemblies = false }) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    form.append("encodedFilename", name); form.append("translate", "true"); form.append("formatName", "STEP");
    form.append("flattenAssemblies", String(flattenAssemblies)); form.append("yAxisIsUp", "false"); form.append("allowFaultyParts", "true");
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
  getTranslation(id) { return this.req("GET", `/translations/${id}`); }
  insertAssembly(asmRef, src) { return this.req("POST", `${this.asm(asmRef)}/instances`, { documentId: src.did, elementId: src.eid, isAssembly: true }); }
  insertPartStudioElement(asmRef, src) { return this.req("POST", `${this.asm(asmRef)}/instances`, { documentId: src.did, elementId: src.eid, isWholePartStudio: true, includePartTypes: ["PARTS"] }); }
  transformOccurrences(asmRef, body) { return this.req("POST", `${this.asm(asmRef)}/occurrencetransforms`, body); }
  addAssemblyFeature(asmRef, feature) { return this.req("POST", `${this.asm(asmRef)}/features`, { feature }); }
}
