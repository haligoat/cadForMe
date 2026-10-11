// DRC popup: checks parts one at a time and skips any whose fingerprint (part + files it pulls in + rules) matches the
// last run, so the whole project is never re-checked for one edit. Shows progress, a time estimate learned from earlier
// runs, and each part's stats. Results live in <project>/.cadforme/drc.json.
import { h, modal, toast } from "./ui.js";
import { partFiles, drcInWorker } from "./state.js";
import { drcKey, drcSteps, DEFAULT_RULES } from "../kernel/drcinfo.js";

const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
const secs = (ms) => (ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : ms < 90e3 ? `${(ms / 1000).toFixed(ms < 10e3 ? 1 : 0)} s` : `${Math.floor(ms / 60e3)} min ${Math.round((ms % 60e3) / 1000)} s`);
const fmt = (x, d = 1) => (x === null || x === undefined ? "–" : String(Number(Number(x).toFixed(d))));
const COLOR = { pass: "var(--green, #2e7d32)", warn: "var(--amber, #b26a00)", fail: "var(--red)", skipped: "var(--muted)", queued: "var(--muted)", running: "var(--accent)" };
const LABEL = { pass: "Pass", warn: "Warnings", fail: "Fail", queued: "Queued", running: "Checking" };
const DEFAULT_MS_PER_FEATURE = 60;

let running = null;   // only one DRC at a time

/** Check the given part files (paths like parts/x.part.json). force: ignore cached results. */
export async function runDrcFor(rels, { force = false } = {}) {
  if (running) { toast("A design check is already running"); return null; }
  running = checkParts(rels, force);
  let out;
  try { out = await running; } finally { running = null; }
  return out.again ? runDrcFor(rels, { force: true }) : out.jobs;
}

