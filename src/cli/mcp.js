// MCP server (stdio, JSON-RPC 2.0) so Claude Code and the Claude desktop app can drive cadForMe: read and write parts,
// look at the image references, run the design check, fix import names, open the window, import Onshape documents, push/pull, and make releases.
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
  const dirOf = (args) => core.ensureProject(core.projectDir(args?.project ?? project ?? process.env.CADFORME_PROJECT));
  const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });
  const TOOLS = [
    { name: "list_projects", description: "List the projects (folders in projects/ of the cadForMe repo) and which one is current. Tools without a `project` argument work on the current project.", schema: {},
      run: () => text({ folder: core.PROJECTS_DIR, projects: core.listProjects().map(({ name, parts, current }) => ({ name, parts, ...(current ? { current } : {}) })) }) },
    { name: "new_project", description: "Create a new project folder in projects/ and make it the current project. Start one for each new design.", schema: { name: { type: "string" } }, required: ["name"],
      run: (a) => text(`Created project ${core.createProject(a.name)}; it is now the current project.`) },
    { name: "use_project", description: "Make an existing project the current one.", schema: { name: { type: "string" } }, required: ["name"],
      run: (a) => { const dir = core.projectDir(a.name); if (!fs.existsSync(dir)) throw new Error(`No project "${a.name}". Projects: ${core.listProjects().map((p) => p.name).join(", ") || "none yet"}`); core.setCurrentProject(dir); return text(`Current project: ${dir}`); } },
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
    { name: "onshape_connect", description: "Save the user's Onshape API keys (verified with Onshape first; stored in apikeys.json in the repo root, which is gitignored and blocked from commits). Give accessKey and secretKey exactly as the user pasted them. Never repeat the keys back. Alternatively the user can set ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY.", schema: { accessKey: { type: "string" }, secretKey: { type: "string" }, baseUrl: { type: "string", description: "Only for Onshape enterprise accounts" } }, required: ["accessKey", "secretKey"],
      run: async (a) => text(`Connected to Onshape as ${(await core.connectOnshape(a)).user || "your account"}. Keys saved in apikeys.json (gitignored).`) },
    { name: "onshape_status", description: "Whether Onshape keys are available, and which Onshape parts are linked in the project.", schema: {},
      run: (a) => { const dir = dirOf(a); return text({ connected: !!core.loadKeys(), linkedParts: core.linkedParts(dir).map((p) => ({ part: p.rel, document: p.link.did })) }); } },
    { name: "onshape_import", description: "Import an Onshape document from its link into its own project, projects/<document name> (made current; pass `project` to import into an existing one instead): every Part Studio becomes an editable part (all sketches, constraints, dimensions, variables, planes, extrudes, fillets, chamfers, shells) and every Assembly comes in as geometry. Onshape features cadForMe can't edit are kept as untouched placeholders and listed. A link to one tab imports just that tab. Already-imported parts are skipped.", schema: { url: { type: "string" } }, required: ["url"],
      run: async (a) => text(core.importReport(a.project ? await core.importOnshape(dirOf(a), a.url) : await core.importOnshapeProject(a.url))) },
    { name: "step_to_assembly", description: "Rebuild a big flat STEP export (one body per copy, no structure) as a real STEP assembly: identical bodies become one part used many times, bodies named \"Group: part\" become subassemblies, names and colours kept, and every body is checked against the original. Writes exports/<name>-assembly.step in the project. `groups` adds keyword subassemblies, e.g. {\"Transfer\": \"\\\\btransfer\\\\b\"}. First run sets up OpenCascade for Python (needs python3).", schema: { file: { type: "string", description: "Path of the STEP file" }, groups: { type: "object" } }, required: ["file"],
      run: async (a) => { const { stepToAssembly, stepAssemblyReport } = await import("./stepasm.js"); return text(stepAssemblyReport(await stepToAssembly(dirOf(a), a.file, { groups: a.groups }))); } },
    { name: "onshape_upload_step", description: "Import a STEP assembly (e.g. from step_to_assembly) into an Onshape document from its link: Onshape makes an Assembly per (sub)assembly and a Part Studio with the parts, appearances kept. Name clashes like \"Robot (1)\" are renamed back when the plain name is free. `folder` names an existing tab folder to try to put the tabs in (the API can't create folders). Adds ~10 tabs to that document, so confirm the document with the user first.", schema: { file: { type: "string" }, url: { type: "string" }, folder: { type: "string" } }, required: ["file", "url"],
      run: async (a) => { const dir = dirOf(a); return text(core.uploadReport(await core.uploadStepAssembly(dir, a.file, a.url, { folder: a.folder }))); } },
    { name: "onshape_push", description: "Send a part to its linked Onshape Part Studio as native, editable features (sketches, extrudes, booleans...). preview=true only lists what would change.", schema: { part: { type: "string" }, preview: { type: "boolean" } }, required: ["part"],
      run: async (a) => { const dir = dirOf(a); return text(await core.pushPart(dir, core.resolvePart(dir, a.part), { preview: !!a.preview })); } },
    { name: "onshape_pull", description: "Bring edits made in Onshape back into a linked part (3-way merge).", schema: { part: { type: "string" } }, required: ["part"],
      run: async (a) => { const dir = dirOf(a); return text(await core.pullPart(dir, core.resolvePart(dir, a.part))); } },
    { name: "release", description: "Make a release: a named Onshape version (a frozen snapshot, restorable in Onshape) described by what changed here since the previous release. Push first so Onshape is up to date. This replaces git for tracking changes.", schema: { name: { type: "string" } },
      run: async (a) => { const e = await core.makeRelease(dirOf(a), a.name); return text(`Release "${e.name}" created in Onshape.\n${e.url}\n\n${e.changes.length ? e.changes.join("\n") : "No changes since the previous release"}`); } },
    { name: "releases", description: "List the releases (Onshape versions) of the linked document, newest first, with what changed in each.", schema: {},
      run: async (a) => text((await core.releases(dirOf(a))).map((r) => `${r.name}  ${r.at}${r.by ? `  by ${r.by}` : ""}\n${r.description ? r.description.split("\n").map((l) => `    ${l}`).join("\n") : "    (no description)"}`).join("\n\n") || "No releases yet") },
  ];
  const projectArg = { project: { type: "string", description: "Project name (a folder in projects/) or a folder path. Default: the current project (see list_projects)" } };
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
