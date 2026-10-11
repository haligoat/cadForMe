// Releases tab: Onshape versions are the history (no git). "Make a release" saves a named Onshape version with a summary of
// what changed since the previous one; the list shows earlier releases with their change summaries and links to open them.
import { h, toast, ago } from "./ui.js";
import { S, emit } from "./state.js";
import { promptText } from "./dialogs.js";

const R = { list: null, busy: false, error: "" };

async function load() {
  R.busy = true; R.error = ""; emit();
  try { R.list = await window.cad.invoke("release:list"); } catch (e) { R.list = []; R.error = e.message; }
  R.busy = false; emit();
}

async function make() {
  const name = await promptText("Make a release", "Name (blank: Release 1, 2...)", "", "Release");
  if (name === undefined || name === null) return;
  R.busy = true; emit();
  try { const e = await window.cad.invoke("release:make", name); toast(`Release "${e.name}" saved in Onshape`, "ok"); R.list = null; }
  catch (e) { toast(e.message, "err"); }
  R.busy = false; emit();
}

export function renderReleases(root) {
  if (R.list === null && !R.busy) load();
  const linked = !!S.part?.onshape?.did;
  root.replaceChildren(h("div", { class: "vc" },
    h("div", { class: "note" }, "A release is a named version saved in Onshape (open or restore it there), with a summary of what changed here since the last one. Push your parts first so Onshape has the latest."),
    h("div", { class: "syncbar" },
      h("button", { class: "btn primary", disabled: R.busy || !linked, title: linked ? "" : "Send or import a part with Onshape first", onclick: make }, "Make a release"),
      h("button", { class: "btn ghost", disabled: R.busy, onclick: load }, "Refresh")),
    R.error ? h("div", { class: "note", style: { color: "var(--red)" } }, R.error) : null,
    R.busy && !R.list ? h("div", { class: "note" }, "Loading…") : null,
    ...(R.list ?? []).map((r) => h("div", { class: "section", style: { margin: "0 -12px", padding: "8px 12px" } },
      h("div", { style: { display: "flex", gap: "8px", alignItems: "baseline" } }, h("b", { style: { flex: 1 } }, r.name), h("span", { class: "note" }, r.at ? ago(r.at) : "")),
      r.by ? h("div", { class: "note" }, `by ${r.by}`) : null,
      r.description ? h("pre", { style: { whiteSpace: "pre-wrap", fontSize: "11px", margin: "4px 0", userSelect: "text" } }, r.description) : null,
      h("button", { class: "btn sm ghost", onclick: () => window.cad.invoke("onshape:open", r.url) }, "Open in Onshape"))),
    R.list && !R.list.length && !R.error ? h("div", { class: "note" }, "No releases yet.") : null));
}
