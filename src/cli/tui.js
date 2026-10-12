// Terminal UI: what `cadforme` shows when run in a terminal. Arrow keys (or the letter shown) pick an item, Enter runs
// it, Esc goes back, q quits. No dependencies: plain ANSI on the alternate screen, keypress events from readline.
// render() is pure (view -> string) so it can be tested; everything else drives it.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as core from "./core.js";
import { apiUsage } from "../onshape/client.js";

const E = "\x1b[";
const C = { reset: `${E}0m`, dim: `${E}2m`, bold: `${E}1m`, inv: `${E}7m`, green: `${E}32m`, red: `${E}31m`, yellow: `${E}33m`, cyan: `${E}36m`, accent: `${E}38;5;208m` };
const fg = (n) => `${E}38;5;${n}m`;
const GRADIENT = [208, 214, 220, 156, 51, 39, 135];   // orange -> yellow -> green -> cyan -> blue -> purple
const STEP_COLORS = [208, 220, 51, 135];
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const fit = (s, w) => { const t = strip(s); return t.length <= w ? s + " ".repeat(w - t.length) : `${t.slice(0, Math.max(0, w - 1))}…`; };
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * view: { status: [text], title, items?: [{ label, hint, key, disabled }], sel, lines?: [text], input?: { label, value, secret },
 *         footer, busy?: frame number }
 */
export function render(view, { cols = 80, rows = 24 } = {}) {
  const w = Math.max(40, cols), out = [];
  out.push(`${[...' cadForMe '].map((c, i) => `${fg(GRADIENT[i % GRADIENT.length])}${C.bold}${c}`).join("")}${C.reset}${C.dim} CAD from text and pictures${C.reset}`);
  out.push(` ${view.status.join(`${C.dim}  ·  ${C.reset}`)}`);
  out.push(`${[...Array(w)].map((_, i) => `${fg(GRADIENT[Math.floor(i * GRADIENT.length / w)])}─`).join("")}${C.reset}`);
  out.push(` ${C.bold}${view.title}${C.reset}${view.busy !== undefined ? ` ${C.cyan}${SPIN[view.busy % SPIN.length]}${C.reset}` : ""}`);
  out.push("");
  const room = rows - out.length - 3;
  if (view.items) {
    const first = Math.max(0, Math.min(view.sel - Math.floor(room / 2), view.items.length - room));
    for (const [i, it] of view.items.slice(first, first + room).entries()) {
      const on = first + i === view.sel;
      const key = it.key ? `${C.yellow}${it.key}${C.reset} ` : "  ";
      const label = it.disabled ? `${C.dim}${it.label}${C.reset}` : on ? it.label : `${fg(GRADIENT[(first + i) % GRADIENT.length])}${it.label}`;
      out.push(fit(`${on ? `${C.accent}❯${C.reset}` : " "} ${key}${on ? C.bold : ""}${label}${C.reset}${it.hint ? `  ${C.dim}${it.hint}${C.reset}` : ""}`, w));
    }
  }
  if (view.lines) {   // long lines wrap (on plain text; colour codes only appear on short status lines)
    const wrapped = view.lines.flatMap((l) => { const t = strip(l); if (t.length <= w - 2) return [l]; const ind = t.match(/^\s*/)[0] + "  "; const parts = []; for (let i = 0; i < t.length; i += w - 2 - (i ? ind.length : 0)) parts.push((i ? ind : "") + t.slice(i, i + w - 2 - (i ? ind.length : 0))); return parts; });
    for (const l of wrapped.slice(-Math.max(1, room - (view.input ? 2 : 0)))) out.push(fit(` ${l}`, w));
  }
  if (view.input) {
    out.push("");
    out.push(fit(` ${view.input.label} ${C.cyan}${view.input.secret ? "•".repeat(view.input.value.length) : view.input.value}${C.reset}${C.inv} ${C.reset}`, w));
  }
  while (out.length < rows - 1) out.push("");
  out.length = rows - 1;
  out.push(`${C.dim}${fit(` ${view.footer}`, w)}${C.reset}`);
  return out.join("\n");
}

