#!/usr/bin/env node
// cadforme: open the cadForMe window, or run its tools from a terminal (and as an MCP server for Claude).
import path from "node:path";
import * as core from "../src/cli/core.js";

const HELP = `cadforme [project]                open the window (default project: designs/ in this repo)
cadforme open [part]              open the window on a part
cadforme parts                    list the parts
cadforme drc [part...] [--force]  design check; unchanged parts reuse their last result
cadforme refs                     list the image references
cadforme names <part> [--write]   give imported files conventional names (preview without --write)
cadforme push <part> [--preview]  send a part to its Onshape Part Studio as native features
cadforme pull <part>              bring Onshape edits back into a part
cadforme mcp                      MCP server for Claude Code / the Claude desktop app
Options: --project <folder>       work on another project folder`;

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (f) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const force = flag("--force"), write = flag("--write"), preview = flag("--preview"), all = flag("--all"), json = flag("--json");
const projectOpt = opt("--project");
const COMMANDS = new Set(["open", "parts", "drc", "refs", "names", "push", "pull", "mcp", "help"]);
let cmd = argv[0] && COMMANDS.has(argv[0]) ? argv.shift() : argv[0] === "--help" || argv[0] === "-h" ? "help" : "open";
const dir = () => core.ensureProject(projectOpt ?? (cmd === "open" && argv[0] && !argv[0].endsWith(".part.json") && !core.listParts(core.ensureProject()).some((p) => path.basename(p, ".part.json") === argv[0]) ? argv.shift() : core.DEFAULT_PROJECT));
const secs = (ms) => (ms < 60e3 ? `${(ms / 1000).toFixed(ms < 10e3 ? 1 : 0)} s` : `${Math.floor(ms / 60e3)} min ${Math.round((ms % 60e3) / 1000)} s`);
const tty = process.stderr.isTTY;
const status = (s) => { if (tty) process.stderr.write(`\r\x1b[2K${s}`); };

try {
  switch (cmd) {
    case "help": console.log(HELP); break;
    case "open": {
      const d = dir();
      const part = argv[0] ? core.resolvePart(d, argv[0]) : undefined;
      console.error(`Opening cadForMe on ${d}${part ? ` (${part})` : ""}. Image references: ${core.refsDir(d)}`);
      const child = core.openGui(d, { part });
      child.on("close", (code) => process.exit(code ?? 0));
      break;
    }
    case "parts": { const d = dir(); for (const p of core.listParts(d)) console.log(`${p}\t${core.readPart(d, p).name ?? ""}`); break; }
    case "refs": { const d = dir(); console.log(core.refsDir(d)); for (const r of core.listRefs(d)) console.log(`  @${r.key}\t${r.name}\t${Math.round(r.bytes / 1024)} KB`); break; }
    case "drc": {
      const d = dir();
      const rels = argv.length ? argv.map((p) => core.resolvePart(d, p)) : core.listParts(d);
      const t0 = Date.now();
      let cur = "";
      const results = await core.designCheck(d, rels, { force, onEvent: (e) => {
        if (e.type === "plan") console.error(`${e.total} part(s): ${e.todo} to check, ${e.total - e.todo} unchanged${e.todo ? ` (about ${secs(e.estimate)})` : ""}`);
        else if (e.type === "start") { cur = `[${e.index + 1}/${e.count}] ${e.name}`; status(`${cur}: building… about ${secs(e.left)} left`); }
        else if (e.type === "step") status(`${cur}: ${e.label} (${Math.min(e.index + 1, e.total)}/${e.total})${e.frac !== undefined ? ` ${Math.round(e.frac * 100)}%` : ""}, ${secs(e.elapsed)}, about ${secs(e.left)} left`);
        else if (e.type === "done") { status(""); console.error(`${cur}: ${e.status} in ${secs(e.ms)}`); }
      } });
      console.log(json ? JSON.stringify(results, null, 2) : core.drcReport(results));
      console.error(`Done in ${secs(Date.now() - t0)}`);
      process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
      break;
    }
    case "names": {
      const d = dir();
      if (!argv[0]) throw new Error("Which part? cadforme names <part> [--write]");
      const changes = core.nameImports(d, core.resolvePart(d, argv[0]), { write, all });
      for (const c of changes) console.log(`${c.id}: ${c.from ?? "(no name)"}  ->  ${c.to}`);
      console.error(changes.length ? (write ? `Renamed ${changes.length} import(s)` : `${changes.length} rename(s); add --write to save`) : "Import names already follow the convention");
      break;
    }
    case "push": case "pull": {
      const d = dir();
      if (!argv[0]) throw new Error(`Which part? cadforme ${cmd} <part>`);
      const rel = core.resolvePart(d, argv[0]);
      console.error(`${cmd === "pull" ? "Pulling" : preview ? "Previewing" : "Pushing"} ${rel}…`);
      const r = await core.appCommand(d, cmd === "pull" ? "onshape:pull" : preview ? "onshape:preview" : "onshape:push", rel);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "mcp": { const { serveMcp } = await import("../src/cli/mcp.js"); await serveMcp({ project: projectOpt }); break; }
  }
} catch (e) { console.error(e.message); process.exit(1); }
