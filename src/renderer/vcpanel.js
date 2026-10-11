// Left panel, Version Control tab: branches, sync with the team, changes, commit, history.
import { h, icon, toast, ago } from "./ui.js";
import { S, emit, refreshVcs, refreshLog, reloadAfterVcsChange, viewCommit, saveNow, exitView } from "./state.js";
import { connectRemote, promptText, confirmBox, resolveConflicts } from "./dialogs.js";
import { sendToOnshape, onshapeInfo, onshapeStatus } from "./onshapedlg.js";

let message = "";
let osKeys = false;
onshapeStatus().then((s) => { osKeys = s.hasKeys; }).catch(() => {});
let busy = "";
const call = (ch, ...a) => window.cad.invoke(`vcs:${ch}`, ...a);

async function run(label, fn) {
  if (busy) return;
  busy = label; emit();
  try { await saveNow(); return await fn(); } catch (e) { toast(e.message, "err"); }
  finally { busy = ""; emit(); }
}

async function doCommit() {
  const msg = message.trim();
  if (!msg) { toast("Write a short message describing the change", "err"); return; }
  await run("commit", async () => { await call("commit", msg); message = ""; await refreshVcs(); await refreshLog(); toast("Committed", "ok"); });
}

/** Send every Onshape-linked part to Onshape (used after a push or pull when "also send to Onshape" is on). */
async function autoSend() {
  if (!S.project.config?.autoOnshape) return;
  const dirty = new Set((S.vc.status?.changes ?? []).map((c) => c.path));
  const sent = [], skipped = [];
  for (const rel of S.project.parts) {
    let info; try { info = await onshapeInfo(rel); } catch { continue; }
    if (!info.linked) continue;
    if (dirty.has(rel)) { skipped.push(rel.replace("parts/", "")); continue; }
    try { const r = await sendToOnshape(rel, { askLink: false }); if (r.status === "pushed") sent.push(rel.replace("parts/", "").replace(".part.json", "")); (r.errors ?? []).forEach((e) => toast(e, "err")); }
    catch (e) { toast(`Onshape: ${rel.replace("parts/", "")}: ${e.message}`, "err"); }
  }
  if (sent.length) toast(`Also updated Onshape: ${sent.join(", ")}`, "ok");
  if (skipped.length) toast(`Not sent to Onshape (uncommitted changes): ${skipped.join(", ")}`);
}

async function doPull(resolutions) {
  const r = await call("pull", resolutions);
  if (r.status === "conflicts") {
    const choice = await resolveConflicts(r.conflicts, "Teammate's");
    if (!choice) { toast("Merge cancelled. Nothing was changed"); return; }
    return doPull(choice);
  }
  await reloadAfterVcsChange();
  if (r.status === "merged" || r.status === "fast-forward") await autoSend();
  toast(r.status === "up-to-date" ? "Already up to date" : r.status === "no-remote-branch" ? "Nothing on the remote for this branch yet. Push to share it" : r.status === "merged" ? "Pulled and merged your teammates' changes" : "Pulled the latest changes", "ok");
}

async function doPush() {
  const r = await call("push");
  await refreshVcs(); await refreshLog();
  toast(r.status === "up-to-date" ? "Nothing new to push" : `Pushed ${r.commits} commit${r.commits === 1 ? "" : "s"}`, "ok");
  await autoSend(); // also covers "already pushed, but Onshape is behind"
}

function branchSection() {
  const b = S.vc.branches, st = S.vc.status;
  if (!b) return null;
  const names = [...new Set([b.current, ...b.local, ...b.remote])];
  return h("div", { class: "section" }, h("header", {}, icon("branch"), h("span", { class: "grow" }, "Branch")),
    h("div", { class: "body", style: { padding: "0 12px 12px", display: "flex", gap: "6px" } },
      h("select", { class: "in", disabled: !!busy, onchange: async (e) => { const to = e.target.value; await run("switch", async () => { await call("switchBranch", to); await reloadAfterVcsChange(); toast(`Switched to ${to}`); }); e.target.value = b.current; } },
        names.map((n) => h("option", { value: n, selected: n === b.current }, n + (b.local.includes(n) ? "" : "  (remote)")))),
      h("button", { class: "btn", title: "New branch from here", onclick: async () => { const n = await promptText("New branch", "Branch name (e.g. alex/bigger-intake)", "", "Create"); if (n) run("branch", async () => { await call("createBranch", n); await refreshVcs(); await refreshLog(); toast(`Created and switched to ${n}`, "ok"); }); } }, icon("plus")),
      b.local.length > 1 ? h("button", { class: "btn", title: "Delete another branch", onclick: async () => { const others = b.local.filter((x) => x !== b.current); const n = await promptText("Delete branch", `Which? (${others.join(", ")})`, others[0], "Delete"); if (n && await confirmBox("Delete branch?", `Delete "${n}"? Commits only on that branch become unreachable.`, "Delete", true)) run("delete", async () => { await call("deleteBranch", n); await refreshVcs(); await refreshLog(); }); } }, icon("trash")) : null));
}