const LOGO = [
  "      ┌──────────┐",
  "     ╱          ╱│      ┏━╸┏━┓╺┳┓┏━╸┏━┓┏━┓┏┳┓┏━╸",
  "    ┌──────────┐ │      ┃  ┣━┫ ┃┃┣╸ ┃ ┃┣┳┛┃┃┃┣╸",
  "    │  ┌──┐    │ │      ┗━╸╹ ╹╺┻┛╹  ┗━┛╹┗╸╹ ╹┗━╸",
  "    │  └──┘    │╱       CAD from text and pictures",
  "    └──────────┘",
];
const STEPS = [
  ["1", "Describe it", "Tell your AI agent what to build, or drop photos in image-references/"],
  ["2", "Watch it build", "Open the 3D window (w) to see the part appear as it is designed"],
  ["3", "Check it", "Design check (d) flags sketches or features that need fixing"],
  ["4", "Send to Onshape", "Connect (o), then push parts as native features and make releases"],
];
/** The welcome screen's lines: the logo and the four steps. */
export function welcomeLines() {
  const lines = LOGO.map((l, i) => `${fg(GRADIENT[i % GRADIENT.length])}${C.bold}${l}${C.reset}`);
  lines.push("", `${C.bold}How it works${C.reset}`, "");
  for (const [i, [n, head, text]] of STEPS.entries()) lines.push(`  ${fg(STEP_COLORS[i])}${C.bold}${n}${C.reset}  ${fg(STEP_COLORS[i])}${C.bold}${head}${C.reset}  ${C.dim}${text}${C.reset}`);
  lines.push("", `${C.dim}Keys: ↑↓ move · Enter choose · Esc back · q quit · ? shows this again${C.reset}`);
  return lines;
}

