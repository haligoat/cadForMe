// AI tab: give instructions, the AI (your Claude Code CLI) edits the part file, then optionally commit and send to Onshape.
import { h, icon, toast } from "./ui.js";
import { S, emit, rebuild, saveNow, onExternalChange, undo, refreshVcs, refreshLog } from "./state.js";
import { sendToOnshape, onshapeStatus } from "./onshapedlg.js";
import { runDrcFor } from "./drc.js";

const AI = { refs: { dir: "", items: [] }, prompt: "", running: false, log: [], opts: { autoFix: true, commit: true, onshape: false, drc: true }, available: null, osKeys: false, last: null, cfg: null, keyDraft: "", modelDraft: null };
let subscribed = false;
const CHIPS = ["Model the part in the reference image", "Make it 20% bigger", "Add four mounting holes near the corners", "Round all the outside corners", "Make the thickness a variable called thickness", "Fix the errors", "Explain this part (no edits)"];

const AUTH = /authenticate|OAuth|log ?in|not logged|credential|signed out/i;
const errorsNow = () => Object.entries(S.build.errors).filter(([k]) => k !== "_").map(([id, m]) => `${id}: ${m}`);
const push = (e) => { AI.log.push(e); emit(); };

async function ensureReady() {
  if (AI.available === null) AI.available = await window.cad.invoke("ai:available");
  AI.cfg = await window.cad.invoke("ai:config");
  AI.osKeys = (await onshapeStatus()).hasKeys;
  if (!subscribed) {
    subscribed = true;
    window.cad.onAiEvent((ev) => { push(ev); });
    window.cad.onRefsChanged(() => { loadRefs(); });
  }
  await loadRefs();
}

async function loadRefs() { try { AI.refs = await window.cad.invoke("refs:list"); emit(); } catch { /* no project yet */ } }

