import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpConnection, McpOnshapeClient, mcpServerConfig } from "../src/onshape/mcp.js";
import { OnshapeClient, OnshapeError } from "../src/onshape/client.js";
import { osClient, onshapeMode, closeOnshape } from "../src/cli/core.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-onshape-mcp.mjs");
const start = (env = {}) => { const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-")), "calls.jsonl"); const conn = new McpConnection({ command: process.execPath, args: [FAKE], env: { FAKE_LOG: log, ...env } }); return { conn, client: new McpOnshapeClient(conn), calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [] }; };

test("requests go through the server's raw-request tool with the API prefix, query string as params, and the reply body back", async () => {
  const { conn, client, calls } = start();
  try {
    assert.deepEqual(await client.req("GET", "/partstudios/d/D/w/W/e/E/massproperties?massAsGroup=false"), { path: "/api/v9/partstudios/d/D/w/W/e/E/massproperties", params: { massAsGroup: "false" } });
    assert.deepEqual(await client.req("GET", "/documents/list"), [{ id: "e1" }, { id: "e2" }]);
    assert.deepEqual(await client.req("POST", "/partstudios/d/D/w/W/e/E/features", { feature: { btType: "BTMSketch-151" } }), { echo: { feature: { btType: "BTMSketch-151" } } });
    assert.deepEqual(calls().map((c) => c.method), ["GET", "GET", "POST"]);
    assert.equal(calls()[2].path, "/api/v9/partstudios/d/D/w/W/e/E/features");
  } finally { conn.close(); }
});

test("the server is started once and reused", async () => {
  const { conn, client } = start(); let spawns = 0;
  const real = conn.spawnFn; conn.spawnFn = (...a) => { spawns++; return real(...a); };
  try { await Promise.all([client.req("GET", "/a"), client.req("GET", "/b"), client.req("GET", "/c")]); assert.equal(spawns, 1); } finally { conn.close(); }
});

test("failures become OnshapeError with the status: 429, 402 (plan limit) and 404", async () => {
  const { conn, client } = start();
  try {
    await assert.rejects(client.req("GET", "/limited"), (e) => e instanceof OnshapeError && e.status === 429);
    await assert.rejects(client.req("GET", "/paid"), (e) => e.status === 402 && /API limit/.test(e.message));
    await assert.rejects(client.req("GET", "/missing"), (e) => e.status === 404 && /couldn't find/.test(e.message));
  } finally { conn.close(); }
});

test("a server that can't start gives a clear error", async () => {
  const conn = new McpConnection({ command: "/definitely/not/a/command" });
  await assert.rejects(new McpOnshapeClient(conn).req("GET", "/x"), /Couldn't start the Onshape MCP server/);
});

test("file uploads need API keys; with keys saved they use them", async () => {
  const { conn, client } = start();
  try {
    assert.throws(() => client.translateFile("d", "w", { name: "a.step", bytes: new Uint8Array() }), /MCP server can't do uploading a file/);
    const keyed = { translateFile: () => "uploaded" }; client.fallback = keyed;
    assert.equal(client.translateFile(), "uploaded");
  } finally { conn.close(); }
});

test("the server comes from CADFORME_ONSHAPE_MCP or the onshape entry of .mcp.json, and decides mcp vs keys", () => {
  assert.deepEqual(mcpServerConfig("/nowhere", { CADFORME_ONSHAPE_MCP: 'node "/a b/s.mjs" --x' }), { command: "node", args: ["/a b/s.mjs", "--x"] });
  assert.equal(mcpServerConfig("/nowhere", {}), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcpjson-")); fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { onshape: { command: "npx", args: ["-y", "x"] } } }));
  assert.deepEqual(mcpServerConfig(root, {}), { command: "npx", args: ["-y", "x"], env: undefined });
  const save = { ...process.env }; try {
    process.env.CADFORME_ONSHAPE = "keys"; process.env.ONSHAPE_ACCESS_KEY = "a"; process.env.ONSHAPE_SECRET_KEY = "b";
    assert.equal(onshapeMode(), "keys"); assert.ok(osClient() instanceof OnshapeClient && !osClient().viaMcp);
    process.env.CADFORME_ONSHAPE = "mcp"; process.env.CADFORME_ONSHAPE_MCP = `${process.execPath} ${FAKE}`;
    const c = osClient(); assert.ok(c.viaMcp); assert.equal(c.fallback instanceof OnshapeClient, true, "saved keys stay as the fallback"); closeOnshape();
  } finally { for (const k of ["CADFORME_ONSHAPE", "ONSHAPE_ACCESS_KEY", "ONSHAPE_SECRET_KEY", "CADFORME_ONSHAPE_MCP"]) { if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k]; } }
});
