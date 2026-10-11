// `cadforme doctor`: everything a fresh clone needs, each with how to fix it. Used by the CLI and the terminal UI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as core from "./core.js";
import { mcpServerConfig } from "../onshape/mcp.js";

const tryRun = (cmd, args) => { try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };

/** [{ name, ok, detail, fix?, optional }] */
export function doctorChecks() {
  const out = [];
  const add = (name, ok, detail, fix, optional = false) => out.push({ name, ok: !!ok, detail, ...(fix && !ok ? { fix } : {}), optional });
  const major = Number(process.versions.node.split(".")[0]);
  add("Node.js", major >= 20, `v${process.versions.node}`, "Install Node 20 or newer (nodejs.org)");
  const deps = fs.existsSync(path.join(core.ROOT, "node_modules", "replicad-opencascadejs"));
  add("Dependencies", deps, deps ? "installed" : "missing", "Run any cadforme command once (it installs them), or npm install");
  let electron = null; try { electron = deps && core.electronBin(); } catch { /* not installed */ }
  add("3D window (Electron)", electron && fs.existsSync(electron), electron ? "ready" : "missing", "npm install");
  add("Projects folder", fs.existsSync(core.PROJECTS_DIR), `${core.listProjects().length} project(s), current: ${path.basename(core.currentProject())}`, "cadforme new <name>");
  const mcp = mcpServerConfig(), mode = core.onshapeMode();
  add("Onshape connection", mode === "mcp" ? !!mcp : !!core.loadKeys(), mode === "mcp" ? `through the Onshape MCP server (${[mcp?.command, ...(mcp?.args ?? [])].join(" ")}); it asks you to sign in the first time` : "direct API keys",
    mode === "mcp" ? 'Add an "onshape" server to .mcp.json (see README)' : "cadforme connect <access key> <secret key>, or add an onshape MCP server to .mcp.json", true);
  const keys = core.loadKeys();
  add("Onshape keys", keys, keys ? (process.env.ONSHAPE_ACCESS_KEY ? "from environment" : `in ${path.relative(core.ROOT, core.keysFile())}`) : "not connected", "cadforme connect <access key> <secret key> (dev-portal.onshape.com > API keys)", true);
  if (keys && !process.env.ONSHAPE_ACCESS_KEY && fs.existsSync(core.keysFile())) {
    const mode = fs.statSync(core.keysFile()).mode & 0o077;
    add("Keys file private", mode === 0, mode ? "readable by others" : "only you can read it", `chmod 600 ${core.keysFile()}`);
    if (fs.existsSync(path.join(core.ROOT, ".git"))) {
      const ignored = tryRun("git", ["-C", core.ROOT, "check-ignore", "-q", core.keysFile()]) !== null;
      add("Keys file ignored by git", ignored, ignored ? "yes" : "NOT ignored", "Add apikeys.json to .gitignore");
    }
  }
  if (fs.existsSync(path.join(core.ROOT, ".git"))) {
    const on = tryRun("git", ["-C", core.ROOT, "config", "core.hooksPath"]) === "scripts/hooks";
    add("Key check before commits", on, on ? "on" : "off", "git config core.hooksPath scripts/hooks (any cadforme command turns it on)");
  }
  const ocp = path.join(process.env.CADFORME_OCP ?? path.join(os.homedir(), ".cache", "cadforme", "ocp"), "bin", "python");
  const hasOcp = fs.existsSync(ocp) && tryRun(ocp, ["-I", "-c", "import OCP"]) !== null;
  const python = tryRun("python3", ["--version"]);
  add("Big STEP tools (OpenCascade)", hasOcp, hasOcp ? "ready" : python ? `not set up (${python}; sets itself up on first use)` : "python3 missing", python ? "Nothing to do: step-assembly sets it up the first time" : "Install Python 3 (python.org or brew install python)", true);
  return out;
}

export function doctorReport(checks = doctorChecks()) {
  const lines = checks.map((c) => `${c.ok ? "✓" : c.optional ? "○" : "✗"} ${c.name.padEnd(30)} ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`);
  const bad = checks.filter((c) => !c.ok && !c.optional).length;
  return `${lines.join("\n")}\n\n${bad ? `${bad} problem(s) to fix` : "All good"}`;
}
