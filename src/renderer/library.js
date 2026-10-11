// Standard parts library: ISO fasteners, bearings and gears as editable parametric parts.
import { h, modal, toast } from "./ui.js";
import { S, refreshParts, loadPart } from "./state.js";
import { CATALOG } from "../kernel/standard.js";
import { formatPart } from "../kernel/format.js";

export function openLibrary() {
  if (!S.project) return;
  let item = CATALOG[0]; const vals = {};
  const body = h("div");
  const draw = () => {
    for (const o of item.opts) if (!(o.k in vals)) vals[o.k] = o.def;
    body.replaceChildren(
      h("div", { class: "field full" }, h("label", {}, "Part"), h("select", { class: "in", onchange: (e) => { item = CATALOG.find((c) => c.id === e.target.value); Object.keys(vals).forEach((k) => delete vals[k]); draw(); } }, CATALOG.map((c) => h("option", { value: c.id, selected: c.id === item.id }, c.label)))),
      ...item.opts.map((o) => h("div", { class: "field full" }, h("label", {}, o.label), o.values
        ? h("select", { class: "in", onchange: (e) => { vals[o.k] = e.target.value; } }, o.values.map((v) => h("option", { value: v, selected: v === vals[o.k] }, v)))
        : h("input", { class: "in", value: vals[o.k], onkeydown: (e) => e.stopPropagation(), oninput: (e) => { vals[o.k] = Number(e.target.value); } }))),
      h("div", { class: "help" }, "Creates a normal part in your project with variables you can edit (sizes, lengths). Use Insert part to put copies into an assembly."));
  };
  draw();
  return modal({
    title: "Standard parts library", body,
    actions: [{ label: "Cancel" }, { label: "Create part", primary: true, run: async () => {
      try {
        const part = item.build(vals);
        const base = part.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
        let rel = `parts/${base}.part.json`, n = 2;
        while (S.project.parts.includes(rel)) rel = `parts/${base}-${n++}.part.json`;
        await window.cad.invoke("fs:write", rel, formatPart(part));
        await refreshParts(); await loadPart(rel); toast(`Created ${part.name}`, "ok");
        return true;
      } catch (e) { toast(e.message, "err"); return false; }
    } }],
  });
}