/** A dragged-in path: quotes and backslash escapes removed, ~ expanded. */
export function cleanPath(s) {
  let t = String(s).trim();
  if (/^(['"]).*\1$/.test(t)) t = t.slice(1, -1); else t = t.replace(/\\(.)/g, "$1");
  return t.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
}

export async function runTui({ stdin = process.stdin, stdout = process.stdout } = {}) {
  let view = null, onKey = null, spin = null;
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  // the header reads the disk (parts, keys, call count): do it at most twice a second, not on every spinner frame
  let statusAt = 0, statusCache = null;
  const status = () => (Date.now() - statusAt < 500 && statusCache) || (statusAt = Date.now(), statusCache = readStatus());
  const readStatus = () => {
    const dir = core.currentProject(), parts = fs.existsSync(path.join(dir, "parts")) ? core.listParts(dir).length : 0;
    return [`project ${C.bold}${path.basename(dir)}${C.reset} ${C.dim}(${parts} part${parts === 1 ? "" : "s"})${C.reset}`,
      core.loadKeys() ? `Onshape ${C.green}connected${C.reset}` : `Onshape ${C.yellow}not connected${C.reset}`,
      `${C.dim}API calls today ${apiUsage().calls}${C.reset}`];
  };
  const draw = () => { if (view) stdout.write(`${E}H${E}2J${render({ ...view, status: status() }, size())}`); };
  const restore = () => { clearInterval(spin); stdout.write(`${E}?25h${E}?1049l`); try { stdin.setRawMode(false); } catch { /* not a tty */ } stdin.pause(); };

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true); stdin.resume();
  stdout.write(`${E}?1049h${E}?25l`);
  stdout.on("resize", draw);
  stdin.on("keypress", (str, key = {}) => {
    if (key.ctrl && key.name === "c") { restore(); process.exit(130); }
    onKey?.(str, key);
  });

  // ---- building blocks for screens ----
  const waitKey = () => new Promise((res) => { onKey = () => { onKey = null; res(); }; });
  const prompt = (title, label, { secret = false, value = "" } = {}) => new Promise((res) => {
    view = { title, lines: [], input: { label, value, secret }, footer: "Enter to confirm · Esc to cancel · drag a file in to paste its path" }; draw();
    onKey = (str, key) => {
      const inp = view.input;
      if (key.name === "return") { onKey = null; res(inp.value.trim()); return; }
      if (key.name === "escape") { onKey = null; res(null); return; }
      if (key.name === "backspace") inp.value = inp.value.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str >= " ") inp.value += str;
      draw();
    };
  });
  const confirm = (title, question) => new Promise((res) => {
    view = { title, lines: [question], footer: "y yes · n no" }; draw();
    onKey = (s, k) => { if (/^[yn]$/i.test(s ?? "") || k.name === "escape") { onKey = null; res(/^y$/i.test(s ?? "")); } };
  });
  /** Run an action, showing its progress lines; the result stays up until a key is pressed. Returns whether it worked. */
  const task = async (title, fn) => {
    const lines = []; let frame = 0;
    view = { title, lines, busy: 0, footer: "working… (Ctrl+C quits)" }; draw();
    const log = (...a) => { for (const l of a.join(" ").split("\n")) lines.push(l); draw(); };
    const saved = [console.log, console.warn, console.error, console.info];
    console.log = console.warn = console.error = console.info = (...a) => log(...a.map(String));   // the geometry kernel prints
    spin = setInterval(() => { view.busy = ++frame; draw(); }, 120);
    let ok = true;
    try { const r = await fn(log); if (r) { lines.push(""); log(String(r)); } }
    catch (e) { ok = false; log("", `${C.red}✗ ${e.message}${C.reset}`); }
    finally { clearInterval(spin); [console.log, console.warn, console.error, console.info] = saved; }
    view = { title: `${title} ${ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`}`, lines, footer: "press any key to go back" }; draw();
    await waitKey();
    return ok;
  };

  /** A menu: items() is re-read every time it is shown, so lists stay current. Resolves when the user goes back. */
  const menu = async (title, items, { root = false } = {}) => {
    let sel = 0;
    for (;;) {
      const list = items();
      sel = Math.max(0, Math.min(sel, list.length - 1));
      if (list[sel]?.disabled) sel = Math.max(0, list.findIndex((it) => !it.disabled));
      view = { title, items: list, sel, footer: `↑↓ move · Enter choose · letter = shortcut · ${root ? "q quit" : "Esc back"}` }; draw();
      const pick = await new Promise((res) => {
        onKey = (str, key) => {
          const n = list.length, step = (d) => { let k = 0; do { sel = (sel + d + n) % n; } while (list[sel].disabled && ++k < n); view.sel = sel; draw(); };
          if (key.name === "up" || str === "k") step(-1);
          else if (key.name === "down" || str === "j") step(1);
          else if (key.name === "return" || key.name === "right") { if (!list[sel].disabled) { onKey = null; res(list[sel]); } }
          else if (key.name === "escape" || key.name === "left" || (str === "q" && root)) { onKey = null; res(null); }
          else { const hit = list.findIndex((it) => it.key && it.key === str && !it.disabled); if (hit >= 0) { sel = hit; onKey = null; res(list[hit]); } }
        };
      });
      if (!pick || pick.quit) return;
      await pick.run();
      statusAt = 0;   // the action may have switched project, added parts or made calls
    }
  };

  // ---- screens ----
  const dir = () => core.ensureProject();
  const connect = async () => {
    const a = await prompt("Connect Onshape", "Access key:", { secret: true }); if (!a) return false;
    const s = await prompt("Connect Onshape", "Secret key:", { secret: true }); if (!s) return false;
    return task("Connect Onshape", async () => { const r = await core.connectOnshape({ accessKey: a, secretKey: s }); return `Connected as ${r.user || "your account"}.\nKeys saved in apikeys.json: only you can read it, and git ignores it.\nMake keys at dev-portal.onshape.com > API keys.`; });
  };
  const needKeys = async () => !!core.loadKeys() || (await connect());

  const projects = () => menu("Projects", () => [
    { label: "+ New project", key: "n", run: async () => { const n = await prompt("New project", "Name:"); if (n) await task("New project", () => `Created ${core.createProject(n)}\nIt is now the current project.`); } },
    ...core.listProjects().map((p) => ({ label: `${p.current ? `${C.green}●${C.reset}` : " "} ${p.name}`, hint: `${p.parts} part${p.parts === 1 ? "" : "s"}${p.current ? ", current" : ""}`, run: async () => { core.setCurrentProject(p.dir); } })),
  ]);

  const partMenu = (rel) => menu(`Part: ${path.basename(rel, ".part.json")}`, () => {
    const linked = core.linkedParts(dir()).some((p) => p.rel === rel);
    return [
      { label: "Open in the 3D window", key: "o", run: () => task("Open", () => { core.openGui(dir(), { part: rel, detach: true }); return "The 3D window is opening."; }) },
      { label: "Design check", key: "d", run: () => task(`Design check: ${rel}`, async () => core.drcReport(await core.designCheck(dir(), [rel], { force: true }))) },
      { label: "Fix import names", key: "n", run: () => task("Import names", () => { const c = core.nameImports(dir(), rel, { write: true }); return c.length ? c.map((x) => `${x.from ?? "(no name)"} -> ${x.to}`).join("\n") : "Import names already follow the convention"; }) },
      { label: "Push to Onshape", key: "p", hint: linked ? "preview first" : "not linked to Onshape", disabled: !linked, run: async () => {
        if (!(await needKeys())) return;
        if (!(await task("Push preview", async () => JSON.stringify(await core.pushPart(dir(), rel, { preview: true }), null, 2)))) return;
        if (await confirm("Push to Onshape", "Send these changes to Onshape? (y/n)")) await task("Push", async () => JSON.stringify(await core.pushPart(dir(), rel), null, 2));
      } },
      { label: "Pull from Onshape", key: "l", hint: linked ? "" : "not linked to Onshape", disabled: !linked, run: async () => { if (await needKeys()) await task("Pull", async () => JSON.stringify(await core.pullPart(dir(), rel), null, 2)); } },
    ];
  });
  const parts = () => menu("Parts", () => {
    const list = core.listParts(dir());
    return list.length ? list.map((rel) => { let name = ""; try { name = core.readPart(dir(), rel).name ?? ""; } catch { name = "(can't read)"; } return { label: path.basename(rel, ".part.json"), hint: name, run: () => partMenu(rel) }; })
      : [{ label: "No parts yet. Ask your AI agent to design one, or import from Onshape.", disabled: true }];
  });

  const onshapeMenu = () => menu("Onshape", () => [
    { label: core.loadKeys() ? "Change API keys" : "Connect (API keys)", key: "c", run: connect },
    { label: "Import a document", key: "i", hint: "paste its link; makes a new project", run: async () => {
      if (!(await needKeys())) return;
      const url = await prompt("Import from Onshape", "Document link:"); if (url) await task("Import from Onshape", async (log) => core.importReport(await core.importOnshapeProject(url, { onProgress: log })));
    } },
    { label: "Releases", key: "r", run: async () => { if (await needKeys()) await task("Releases", async () => (await core.releases(dir())).map((r) => `${r.name}  ${r.at}${r.by ? `  by ${r.by}` : ""}${r.description ? `\n    ${r.description.split("\n").join("\n    ")}` : ""}`).join("\n\n") || "No releases yet"); } },
    { label: "Make a release", key: "m", hint: "named Onshape version", run: async () => {
      if (!(await needKeys())) return;
      const n = await prompt("Make a release", "Release name (empty = automatic):"); if (n === null) return;
      await task("Make a release", async () => { const e = await core.makeRelease(dir(), n); return `Release "${e.name}"\n${e.url}\n\n${e.changes.join("\n") || "No changes since the previous release"}`; });
    } },
    { label: "Disconnect", key: "x", disabled: !core.loadKeys(), run: async () => { if (await confirm("Disconnect", "Forget the Onshape keys on this computer? (y/n)")) await task("Disconnect", () => { core.disconnectOnshape(); return "Keys removed."; }); } },
  ]);

  const bigStep = async () => {
    const file = await prompt("Big STEP file -> Onshape assembly", "STEP file (drag it here):"); if (!file) return;
    const { stepToAssembly, stepAssemblyReport } = await import("./stepasm.js");
    let out = null;
    const ok = await task("Rebuild as an assembly", async (log) => { const r = await stepToAssembly(dir(), cleanPath(file), { onProgress: log }); out = r.file; return stepAssemblyReport(r); });
    if (!ok || !out || !(await confirm("Upload", "Upload the assembly into an Onshape document now? (y/n)")) || !(await needKeys())) return;
    const url = await prompt("Upload to Onshape", "Document link (adds about 10 tabs there):"); if (!url) return;
    const folder = await prompt("Upload to Onshape", "Tab folder for it (empty = none; create it in Onshape first):"); if (folder === null) return;
    await task("Upload to Onshape", async (log) => core.uploadReport(await core.uploadStepAssembly(dir(), out, url, { folder: folder || undefined, onProgress: log })));
  };

  const welcome = async () => { view = { title: "Welcome", lines: welcomeLines(), footer: "press any key to continue" }; draw(); await waitKey(); };
  const refs = () => task("Image references", () => {
    const list = core.listRefs(dir());
    return `${core.refsDir(dir())}\n\n${list.length ? list.map((r) => `@${r.key}  ${r.name}  ${Math.round(r.bytes / 1024)} KB`).join("\n") : "No pictures yet. Drop photos, sketches or screenshots in that folder,\nthen mention them to your AI agent as @name."}`;
  });
  const health = async () => { const { doctorReport } = await import("./doctor.js"); await task("Health check", () => doctorReport()); };

  try {
    await welcome();
    await menu("What do you want to do?", () => [
      { label: "Open the 3D window", key: "w", run: () => task("Open", () => { core.openGui(dir(), { detach: true }); return "The 3D window is opening on this project."; }) },
      { label: "Parts", key: "a", hint: "open, check, push, pull", run: parts },
      { label: "Projects", key: "p", hint: "switch or start one", run: projects },
      { label: "Design check", key: "d", hint: "all parts; unchanged ones are skipped", run: () => task("Design check", async () => { const r = await core.designCheck(dir(), core.listParts(dir())); return `${core.drcReport(r)}\n\n${r.filter((x) => !x.skipped).length} checked, ${r.filter((x) => x.skipped).length} unchanged`; }) },
      { label: "Onshape", key: "o", hint: "connect, import, releases", run: onshapeMenu },
      { label: "Big STEP file -> Onshape assembly", key: "s", run: bigStep },
      { label: "Image references", key: "i", run: refs },
      { label: "How to use", key: "?", hint: "the four steps", run: welcome },
      { label: "Health check", key: "h", hint: "is everything set up?", run: health },
      { label: "Quit", key: "q", quit: true },
    ], { root: true });
  } finally { restore(); }
}
