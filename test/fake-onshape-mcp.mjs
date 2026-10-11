// A tiny stand-in for an Onshape MCP server (stdio JSON-RPC): answers onshape_request from a table, logs calls to a file.
import fs from "node:fs";
import readline from "node:readline";
const log = process.env.FAKE_LOG;
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const reply = (id, json, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(json) }], ...(isError ? { isError: true } : {}) } });
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-onshape", version: "0" } } });
  if (m.method !== "tools/call") return;
  const { name, arguments: a } = m.params;
  if (log) fs.appendFileSync(log, `${JSON.stringify({ name, ...a })}\n`);
  if (name !== "onshape_request") return reply(m.id, { ok: false, error: `unknown tool ${name}` }, true);
  if (a.path.endsWith("/limited")) return reply(m.id, { ok: false, error: "Onshape error 429: Too many requests." }, true);
  if (a.path.endsWith("/paid")) return reply(m.id, { ok: false, error: "Onshape error 402: API limit exceeded" }, true);
  if (a.path.endsWith("/missing")) return reply(m.id, { ok: false, status: 404, error: "not found" }, true);
  if (a.path.endsWith("/features") && a.method === "POST") return reply(m.id, { ok: true, result: { status: 200, response: { echo: a.body } } });
  if (a.path.endsWith("/list")) return reply(m.id, { ok: true, result: { status: 200, response: [{ id: "e1" }, { id: "e2" }] } });
  reply(m.id, { ok: true, result: { status: 200, response: { path: a.path, params: a.params ?? null } } });
});