/** Image references: pictures in the image-references folder; click one to point the request at it. */
function refsStrip() {
  const add = (key) => { const tag = `@${key}`; if (!AI.prompt.includes(tag)) AI.prompt = `${AI.prompt.trim()} ${tag} `.trimStart(); emit(); };
  return h("div", { class: "section", style: { margin: "0 -12px", padding: "8px 12px" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" } },
      h("b", { style: { fontSize: "12px" } }, `Image references (${AI.refs.items.length})`),
      h("span", { style: { flex: 1 } }),
      h("button", { class: "btn sm ghost", onclick: () => window.cad.invoke("refs:open") }, "Open folder")),
    AI.refs.items.length
      ? h("div", { style: { display: "flex", gap: "6px", overflowX: "auto", paddingBottom: "4px" } }, AI.refs.items.map((r) => {
        const on = AI.prompt.includes(`@${r.key}`);
        return h("button", { class: "btn ghost", title: `Use ${r.name} in the request`, onclick: () => add(r.key), style: { flexDirection: "column", padding: "3px", border: `2px solid ${on ? "var(--accent)" : "var(--line)"}`, minWidth: "76px" } },
          r.thumb ? h("img", { src: r.thumb, style: { height: "56px", maxWidth: "96px", objectFit: "contain", borderRadius: "3px" } }) : null,
          h("span", { style: { fontSize: "10px", maxWidth: "90px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `@${r.key}`));
      }))
      : h("div", { class: "help" }, "Drop photos, sketches or screenshots into the image-references folder, then mention them like @bracket (or say \"the reference image\")."));
}

async function settle() {
  await new Promise((r) => setTimeout(r, 500));
  if (S.partPath) await onExternalChange(S.partPath);
  await rebuild();
}

async function runOnce(prompt, errors) {
  const r = await window.cad.invoke("ai:edit", { prompt, rel: S.partPath, selection: S.selection, errors });
  await settle();
  return r;
}

export async function runAi(prompt) {
  if (!S.partPath || !prompt.trim() || AI.running) return;
  await ensureReady();
  if (AI.cfg?.provider === "claude-code" && !AI.available) { toast("Claude Code isn't installed. Pick an API key provider in the AI tab, or install Claude Code", "err"); return; }
  const pc = AI.cfg?.providers?.[AI.cfg.provider];
  if (pc?.needsKey && !pc.hasKey) { toast(`Add your ${pc.label} first (AI tab)`, "err"); return; }
  if (S.view) { toast("Go back to the current version first", "err"); return; }
  AI.running = true; AI.authFailed = false; AI.log = [{ kind: "you", text: prompt }]; AI.last = null; emit();
  try {
    await saveNow();
    let res = await runOnce(prompt, errorsNow());
    if (res.cancelled) { push({ kind: "text", text: "Stopped." }); return; }
    let tries = 0;
    while (AI.opts.autoFix && errorsNow().length && tries < 2) {
      tries++; push({ kind: "tool", name: "Check", detail: `${errorsNow().length} error(s). Asking the AI to fix them (try ${tries})` });
      res = await runOnce(`The part has build errors after your edit. Fix them without changing the design intent.`, errorsNow());
      if (res.cancelled) return;
    }
    const errs = errorsNow();
    const out = { summary: res.summary, errors: errs, committed: false, sent: null };
    if (errs.length) { push({ kind: "error", text: `Still has ${errs.length} error(s): ${errs[0]}` }); AI.last = out; return; }
    if (AI.opts.commit && (await window.cad.invoke("vcs:status")).changes.length) {
      await window.cad.invoke("vcs:commit", `AI: ${prompt.replace(/\s+/g, " ").slice(0, 72)}`); out.committed = true; await refreshVcs(); await refreshLog();
      push({ kind: "tool", name: "Commit", detail: "Saved to version history" });
    }
    if (AI.opts.onshape) {
      push({ kind: "tool", name: "Onshape", detail: "Sending…" });
      const r = await sendToOnshape(S.partPath);
      out.sent = r;
      if (r.status === "nothing-sent") push({ kind: "error", text: `Nothing was sent to Onshape: ${r.skipped} feature(s) can't be sent yet (imported STEP models, patterns, holes…)` });
      else if (r.status === "pushed") { push({ kind: "tool", name: "Onshape", detail: `Done (${r.applied} change${r.applied === 1 ? "" : "s"})` }); (r.errors ?? []).forEach((e) => push({ kind: "error", text: e })); (r.warnings ?? []).forEach((w) => push({ kind: "note", text: w })); }
    }
    AI.last = out;
    // Check just the part the AI touched (everything else keeps its last result).
    if (AI.opts.drc !== false) runDrcFor([S.partPath]).catch(() => {});
  } catch (e) {
    // The CLI echoes its failure as AI text too (once per attempt); keep just the error.
    AI.log = AI.log.filter((x) => !(x.kind === "text" && e.message.includes(x.text)));
    AI.authFailed = AUTH.test(e.message);
    push({ kind: "error", text: AI.authFailed ? "Claude Code on this Mac is signed out (its login expired)." : e.message });
    if (!AI.authFailed) toast(e.message, "err");
  }
  finally { AI.running = false; emit(); }
}

export function renderAi(root) {
  if (AI.available === null) ensureReady().then(emit);
  const linked = AI.osKeys;
  const ta = h("textarea", { class: "in", placeholder: S.part ? "Tell the AI what to change, e.g. “make the base 10 mm thicker and add a 6 mm hole in the centre”" : "Open a part first", disabled: !S.part, value: AI.prompt, style: { minHeight: "84px" },
    oninput: (e) => { AI.prompt = e.target.value; const run = document.getElementById("ai-run"); if (run) run.disabled = !S.part || !AI.prompt.trim(); }, onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAi(AI.prompt); } });
  const opt = (k, label, disabled = false, hint = "") => h("label", { class: "check", style: { marginBottom: "5px", opacity: disabled ? 0.5 : 1 }, title: hint }, h("input", { type: "checkbox", checked: AI.opts[k], disabled, onchange: (e) => { AI.opts[k] = e.target.checked; } }), label);
  const cfg = AI.cfg, prov = cfg?.provider, pc = cfg?.providers?.[prov];
  const save = async (patch) => { try { await window.cad.invoke("ai:setConfig", { provider: prov, ...patch }); AI.cfg = await window.cad.invoke("ai:config"); AI.keyDraft = ""; emit(); toast("Saved", "ok"); } catch (e) { toast(e.message, "err"); } };
  root.replaceChildren(h("div", { class: "vc" },
    cfg ? h("div", { class: "section", style: { margin: "-10px -12px 0", padding: "10px 12px 12px" } },
      h("div", { class: "field" }, h("label", {}, "AI provider"), h("select", { class: "in", onchange: async (e) => { await window.cad.invoke("ai:setConfig", { provider: e.target.value }); AI.cfg = await window.cad.invoke("ai:config"); AI.modelDraft = null; emit(); } },
        Object.entries(cfg.providers).map(([id, p]) => h("option", { value: id, selected: id === prov }, (id === "claude-code" ? "Claude Code" : p.label.replace(" API key", "")) + (id === "claude-code" && !cfg.cli ? " (not installed)" : id === "claude-code" ? "" : " (API key)"))))),
      pc?.needsKey ? [
        h("div", { class: "field" }, h("label", {}, "API key"), h("input", { class: "in", type: "password", placeholder: pc.hasKey ? "Saved in Keychain (paste to replace)" : "Paste your key", value: AI.keyDraft, onkeydown: (e) => e.stopPropagation(), oninput: (e) => { AI.keyDraft = e.target.value; } })),
        h("div", { class: "field" }, h("label", {}, "Model"), h("input", { class: "in", value: AI.modelDraft ?? pc.model, onkeydown: (e) => e.stopPropagation(), oninput: (e) => { AI.modelDraft = e.target.value; } })),
        h("div", { class: "syncbar" }, h("button", { class: "btn sm primary", onclick: () => save({ ...(AI.keyDraft.trim() ? { key: AI.keyDraft.trim() } : {}), model: AI.modelDraft ?? pc.model }) }, "Save"),
          pc.hasKey ? h("button", { class: "btn sm ghost", onclick: () => save({ key: null }) }, "Remove key") : null,
          h("span", { class: "note" }, pc.hasKey ? "Key saved" : "No key yet")),
        h("div", { class: "help", style: { marginTop: "6px" } }, "Your key stays in this Mac's Keychain. It's never saved in the project or pushed, so each teammate adds their own."),
      ] : AI.available === false ? h("div", { class: "note", style: { color: "var(--red)" } }, "Claude Code wasn't found. Install it and sign in once in a terminal, or pick an API key provider.") : null) : null,
    h("div", { class: "note" }, "Describe a change, pointing at image references if you like. The AI edits this part, cadForMe rebuilds it and checks it (DRC)."),
    ta,
    refsStrip(),
    h("div", { class: "syncbar" }, CHIPS.map((c) => h("button", { class: "btn sm ghost", style: { border: "1px solid var(--line)", whiteSpace: "normal", textAlign: "left", maxWidth: "100%" }, disabled: !S.part || AI.running, onclick: () => { AI.prompt = c; emit(); } }, c))),
    h("div", {}, opt("autoFix", "Fix errors automatically (up to 2 tries)"), opt("commit", "Commit when done"), opt("drc", "Run the design check (DRC) on the part when done"), opt("onshape", linked ? "Send to Onshape when done" : "Send to Onshape when done (connect Onshape first)", !linked, "Pushes the result to the linked Onshape Part Studio")),
    AI.running ? h("button", { class: "btn danger", onclick: () => window.cad.invoke("ai:cancel") }, "Stop")
      : h("button", { id: "ai-run", class: "btn primary", disabled: !S.part || !AI.prompt.trim(), onclick: () => runAi(AI.prompt) }, icon("check"), "Run  ⌘↵"),
    AI.log.length ? h("div", { class: "section", style: { margin: "0 -12px" } }, h("header", {}, AI.running ? "Working…" : "Result"),
      h("div", { class: "body", style: { padding: "0 12px 8px" } }, AI.log.map((e) => h("div", { class: "change", style: { alignItems: "flex-start" } },
        h("span", { class: "st", style: { width: "58px", textAlign: "left", color: e.kind === "error" ? "var(--red)" : e.kind === "tool" ? "var(--accent)" : "var(--muted)" } }, { you: "You", text: "AI", tool: e.name ?? "Tool", error: "Error", note: "Note" }[e.kind]),
        h("span", { style: { flex: 1, userSelect: "text", color: e.kind === "error" ? "var(--red)" : "var(--text)", wordBreak: "break-word" } }, e.text ?? e.detail ?? ""))))) : null,
    !AI.running && AI.authFailed ? h("div", { class: "section", style: { margin: "0 -12px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" } },
      h("div", { class: "note" }, "Sign in again: a Terminal window opens with Claude Code; type /login, finish in the browser, then come back and press Run. Or pick a Claude API key above instead."),
      h("button", { class: "btn primary", onclick: async () => { try { await window.cad.invoke("ai:login"); } catch (e) { toast(e.message, "err"); } } }, "Sign in to Claude Code…")) : null,
    !AI.running && AI.last ? h("div", { class: "syncbar" },
      h("button", { class: "btn sm", onclick: undo }, icon("undo"), "Undo AI change"),
      h("button", { class: "btn sm", onclick: () => { S.tab = "vc"; emit(); } }, "Review in Version control")) : null));
}