function syncSection() {
  const st = S.vc.status, remote = S.project.config?.remote;
  return h("div", { class: "section" }, h("header", {}, icon("cloud"), h("span", { class: "grow" }, "Team")),
    h("div", { class: "body", style: { padding: "0 12px 12px" } },
      remote ? h("div", { class: "note", style: { marginBottom: "8px", userSelect: "text" } }, "Remote: ", h("b", {}, remote.replace(/^github:/, "GitHub · ").replace(/^folder:/, "Folder · ")), " ", h("a", { href: "#", style: { color: "var(--accent)" }, onclick: async (e) => { e.preventDefault(); const s = await connectRemote(remote); if (s) { S.project = { ...S.project, ...(await window.cad.invoke("vcs:setRemote", s)) }; emit(); } } }, "change"))
        : h("div", { class: "note", style: { marginBottom: "8px" } }, "Not connected. Connect to a GitHub repo so your team can push and pull."),
      remote ? h("div", { class: "syncbar" },
        h("button", { class: "btn", disabled: !!busy, onclick: () => run("pull", () => doPull()) }, icon("pull"), "Pull", st?.behind ? h("span", { class: "badge warn" }, st.behind) : null),
        h("button", { class: "btn primary", disabled: !!busy, onclick: () => run("push", doPush) }, icon("push"), "Push", st?.ahead ? h("span", { class: "badge" }, st.ahead) : null),
        h("button", { class: "btn ghost", title: "Check for new team commits", disabled: !!busy, onclick: () => run("fetch", async () => { const r = await call("fetch"); await refreshVcs(); await refreshLog(); toast(r.packs ? `Fetched ${r.packs} update${r.packs === 1 ? "" : "s"}` : "No new updates"); }) }, icon("refresh")))
        : h("button", { class: "btn primary", onclick: async () => { const s = await connectRemote(null); if (s) run("connect", async () => { S.project = { ...S.project, ...(await call("setRemote", s)) }; await refreshVcs(); toast("Connected", "ok"); }); } }, icon("cloud"), "Connect to GitHub…"),
      remote && osKeys ? h("label", { class: "check", style: { marginTop: "10px" }, title: "After every push (and pull), update linked Onshape Part Studios" }, h("input", { type: "checkbox", checked: !!S.project.config?.autoOnshape, onchange: async (e) => { S.project = { ...S.project, ...(await call("setAuto", e.target.checked)) }; emit(); } }), "Also send to Onshape when I push") : null,
      busy ? h("div", { class: "note", style: { marginTop: "6px" } }, `Working… (${busy})`) : null,
      remote && st && !busy ? h("div", { class: "note", style: { marginTop: "8px" } }, st.ahead || st.behind ? `${st.ahead} ahead · ${st.behind} behind origin/${st.branch}` : st.remoteTip ? "In sync with the team" : "Not pushed yet") : null));
}

