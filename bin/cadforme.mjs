#!/usr/bin/env node
// cadforme: open the cadForMe window, or run its tools from a terminal (and as an MCP server for Claude).
import fs from "node:fs";
import path from "node:path";
import * as core from "../src/cli/core.js";

const HELP = `cadforme                          the menu (in a terminal): projects, parts, design check, Onshape, ...
cadforme open [project|part]      open the 3D window (default: the current project in projects/)
cadforme doctor                   check that everything is set up, with fixes
cadforme shell-hook               shell snippet: show the menu when a terminal opens in this folder
                                  (add to ~/.zshrc or ~/.bashrc: eval "$(<this folder>/cadforme shell-hook)")
cadforme projects                 list the projects in projects/ (* = current)
cadforme new <name>               create projects/<name> and make it current
cadforme use <name>               make a project current
cadforme parts                    list the parts
cadforme drc [part...] [--force]  design check; unchanged parts reuse their last result
cadforme refs                     list the image references
cadforme names <part> [--write]   give imported files conventional names (preview without --write)
cadforme login [--oauth]          sign in to Onshape through the Onshape MCP server (opens a browser)
cadforme connect <access> <secret>  save Onshape API keys instead (or set ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY)
cadforme import <document link>   import an Onshape document into projects/<document name>
cadforme step-assembly <file.step> [--group Name=regex]  rebuild a big flat STEP as an assembly (shared parts, subassemblies)
cadforme upload <file.step> <document link> [--folder name]  import a STEP assembly into an Onshape document
cadforme push <part> [--preview]  send a part to its Onshape Part Studio as native features
cadforme pull <part>              bring Onshape edits back into a part
cadforme release [name]           make a release (named Onshape version + what changed)
cadforme releases                 list releases
cadforme mcp                      MCP server for Claude Code / the Claude desktop app
Options: --project <name|folder>  work on another project`;

core.ensureHooks();
const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (f) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const force = flag("--force"), write = flag("--write"), preview = flag("--preview"), all = flag("--all"), json = flag("--json");
const projectOpt = opt("--project"), folderOpt = opt("--folder");
const groupOpts = []; for (let g; (g = opt("--group")) !== undefined;) groupOpts.push(g);
const COMMANDS = new Set(["ui", "doctor", "shell-hook", "open", "projects", "new", "use", "parts", "drc", "refs", "names", "push", "pull", "connect", "login", "import", "step-assembly", "upload", "release", "releases", "mcp", "help"]);
const interactive = process.stdin.isTTY && process.stdout.isTTY;
if (argv.some((a) => a === "--help" || a === "-h")) { console.log(HELP); process.exit(0); }
let cmd = argv[0] && COMMANDS.has(argv[0]) ? argv.shift() : argv[0] === "--help" || argv[0] === "-h" ? "help" : !argv.length && !projectOpt && interactive ? "ui" : "open";
if (argv[0] && !COMMANDS.has(argv[0]) && argv[0].startsWith("-") && cmd === "open") { console.error(`Unknown option ${argv[0]}\n\n${HELP}`); process.exit(2); }
// `cadforme open X`: X is a project when it names one (or a folder) and isn't a part of the current project
const isProjectArg = (a) => a && !a.endsWith(".part.json") && !core.listParts(core.ensureProject()).some((p) => path.basename(p, ".part.json") === a) && fs.existsSync(core.projectDir(a));
const dir = () => core.ensureProject(core.projectDir(projectOpt ?? (cmd === "open" && isProjectArg(argv[0]) ? argv.shift() : undefined)));
const editDistance = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const secs = (ms) => (ms < 60e3 ? `${(ms / 1000).toFixed(ms < 10e3 ? 1 : 0)} s` : `${Math.floor(ms / 60e3)} min ${Math.round((ms % 60e3) / 1000)} s`);
const tty = process.stderr.isTTY;
const status = (s) => { if (tty) process.stderr.write(`\r\x1b[2K${s}`); };

