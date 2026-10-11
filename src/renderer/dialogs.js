// Modal dialogs: prompts, remote setup, clone, settings, merge conflicts, command palette.
import { h, modal, toast, icon } from "./ui.js";
import { S, loadSettings } from "./state.js";

export function promptText(title, label, value = "", ok = "OK") {
  let input;
  return modal({
    title, actions: [{ label: "Cancel" }, { label: ok, primary: true, run: () => (input.value.trim() ? input.value.trim() : false) }],
    body: (close) => { input = h("input", { class: "in", value, placeholder: label, onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter" && input.value.trim()) close(input.value.trim()); } }); return h("div", {}, h("div", { class: "note", style: { marginBottom: "8px" } }, label), input); },
  });
}
export const confirmBox = (title, message, ok = "Confirm", danger = false) => modal({
  title, body: h("div", { class: "note", style: { fontSize: "13.5px", lineHeight: 1.6 } }, message),
  actions: [{ label: "Cancel" }, { label: ok, primary: !danger, value: true }],
}).then(Boolean);

/** Connect the project to a team remote (GitHub repo or a shared folder). Returns the spec string or null. */
export async function connectRemote(current) {
  const isFolder = current?.startsWith("folder:");
  let kind = isFolder ? "folder" : "github";
  const repo = h("input", { class: "in", placeholder: "owner/repo  (e.g. team1234/robot-cad)", value: current?.startsWith("github:") ? current.slice(7) : "" });
  const folder = h("input", { class: "in", placeholder: "/path/to/shared/folder", value: isFolder ? current.slice(7) : "" });
  const token = h("input", { class: "in", type: "password", placeholder: S.settings.hasToken ? "Token saved in Keychain (leave blank to keep)" : "ghp_… or github_pat_…" });
  const ghBox = h("div", {}, h("div", { class: "field full" }, h("label", {}, "GitHub repository"), repo), h("div", { class: "field full" }, h("label", {}, "Personal access token"), token),
    h("div", { class: "help" }, "Create a repository on GitHub (private is fine), then a token with ", h("b", {}, "Contents: read & write"), " for it (Settings → Developer settings → Fine-grained tokens). The token is stored in your Mac's Keychain, never in the project."));
  const fBox = h("div", {}, h("div", { class: "field full" }, h("label", {}, "Shared folder"), folder), h("div", { class: "help" }, "Any folder everyone can reach: iCloud Drive, Dropbox, a network drive."));
  const seg = h("div", { class: "seg", style: { marginBottom: "12px" } });
  const draw = () => { seg.replaceChildren(...[["github", "GitHub"], ["folder", "Shared folder"]].map(([k, l]) => h("button", { class: kind === k ? "on" : "", onclick: () => { kind = k; draw(); } }, l))); ghBox.style.display = kind === "github" ? "" : "none"; fBox.style.display = kind === "folder" ? "" : "none"; };
  draw();
  return modal({
    title: "Connect to your team", body: h("div", {}, seg, ghBox, fBox),
    actions: [{ label: "Cancel" }, { label: "Connect", primary: true, run: async () => {
      try {
        if (kind === "github") {
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo.value.trim())) { toast("Enter the repo as owner/name", "err"); return false; }
          if (token.value.trim()) await window.cad.invoke("settings:setToken", token.value.trim());
          await loadSettings();
          if (!S.settings.hasToken) { toast("Paste a GitHub token to connect", "err"); return false; }
          return `github:${repo.value.trim()}`;
        }
        if (!folder.value.startsWith("/")) { toast("Enter an absolute folder path", "err"); return false; }
        return `folder:${folder.value.trim()}`;
      } catch (e) { toast(e.message, "err"); return false; }
    } }],
  });
}

/** Clone dialog: asks for a remote, returns {spec, branch} or null. */
export async function cloneDialog() {
  const spec = h("input", { class: "in", placeholder: "owner/repo  or  /path/to/shared/folder" });
  const token = h("input", { class: "in", type: "password", placeholder: S.settings.hasToken ? "Token saved in Keychain (leave blank to keep)" : "GitHub token (for GitHub repos)" });
  return modal({
    title: "Clone a team project",
    body: h("div", {}, h("div", { class: "field full" }, h("label", {}, "Repository"), spec), h("div", { class: "field full" }, h("label", {}, "GitHub token"), token),
      h("div", { class: "help" }, "You'll pick an empty folder to put the project in next.")),
    actions: [{ label: "Cancel" }, { label: "Choose folder…", primary: true, run: async () => {
      const v = spec.value.trim(); if (!v) return false;
      if (token.value.trim()) { await window.cad.invoke("settings:setToken", token.value.trim()); await loadSettings(); }
      return v.startsWith("/") ? `folder:${v}` : `github:${v.replace(/^github:/, "")}`;
    } }],
  });
}

export async function settingsDialog() {
  const name = h("input", { class: "in", value: S.settings.author?.name ?? "", placeholder: "Your name (shown on commits)" });
  const email = h("input", { class: "in", value: S.settings.author?.email ?? "", placeholder: "you@example.com" });
  const token = h("input", { class: "in", type: "password", placeholder: S.settings.hasToken ? "•••••••• saved in Keychain" : "GitHub token" });
  return modal({
    title: "Settings",
    body: h("div", {}, h("div", { class: "field full" }, h("label", {}, "Name"), name), h("div", { class: "field full" }, h("label", {}, "Email"), email), h("div", { class: "field full" }, h("label", {}, "GitHub token"), token),
      S.settings.hasToken ? h("button", { class: "btn sm danger", onclick: async () => { await window.cad.invoke("settings:setToken", null); await loadSettings(); toast("Token removed"); } }, "Remove saved token") : null),
    actions: [{ label: "Cancel" }, { label: "Save", primary: true, run: async () => {
      await window.cad.invoke("settings:set", { author: { name: name.value.trim(), email: email.value.trim() } });
      if (token.value.trim()) await window.cad.invoke("settings:setToken", token.value.trim());
      await loadSettings(); return true;
    } }],
  });
}

const show = (v) => (v === undefined || v === null ? "(none)" : typeof v === "string" ? v : JSON.stringify(v, null, 1));
/** Let the user choose mine / theirs for each conflict. Resolves to {key: choice} or null. */
export function resolveConflicts(conflicts, theirsLabel) {
  const choice = {};
  const cards = conflicts.map((c) => {
    const mk = (side, title) => {
      const lab = h("label", { class: "" }, h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, h("input", { type: "radio", name: c.key, onchange: () => { choice[c.key] = side; cards.forEach((x) => x.update()); apply(); } }), h("b", {}, title)), h("pre", {}, show(c[side])));
      return lab;
    };
    const mine = mk("ours", "Mine"), theirs = mk("theirs", theirsLabel ?? "Theirs");
    const el = h("div", { class: "conflict" }, h("h4", {}, c.label), h("div", { class: "opts" }, mine, theirs), h("div", { class: "note", style: { marginTop: "6px" } }, "Before: ", h("code", {}, show(c.base).replace(/\s+/g, " ").slice(0, 120))));
    el.update = () => { mine.classList.toggle("on", choice[c.key] === "ours"); theirs.classList.toggle("on", choice[c.key] === "theirs"); };
    return el;
  });
  let btn;
  const apply = () => { if (btn) btn.disabled = conflicts.some((c) => !choice[c.key]); };
  return modal({
    title: `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} to resolve`, wide: true,
    body: h("div", {}, h("div", { class: "note", style: { marginBottom: "12px" } }, "You and a teammate changed the same thing. Everything else merged automatically. Pick which version to keep for each."), cards),
    actions: [{ label: "Cancel merge" }, { label: "Merge", primary: true, run: () => (conflicts.every((c) => choice[c.key]) ? { ...choice } : (toast("Choose a side for every conflict", "err"), false)) }],
    onClose: () => {},
  }).then((r) => r ?? null);
}

export function commandPalette(commands) {
  return new Promise((resolve) => {
    const back = h("div", { class: "modalback" });
    let items = commands, sel = 0;
    const list = h("div", { class: "list" });
    const input = h("input", { placeholder: "Type a command…" });
    const close = (cmd) => { back.remove(); resolve(cmd); };
    const draw = () => list.replaceChildren(...items.map((c, i) => h("div", { class: `item ${i === sel ? "sel" : ""}`, onmousedown: () => close(c), onmousemove: () => { sel = i; draw(); } }, h("span", {}, c.name), c.key ? h("kbd", {}, c.key) : null)));
    input.addEventListener("input", () => { const q = input.value.toLowerCase(); items = commands.filter((c) => c.name.toLowerCase().includes(q)); sel = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close(null);
      else if (e.key === "ArrowDown") { sel = Math.min(sel + 1, items.length - 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === "Enter") close(items[sel] ?? null);
    });
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(null); });
    back.append(h("div", { class: "palette" }, input, list)); document.body.append(back); draw(); input.focus();
  });
}
export { icon };
