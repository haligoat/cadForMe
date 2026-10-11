// Remotes: where a team's commits are shared.
// A remote stores refs (branch -> commit id, updated with compare-and-swap so nobody can
// silently overwrite a teammate's push) and immutable "packs" (a bundle of new commits + files).
import fs from "node:fs";
import path from "node:path";

export class RemoteConflict extends Error {}

const enc = (b) => b.replaceAll("/", "~");
const dec = (b) => b.replaceAll("~", "/");
const PACK_RE = /^[0-9a-f]{40}$/;

/** A plain folder (iCloud / Dropbox / network drive / local path). Also used in tests. */
export class FolderRemote {
  constructor(dir) { this.dir = dir; }
  _p(...s) { return path.join(this.dir, ...s); }
  async listBranches() {
    const d = this._p("refs");
    if (!fs.existsSync(d)) return {};
    return Object.fromEntries(fs.readdirSync(d).map((f) => [dec(f), fs.readFileSync(path.join(d, f), "utf8").trim()]));
  }
  async getRef(branch) { return (await this.listBranches())[branch] ?? null; }
  async setRef(branch, next, expected) {
    const cur = await this.getRef(branch);
    if ((cur ?? null) !== (expected ?? null)) throw new RemoteConflict("Someone pushed to this branch first. Pull their changes, then push again");
    fs.mkdirSync(this._p("refs"), { recursive: true });
    fs.writeFileSync(this._p("refs", enc(branch)), next);
  }
  async listPacks() {
    const d = this._p("packs");
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => PACK_RE.test(f)) : [];
  }
  async getPack(id) { return fs.readFileSync(this._p("packs", id)); }
  async putPack(id, buf) {
    fs.mkdirSync(this._p("packs"), { recursive: true });
    fs.writeFileSync(this._p("packs", id), buf);
  }
}

/** A GitHub repository used as storage, via the REST contents API. Needs a personal access token. */
export class GitHubRemote {
  constructor({ repo, token, fetch: f = globalThis.fetch, prefix = "cadslop", api = "https://api.github.com" }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" isn't a GitHub repo (use owner/name)`);
    if (!token) throw new Error("Add your GitHub token first (Settings → GitHub)");
    Object.assign(this, { repo, token, f, prefix, api, shas: new Map() });
  }
  _url(...s) { return `${this.api}/repos/${this.repo}/contents/${[this.prefix, ...s].join("/")}`; }
  async _req(url, { method = "GET", body, raw } = {}) {
    const res = await this.f(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cadSlop",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new Error("GitHub rejected the token (401). Check it hasn't expired");
    if (res.status === 403 || res.status === 429) throw new Error(`GitHub is rate limiting or blocking this request (${res.status}). Wait a minute and retry, and make sure the token has Contents: read & write`);
    return res;
  }
  async listBranches() {
    const res = await this._req(this._url("refs"));
    if (res.status === 404) {
      const probe = await this._req(`${this.api}/repos/${this.repo}`);
      if (probe.status === 404) throw new Error(`Repository ${this.repo} not found, or your token can't access it`);
      return {};
    }
    const entries = await res.json();
    const out = {};
    for (const e of entries.filter((x) => x.type === "file")) {
      const r = await this._req(e.url, {});
      const j = await r.json();
      out[dec(e.name)] = Buffer.from(j.content, "base64").toString("utf8").trim();
      this.shas.set(dec(e.name), j.sha);
    }
    return out;
  }
  async getRef(branch) {
    const res = await this._req(this._url("refs", enc(branch)));
    if (res.status === 404) { this.shas.delete(branch); return null; }
    const j = await res.json();
    this.shas.set(branch, j.sha);
    return Buffer.from(j.content, "base64").toString("utf8").trim();
  }
  async setRef(branch, next, expected) {
    if (expected) await this.getRef(branch); else this.shas.delete(branch);
    const body = { message: `cadSlop: update ${branch}`, content: Buffer.from(next).toString("base64") };
    if (expected) body.sha = this.shas.get(branch);
    const res = await this._req(this._url("refs", enc(branch)), { method: "PUT", body });
    if (res.status === 409 || res.status === 422) throw new RemoteConflict("Someone pushed to this branch first. Pull their changes, then push again");
    if (!res.ok) throw new Error(`GitHub error ${res.status} while updating ${branch}`);
    this.shas.set(branch, (await res.json()).content.sha);
  }
  async listPacks() {
    const res = await this._req(this._url("packs"));
    if (res.status === 404) return [];
    return (await res.json()).filter((e) => PACK_RE.test(e.name)).map((e) => e.name);
  }
  async getPack(id) {
    const res = await this._req(this._url("packs", id), { raw: true });
    if (!res.ok) throw new Error(`Couldn't download pack ${id} (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  async putPack(id, buf) {
    const res = await this._req(this._url("packs", id), { method: "PUT", body: { message: "cadSlop: push", content: buf.toString("base64") } });
    if (res.status === 422) return; // identical pack already uploaded
    if (res.status === 404) throw new Error(`Repository ${this.repo} not found, or your token can't write to it`);
    if (!res.ok) throw new Error(`GitHub error ${res.status} while uploading`);
  }
}

export function parseRemote(spec, { token, fetch } = {}) {
  if (spec?.startsWith("github:")) return new GitHubRemote({ repo: spec.slice(7), token, fetch });
  if (spec?.startsWith("folder:")) return new FolderRemote(spec.slice(7));
  throw new Error(`Unknown remote "${spec}". Use github:owner/repo or folder:/path`);
}