try {
  switch (cmd) {
    case "help": console.log(HELP); break;
    case "ui": {
      if (!interactive) throw new Error("The menu needs a terminal. Run a command instead (cadforme help)");
      core.ensureDeps();
      const { runTui } = await import("../src/cli/tui.js");
      await runTui();
      break;
    }
    case "shell-hook": {
      // Once per terminal session, when the shell is in this folder: show the menu. Agents' shells aren't interactive,
      // and Claude Code sets CLAUDECODE, so they never see it. CADFORME_NO_MENU=1 turns it off.
      const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
      console.log(`_cadforme_hook() {
  if [ "$PWD" = ${q(core.ROOT)} ] && [ -z "$_CADFORME_SHOWN" ] && [ -z "$CADFORME_NO_MENU" ] && [ -z "$CLAUDECODE" ] && [ -t 0 ] && [ -t 1 ]; then
    _CADFORME_SHOWN=1; ${q(path.join(core.ROOT, "cadforme"))} ui
  fi
}
if [ -n "$ZSH_VERSION" ]; then autoload -U add-zsh-hook; add-zsh-hook chpwd _cadforme_hook
else case ";$PROMPT_COMMAND;" in *";_cadforme_hook;"*) ;; *) PROMPT_COMMAND="_cadforme_hook\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; fi
_cadforme_hook`);
      break;
    }
    case "doctor": { const { doctorChecks, doctorReport } = await import("../src/cli/doctor.js"); const c = doctorChecks(); console.log(doctorReport(c)); process.exitCode = c.some((x) => !x.ok && !x.optional) ? 1 : 0; break; }
    case "open": {
      const d = dir();
      let part;
      try { part = argv[0] ? core.resolvePart(d, argv[0]) : undefined; }
      catch (e) {   // not a part or project: probably a mistyped command
        const near = [...COMMANDS].map((c) => [c, editDistance(c, argv[0])]).sort((a, b) => a[1] - b[1])[0];
        throw new Error(near && near[1] <= 2 ? `Unknown command "${argv[0]}". Did you mean: cadforme ${near[0]}?` : `${e.message}\n(or did you mean a command? cadforme help)`);
      }
      console.error(`Opening cadForMe on ${d}${part ? ` (${part})` : ""}. Image references: ${core.refsDir(d)}`);
      const child = core.openGui(d, { part });
      child.on("close", (code) => process.exit(code ?? 0));
      break;
    }
    case "projects": { for (const p of core.listProjects()) console.log(`${p.current ? "*" : " "} ${p.name}\t${p.parts} part(s)`); console.error(core.PROJECTS_DIR); break; }
    case "new": { if (!argv[0]) throw new Error("cadforme new <name>"); console.log(`Created ${core.createProject(argv.join(" "))} (now current)`); break; }
    case "use": { const d = core.projectDir(argv[0]); if (!argv[0] || !fs.existsSync(d)) throw new Error(`No project "${argv[0] ?? ""}"; see cadforme projects`); core.setCurrentProject(d); console.log(`Current project: ${d}`); break; }
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
    case "login": { await core.onshapeLogin({ method: argv.includes("--oauth") ? "oauth" : "api_key", onProgress: (m) => console.error(m) }); console.log("Signed in to Onshape."); break; }
    case "connect": { const r = await core.connectOnshape({ accessKey: argv[0], secretKey: argv[1] }); console.log(`Connected as ${r.user || "your account"}. Keys saved to ${r.saved}`); break; }
    case "import": { if (!argv[0]) throw new Error("cadforme import <Onshape document link>"); const opts = { onProgress: (m) => console.error(m) }; console.log(core.importReport(projectOpt ? await core.importOnshape(dir(), argv[0], opts) : await core.importOnshapeProject(argv[0], opts))); break; }
    case "step-assembly": {
      if (!argv[0]) throw new Error("cadforme step-assembly <file.step> [--group Name=regex]");
      const groups = Object.fromEntries(groupOpts.map((g) => { const i = g.indexOf("="); if (i < 1) throw new Error(`--group needs Name=regex, got ${g}`); return [g.slice(0, i), g.slice(i + 1)]; }));
      const { stepToAssembly, stepAssemblyReport } = await import("../src/cli/stepasm.js");
      const r = await stepToAssembly(dir(), argv[0], { groups, onProgress: (m) => console.error(m) });
      console.log(stepAssemblyReport(r)); process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case "upload": {
      if (!argv[0] || !argv[1]) throw new Error("cadforme upload <file.step> <Onshape document link> [--folder name]");
      console.log(core.uploadReport(await core.uploadStepAssembly(dir(), path.resolve(argv[0]), argv[1], { folder: folderOpt, onProgress: (m) => console.error(m) })));
      break;
    }
    case "push": case "pull": {
      const d = dir();
      if (!argv[0]) throw new Error(`Which part? cadforme ${cmd} <part>`);
      const rel = core.resolvePart(d, argv[0]);
      console.error(`${cmd === "pull" ? "Pulling" : preview ? "Previewing" : "Pushing"} ${rel}…`);
      console.log(JSON.stringify(cmd === "pull" ? await core.pullPart(d, rel) : await core.pushPart(d, rel, { preview }), null, 2));
      break;
    }
    case "release": { const e = await core.makeRelease(dir(), argv.join(" ")); console.log(`Release "${e.name}": ${e.url}\n${e.changes.join("\n") || "No changes since the previous release"}`); break; }
    case "releases": { for (const r of await core.releases(dir())) console.log(`${r.name}\t${r.at}\t${r.by}\n${r.description.split("\n").map((l) => `    ${l}`).join("\n")}`); break; }
    case "mcp": { const { serveMcp } = await import("../src/cli/mcp.js"); await serveMcp({ project: projectOpt }); break; }
  }
} catch (e) { console.error(e.message); core.closeOnshape(); process.exit(1); }
finally { if (cmd !== "open" && cmd !== "mcp" && cmd !== "ui") core.closeOnshape(); }
