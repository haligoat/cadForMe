// Talk to Onshape through an Onshape MCP server instead of holding API keys here. cadForMe still does all the modelling
// (parts -> sketches, extrudes, booleans... in map.js / nativize.js) and builds the Onshape feature JSON itself; this only
// carries each request to the document. McpOnshapeClient has the same methods as OnshapeClient, so push, pull, import,
// releases and the assembly tools work unchanged; its `req` goes through the server's raw-request tool.
//
// Server: @gpambrozio/onshape-mcp (`npx -y @gpambrozio/onshape-mcp`, MIT). It signs in with the browser on first use and keeps
// the credentials itself (OS keychain), so no keys are saved in this repo. Listed in .mcp.json as "onshape"; any server with an
// `onshape_request` tool (method, path, body) works. File uploads aren't offered by MCP servers: those use API keys if saved.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OnshapeClient, OnshapeError } from "./client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = "/api/v9";
const PROTOCOL = "2025-06-18";

/** The Onshape MCP server to use: CADFORME_ONSHAPE_MCP (a command line), else the "onshape" entry of .mcp.json, else null. */
export function mcpServerConfig(root = ROOT, env = process.env) {
  if (env.CADFORME_ONSHAPE_MCP) { const [command, ...args] = env.CADFORME_ONSHAPE_MCP.match(/"[^"]*"|\S+/g).map((s) => s.replace(/^"|"$/g, "")); return { command, args }; }
  try { const s = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers?.onshape; return s?.command ? { command: s.command, args: s.args ?? [], env: s.env } : null; } catch { return null; }
}

/** One running MCP server over stdio (newline-delimited JSON-RPC), started on first use and reused. */
export class McpConnection {
  constructor({ command, args = [], env = {}, spawnFn = spawn, timeoutMs = 10 * 60e3 }) { Object.assign(this, { command, args, env, spawnFn, timeoutMs, child: null, ready: null, pending: new Map(), seq: 0 }); }

  start() {
    this.ready ??= new Promise((resolve, reject) => {
      const child = this.spawnFn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.env } });
      this.child = child;
      let err = "";
      child.on("error", (e) => { reject(new OnshapeError(`Couldn't start the Onshape MCP server (${this.command}): ${e.message}. Needs Node 20+ and internet the first time`)); this.failAll(e); });
      child.stderr?.on("data", (d) => { err = (err + d).slice(-400); });
      child.on("close", () => this.failAll(new Error(`The Onshape MCP server stopped. ${err.trim()}`)));
      readline.createInterface({ input: child.stdout }).on("line", (l) => {
        let m; try { m = JSON.parse(l); } catch { return; }   // log lines
        const p = m.id !== undefined && this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new OnshapeError(m.error.message ?? "MCP error")) : p.resolve(m.result); }
      });
      this.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "cadforme", version: "1" } })
        .then(() => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); resolve(); }, reject);
    });
    return this.ready;
  }
  failAll(e) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); this.ready = null; }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new OnshapeError(`The Onshape MCP server didn't answer ${method} in time`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  /** Call a tool; returns its JSON reply ({ ok, ... }). Tool-level failures come back as ok:false with an error text. */
  async call(name, args) {
    await this.start();
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let json = null; try { json = JSON.parse(text); } catch { /* plain text */ }
    return { isError: !!r.isError, json, text };
  }
  close() { try { this.child?.stdin.end(); this.child?.kill(); } catch { /* gone */ } this.ready = null; }
}

/** Turn a failed tool reply into an OnshapeError that carries the HTTP status when the text has one. */
function toError({ json, text }) {
  const msg = String(json?.error ?? json?.message ?? text ?? "Onshape request failed");
  const status = Number(json?.status ?? json?.statusCode ?? msg.match(/\b(401|402|403|404|409|429|500)\b/)?.[1]) || undefined;
  if (status === 404) return new OnshapeError("Onshape couldn't find that document or tab (404). Check the link and your access to it", 404);
  if (status === 402) return new OnshapeError("Onshape says the API limit for this account is used up (402). Try again after it resets, or ask Onshape support to raise it", 402);
  return new OnshapeError(msg, status);
}

export class McpOnshapeClient extends OnshapeClient {
  /** @param {McpConnection} conn  @param {{ fallback?: OnshapeClient }} opts a key-based client for the calls MCP can't make (file upload) */
  constructor(conn, { fallback = null } = {}) { super({ accessKey: "mcp", secretKey: "mcp" }); Object.assign(this, { conn, fallback, viaMcp: true }); }

  async req(method, apiPath, body) {
    const [p, qs] = apiPath.split("?");
    const params = qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined;
    const r = await this.conn.call("onshape_request", { method, path: `${API}${p}`, ...(params ? { params } : {}), ...(body ? { body } : {}) });
    if (r.isError || r.json?.ok === false) throw toError(r);
    const j = r.json;
    // the server wraps replies as { ok, result: { status, response } } (older/other servers: { ok, response })
    if (j && typeof j === "object" && !Array.isArray(j)) return j.result?.response ?? j.response ?? j.result?.body ?? j.body ?? j.data ?? (j.ok === true ? (j.result ?? {}) : j);
    return j ?? {};
  }
  translateFile(...a) { return this.#needKeys("uploading a file").translateFile(...a); }
  downloadExternal(...a) { return this.#needKeys("downloading an export").downloadExternal(...a); }
  #needKeys(what) {
    if (this.fallback) return this.fallback;
    throw new OnshapeError(`The Onshape MCP server can't do ${what}. Import the STEP file in the Onshape web app, or save API keys (cadforme connect) for this one step`);
  }
  close() { this.conn.close(); }
}