function changesSection() {
  const st = S.vc.status; if (!st) return null;
  const work = S.vc.working ?? [];
  return h("div", { class: "section" }, h("header", {}, h("span", { class: "grow" }, "Changes"), st.changes.length ? h("span", { class: "badge" }, st.changes.length) : null,
    st.changes.length ? h("button", { class: "btn sm ghost", onclick: async () => { if (await confirmBox("Discard all changes?", "Your uncommitted edits to tracked files will be lost.", "Discard", true)) run("discard", async () => { await call("discard"); await reloadAfterVcsChange(); }); } }, "Discard") : null),
    h("div", { class: "body", style: { padding: "0 12px 12px" } },
      st.changes.length ? work.map((c) => h("div", {}, h("div", { class: "change" }, h("span", { class: `st ${c.status}` }, { added: "A", modified: "M", deleted: "D" }[c.status]), h("span", { style: { flex: 1, wordBreak: "break-all" } }, c.path)),
        c.items?.length ? h("div", { class: "diffitems" }, c.items.map((it) => h("div", {}, it.text))) : null))
        : h("div", { class: "empty", style: { padding: "0 0 6px" } }, "No changes since the last commit."),
      h("textarea", { class: "in", placeholder: "Describe your change (e.g. Thicker base plate)", value: message, oninput: (e) => { message = e.target.value; }, onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) doCommit(); }, style: { marginTop: "8px", minHeight: "58px" } }),
      h("div", { style: { display: "flex", gap: "6px", marginTop: "8px" } },
        h("button", { class: "btn", title: "Write the commit message with AI (from the CAD changes)", disabled: !st.changes.length || !!busy, onclick: () => run("ai message", async () => {
          const changes = (S.vc.working ?? []).map((c) => `${c.status} ${c.path}${c.items?.length ? "\n  " + c.items.map((i) => i.text).join("\n  ") : ""}`).join("\n");
          message = await window.cad.invoke("ai:commitMessage", changes); emit();
        }) }, "✨ AI"),
        h("button", { class: "btn primary", style: { flex: 1 }, disabled: !st.changes.length || !!busy, onclick: doCommit }, icon("commit"), `Commit ${st.changes.length ? `${st.changes.length} file${st.changes.length === 1 ? "" : "s"}` : ""}`))));
}

function historySection() {
  const log = S.vc.log; if (!log) return null;
  const sel = S.vc.sel;
  return h("div", { class: "section" }, h("header", {}, h("span", { class: "grow" }, "History")),
    h("div", { class: "body" }, log.commits.length ? log.commits.map((c) => {
      const tips = log.tips[c.id] ?? [];
      const open = sel === c.id;
      return h("div", {},
        h("div", { class: `commit ${open ? "sel" : ""} ${c.parents.length > 1 ? "merge" : ""} ${log.head === c.id ? "head" : ""}`, onclick: async () => { S.vc.sel = open ? null : c.id; S.vc.diff = null; emit(); if (!open) { try { S.vc.diff = await call("commitDiff", c.id); } catch (e) { toast(e.message, "err"); } emit(); } } },
          h("div", { class: "dot" }), h("div", {}, h("div", { class: "msg" }, c.message, tips.map((t) => h("span", { class: `tag-b ${t.startsWith("origin/") ? "remote" : ""}` }, t))), h("div", { class: "by" }, `${c.author?.name ?? "?"} · ${ago(c.time)} · ${c.id.slice(0, 7)}`))),
        open ? h("div", { style: { padding: "0 8px 10px 30px" } },
          (S.vc.diff ?? []).map((d) => h("div", { class: "diffitems", style: { margin: "0 0 4px" } }, h("div", { style: { color: "var(--text)" } }, `${d.status} ${d.path}`), d.items.map((it) => h("div", {}, it.text)))),
          h("div", { class: "syncbar", style: { marginTop: "6px" } },
            S.partPath ? h("button", { class: "btn sm", onclick: () => viewCommit(c.id) }, icon("eye"), "View this version") : null,
            S.partPath && log.head !== c.id ? h("button", { class: "btn sm", onclick: async () => { if (await confirmBox("Restore this version?", `${S.partPath} will go back to how it was in this commit. It appears as an uncommitted change you can review and commit.`, "Restore")) run("restore", async () => { await call("restoreFile", c.id, S.partPath); exitView(); await reloadAfterVcsChange(); toast("Restored. Review it under Changes", "ok"); }); } }, "Restore part") : null,
            h("button", { class: "btn sm", onclick: async () => { const n = await promptText("Branch from this commit", "Branch name", "", "Create"); if (n) run("branch", async () => { await window.cad.invoke("vcs:createBranch", n, c.id); await reloadAfterVcsChange(); }); } }, icon("branch"), "Branch")))
          : null);
    }) : h("div", { class: "empty" }, "No commits yet.")));
}

export function renderVc(root) {
  if (!S.project) { root.replaceChildren(); return; }
  onshapeStatus().then((st) => { if (st.hasKeys !== osKeys) { osKeys = st.hasKeys; emit(); } }).catch(() => {});
  root.replaceChildren(branchSection(), syncSection(), changesSection(), historySection());
}
export const vcBusy = () => busy;
