// MCP server (stdio, JSON-RPC 2.0) so Claude Code and the Claude desktop app can drive cadForMe: read and write parts,
// look at the image references, run the design check, fix import names, open the window, and send parts to Onshape.
// Start it with `cadforme mcp` (see .mcp.json and the README for the desktop app's config).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as core from "./core.js";

const PROTOCOL = "2025-06-18";

export async function serveMcp({ project } = {}) {
  // stdout carries the protocol only; anything else that prints (the geometry kernel) goes to stderr
  const out = process.stdout.write.bind(process.stdout);
  console.log = console.info = console.warn = (...a) => process.stderr.write(`${a.join(" ")}\n`);
  const dirOf = (args) => core.ensureProject(args?.project ?? project ?? process.env.CADFORME_PROJECT ?? core.DEFAULT_PROJECT);
  const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });
  const TOOLS = [
    { name: "list_parts", description: "List the part files in the cadForMe project, with each part's name.", schema: {},
      run: (a) => { const dir = dirOf(a); return text({ project: dir, parts: core.listParts(dir).map((p) => ({ part: p, name: core.readPart(dir, p).name ?? null })) }); } },
    { name: "get_format", description: "The cadForMe part file format and modelling rules. Read this before writing a part.", schema: {},
      run: () => text(fs.readFileSync(path.join(core.ROOT, "docs", "FORMAT.md"), "utf8")) },
    { name: "read_part", description: "Read a part file (JSON). `part` is a name like \"bracket\" or a path like parts/bracket.part.json.", schema: { part: { type: "string" } }, required: ["part"],
      run: (a) => { const dir = dirOf(a); const rel = core.resolvePart(dir, a.part); return text(fs.readFileSync(path.join(dir, rel), "utf8")); } },
    { name: "write_part", description: "Create or replace a part file. `part` is a name (saved as parts/<name>.part.json) or path; `json` is the whole part as a JSON string. Model with dimensioned sketches + extrudes (cuts for holes) and only a few variables. The design check runs on it afterwards.", schema: { part: { type: "string" }, json: { type: "string" } }, required: ["part", "json"],
      run: async (a) => {
        const dir = dirOf(a);
        let rel; try { rel = core.resolvePart(dir, a.part); } catch { rel = a.part.endsWith(".part.json") ? a.part : `parts/${a.part.replace(/[^\w.-]+/g, "-")}.part.json`; }
        core.writePart(dir, rel, JSON.parse(a.json));
        const results = await core.designCheck(dir, [rel]);
        return text(`Saved ${rel}.\n\nDesign check:\n${core.drcReport(results)}`);
      } },
    { name: "design_check", description: "Run the design check (DRC) on parts: build errors, separate pieces, thin spots, screw holes, printer bed fit, variable count, Onshape readiness, interference for assemblies, plus stats (volume, mass, size). Parts that haven't changed since their last check return the saved result without rebuilding.", schema: { parts: { type: "array", items: { type: "string" } }, force: { type: "boolean" } },
      run: async (a) => {
        const dir = dirOf(a);
        const rels = a.parts?.length ? a.parts.map((p) => core.resolvePart(dir, p)) : core.listParts(dir);
        const t0 = Date.now();
        const results = await core.designCheck(dir, rels, { force: !!a.force });
        return text(`${core.drcReport(results)}\n\n${results.filter((r) => !r.skipped).length} checked, ${results.filter((r) => r.skipped).length} unchanged, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      } },
    { name: "list_image_references", description: "List the pictures in the image-references folder (reference photos, sketches, screenshots to model from).", schema: {},
      run: (a) => { const dir = dirOf(a); return text({ folder: core.refsDir(dir), images: core.listRefs(dir).map(({ name, key, bytes }) => ({ name, mention: `@${key}`, kb: Math.round(bytes / 1024) })) }); } },
    { name: "view_image_reference", description: "Look at one picture from the image-references folder (by file name or @name).", schema: { name: { type: "string" } }, required: ["name"],
      run: (a) => {
        const dir = dirOf(a), want = String(a.name).replace(/^@/, "").toLowerCase();
        const r = core.listRefs(dir).find((x) => x.name.toLowerCase() === want || x.key.toLowerCase() === want);
        if (!r) throw new Error(`No image "${a.name}" in ${core.refsDir(dir)}`);
        const img = core.imageForModel(r.path);
        return { content: [{ type: "image", data: img.data, mimeType: img.mimeType }, { type: "text", text: r.name }] };
      } },
    { name: "name_imports", description: "Give a part's imported CAD files conventional names (\"goBILDA 2106-4008-1040 REX shaft 104mm\") from their file and STEP product names. Only automatic names change unless all=true. write=false previews.", schema: { part: { type: "string" }, write: { type: "boolean" }, all: { type: "boolean" } }, required: ["part"],
      run: (a) => { const dir = dirOf(a); return text(core.nameImports(dir, core.resolvePart(dir, a.part), { write: !!a.write, all: !!a.all })); } },
    { name: "open_gui", description: "Open the cadForMe window (3D view, AI panel, image references) on the project, optionally on one part.", schema: { part: { type: "string" } },
      run: (a) => { const dir = dirOf(a); core.openGui(dir, { part: a.part ? core.resolvePart(dir, a.part) : undefined, detach: true }); return text("Opened the cadForMe window."); } },
    { name: "onshape_push", description: "Send a part to its linked Onshape Part Studio as native, editable features (sketches, extrudes, booleans...). preview=true only lists what would change. Uses the Onshape keys saved in the cadForMe app.", schema: { part: { type: "string" }, preview: { type: "boolean" } }, required: ["part"],
      run: async (a) => { const dir = dirOf(a); return text(await core.appCommand(dir, a.preview ? "onshape:preview" : "onshape:push", core.resolvePart(dir, a.part))); } },
    { name: "onshape_pull", description: "Bring edits made in Onshape back into a linked part (3-way merge).", schema: { part: { type: "string" } }, required: ["part"],
      run: async (a) => { const dir = dirOf(a); return text(await core.appCommand(dir, "onshape:pull", core.resolvePart(dir, a.part))); } },
  ];
  const projectArg = { project: { type: "string", description: "Project folder (default: designs/ in the cadForMe repo)" } };
  const list = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: { ...t.schema, ...projectArg }, ...(t.required ? { required: t.required } : {}) } }));

  const reply = (id, result) => out(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const fail = (id, code, message) => out(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { fail(null, -32700, "Parse error"); continue; }
    const { id, method, params } = msg;
    if (id === undefined) continue;   // notifications (initialized, cancelled) need no answer
    try {
      if (method === "initialize") reply(id, { protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "cadforme", version: "0.2.0" } });
      else if (method === "ping") reply(id, {});
      else if (method === "tools/list") reply(id, { tools: list });
      else if (method === "tools/call") {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) { fail(id, -32602, `Unknown tool ${params?.name}`); continue; }
        try { reply(id, await tool.run(params.arguments ?? {})); }
        catch (e) { reply(id, { content: [{ type: "text", text: e.message }], isError: true }); }
      } else fail(id, -32601, `Method not found: ${method}`);
    } catch (e) { fail(id, -32603, e.message); }
  }
}