async function checkParts(rels, force) {
  const cache = await window.cad.invoke("drc:load");
  cache.parts ??= {};
  const rules = { ...DEFAULT_RULES, ...(cache.rules ?? {}) };
  const msPerFeature = () => cache.msPerFeature ?? DEFAULT_MS_PER_FEATURE;
  // Work out what needs checking before showing anything.
  const jobs = [];
  for (const rel of rels) {
    try {
      const part = JSON.parse(await window.cad.invoke("fs:read", rel));
      const files = await partFiles(part);
      const key = await drcKey(part, files, rules, hex);
      const prev = cache.parts[rel], same = !force && prev?.key === key;
      jobs.push({ rel, part, files, key, name: part.name ?? rel, steps: drcSteps(part),
        est: prev?.ms ?? (part.features?.length ?? 0) * msPerFeature() + 400,   // last time this part took, else learned speed
        state: same ? "skipped" : "queued", result: same ? prev.result : null, ms: same ? prev.ms : null });
    } catch (e) { jobs.push({ rel, name: rel, steps: [], est: 0, state: "done", ms: 0, result: { status: "fail", checks: [{ label: "Read", status: "fail", detail: e.message, items: [] }], stats: null } }); }
  }
  const todo = jobs.filter((j) => j.state === "queued");
  const t0 = performance.now();
  let current = null, step = null, curStart = 0, stop = false, done = false, again = false;
  const box = h("div", { style: { minWidth: "560px", maxHeight: "70vh", overflowY: "auto" } });
  const openDetail = new Set();

  // Time left: the remaining parts' expected times, scaled by how this run has gone against its own estimates.
  const remaining = () => {
    const finished = todo.filter((j) => j.state === "done");
    const est = finished.reduce((a, j) => a + j.est, 0), real = finished.reduce((a, j) => a + j.ms, 0);
    const k = est > 0 ? Math.min(3, Math.max(0.33, real / est)) : 1;
    let left = todo.filter((j) => j.state === "queued").reduce((a, j) => a + j.est * k, 0);
    if (current) left += Math.max(current.est * k - (performance.now() - curStart), 300);
    return left;
  };
  const statsGrid = (s) => s ? h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "4px 12px", fontSize: "11px", margin: "6px 0" } },
    [["Bodies", s.pieces > s.bodies ? `${s.bodies} (${s.pieces} pieces)` : s.bodies], ["Volume", `${fmt(s.volume / 1000, 2)} cm³`], ["Mass", s.mass === null ? "–" : `${fmt(s.mass, 1)} g`], ["Size", `${s.size.map((v) => fmt(v)).join(" × ")} mm`],
      ["Features", s.features], ["Variables", s.variables], ["Build", secs(s.buildMs ?? 0)], ["Surface", s.area === null ? "–" : `${fmt(s.area / 100, 1)} cm²`]]
      .map(([k, v]) => h("div", {}, h("div", { style: { color: "var(--muted)" } }, k), h("b", {}, String(v))))) : null;
  const checkRow = (c) => h("div", { style: { fontSize: "12px", padding: "2px 0" } },
    h("span", { style: { color: COLOR[c.status], fontWeight: 600, display: "inline-block", width: "18px" } }, c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗"),
    h("b", {}, c.label), " ", h("span", { style: { color: "var(--muted)" } }, c.detail), c.ms > 50 ? h("span", { style: { color: "var(--muted)", fontSize: "10px" } }, ` (${secs(c.ms)})`) : null,
    c.items?.length ? h("ul", { style: { margin: "2px 0 2px 26px", padding: 0 } }, c.items.slice(0, 12).map((x) => h("li", {}, x)), c.items.length > 12 ? h("li", {}, `…and ${c.items.length - 12} more`) : null) : null);

  const paint = () => {
    const elapsed = performance.now() - t0, left = done ? 0 : remaining();
    const frac = done ? 1 : todo.length ? Math.min(0.99, elapsed / (elapsed + left)) : 1;
    const tally = {};
    for (const j of jobs) { const k = j.result?.status ?? j.state; tally[k] = (tally[k] ?? 0) + 1; }
    box.replaceChildren(
      h("div", { class: "note", style: { marginBottom: "6px" } },
        `${jobs.length} part${jobs.length === 1 ? "" : "s"}: ${todo.length} to check, ${jobs.length - todo.length} unchanged since their last check (not re-run).`),
      h("div", { style: { height: "8px", background: "var(--line)", borderRadius: "4px", overflow: "hidden" } },
        h("div", { style: { width: `${(frac * 100).toFixed(1)}%`, height: "100%", background: "var(--accent)", transition: "width .25s" } })),
      h("div", { style: { display: "flex", gap: "14px", fontSize: "12px", margin: "6px 0 10px", flexWrap: "wrap" } },
        h("span", {}, `Elapsed ${secs(elapsed)}`),
        h("span", {}, done ? (stop ? "Stopped" : "Done") : `About ${secs(left)} left`),
        current && step ? h("span", { style: { color: "var(--accent)" } }, `${current.name}: ${step.label} (${Math.min(step.index + 1, current.steps.length)}/${current.steps.length})${step.frac !== undefined ? ` ${Math.round(step.frac * 100)}%` : ""}`) : null,
        h("span", { style: { flex: 1 } }),
        h("span", { style: { color: "var(--muted)" } }, Object.entries(tally).map(([k, n]) => `${n} ${(LABEL[k] ?? k).toLowerCase()}`).join(" · "))),
      ...jobs.map((j) => {
        const st = j.state === "running" || j.state === "queued" ? j.state : j.result?.status ?? j.state;
        // details open by themselves for anything that needs attention (click a row to toggle)
        const open = openDetail.has(j.rel) !== (done && j.result && j.result.status !== "pass");
        return h("div", { style: { margin: "0 0 6px", padding: "6px 8px", border: "1px solid var(--line)", borderRadius: "6px" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: j.result ? "pointer" : "default" }, onclick: () => { if (!j.result) return; openDetail.has(j.rel) ? openDetail.delete(j.rel) : openDetail.add(j.rel); paint(); } },
            h("b", { style: { flex: 1 } }, j.name),
            j.state === "skipped" ? h("span", { style: { fontSize: "11px", color: "var(--muted)" } }, "unchanged: last result") : null,
            h("span", { style: { fontSize: "11px", color: "var(--muted)" } }, j.ms !== null ? secs(j.ms) : j.state === "queued" ? `~${secs(j.est)}` : ""),
            h("span", { style: { fontSize: "11px", fontWeight: 600, color: COLOR[st] ?? "var(--text)", minWidth: "70px", textAlign: "right" } }, LABEL[st] ?? st)),
          open && j.result ? [statsGrid(j.result.stats), ...j.result.checks.map(checkRow)] : null);
      }));
  };
  const timer = setInterval(() => { if (!done) paint(); }, 250);
  const dialog = modal({ title: "Design check (DRC)", wide: true, body: box,
    actions: [{ label: "Re-check everything", run: () => { again = true; } }, { label: "Close", primary: true, value: "close" }],
    onClose: () => { stop = true; clearInterval(timer); } });
  paint();

  for (const j of todo) {
    if (stop) break;
    current = j; step = null; curStart = performance.now(); j.state = "running"; paint();
    try { j.result = await drcInWorker(j.part, j.files, rules, (p) => { step = p; }); }
    catch (e) { j.result = { status: "fail", checks: [{ label: "Engine", status: "fail", detail: e.message, items: [] }], stats: null }; }
    j.ms = Math.round(performance.now() - curStart); j.state = "done";
    cache.parts[j.rel] = { key: j.key, at: new Date().toISOString(), ms: j.ms, result: j.result };
    const n = j.part.features?.length ?? 0;
    if (n) cache.msPerFeature = Math.round(0.7 * msPerFeature() + 0.3 * (j.ms / n));
    await window.cad.invoke("drc:save", cache).catch(() => {});
    current = null;
  }
  done = true; clearInterval(timer); paint();
  await dialog;
  return { jobs, again };
}
