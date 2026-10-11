// Left panel, Design tab: parts, variables and the feature tree.
import { h, icon, toast } from "./ui.js";
import { makeEvaluator } from "../kernel/expr.js";
import { S, emit, edit, loadPart, createPart, deletePart, select, setFeature, deleteFeature, moveFeature, setRollback } from "./state.js";
import { FEATURES, summary } from "./features.js";
import { promptText, confirmBox } from "./dialogs.js";
import { addFeature, effVars, duplicateFeature } from "./state.js";
import { showMenu } from "./ui.js";
import { openLibrary } from "./library.js";
import { isAssembly } from "./assembly.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function partsSection() {
  return h("div", { class: "section" },
    h("header", {}, h("span", { class: "grow", title: "Each Part Studio or Assembly is one file in the project's parts/ folder" }, "Part Studios & Assemblies"), h("button", { class: "iconbtn", title: "Standard parts: screws, nuts, bearings, gears", onclick: openLibrary }, icon("cube")), h("button", { class: "iconbtn", title: "New Part Studio or Assembly", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, [
      { label: "New Part Studio", run: async () => { const n = await promptText("New Part Studio", "Name", "", "Create"); if (n) createPart(n); } },
      { label: "New Assembly", run: async () => { const n = await promptText("New Assembly", "Name", "Assembly", "Create"); if (n) createPart(n, { assembly: true }); } }]); } }, icon("plus"))),
    h("div", { class: "body" }, S.project.parts.length ? S.project.parts.map((rel) => h("div", { class: `row ${rel === S.partPath ? "sel" : ""}`, onclick: () => rel !== S.partPath && loadPart(rel) },
      icon(S.kinds?.[rel] === "assembly" ? "assembly" : "cube"), h("span", { class: "name", title: rel }, rel === S.partPath && S.part?.name ? S.part.name : rel.replace(/^parts\//, "").replace(".part.json", "").replace(/[-_]+/g, " ")),
      h("span", { class: "acts" }, h("button", { class: "iconbtn", title: "Delete part", onclick: async (e) => { e.stopPropagation(); if (await confirmBox("Delete part?", `${rel} will be removed from the working folder.`, "Delete", true)) deletePart(rel); } }, icon("trash"))))) : h("div", { class: "empty" }, "Nothing yet. Click + to make a Part Studio or an Assembly.")));
}

function originSection() {
  const picking = S.pick?.kind === "newsketch";
  const planes = [["XY", "Top", "#5b8cff"], ["XZ", "Front", "#3ecf8e"], ["YZ", "Right", "#ff6b7a"]];
  return h("div", { class: "section" }, h("header", {}, h("span", { class: "grow" }, "Origin & planes"),
    h("button", { class: "iconbtn", title: S.showPlanes ? "Hide planes" : "Show planes", onclick: () => { S.showPlanes = !S.showPlanes; emit(); } }, icon(S.showPlanes ? "eye" : "eyeoff"))),
    h("div", { class: "body" }, planes.map(([id, name, color]) => h("div", { class: `row ${picking ? "sel" : ""}`, title: picking ? `Sketch on ${name}` : name,
      onclick: () => { if (picking) { S.pick = null; addFeature("sketch", { plane: id }); } else { S.showPlanes = true; emit(); } } },
      h("span", { style: { width: "12px", height: "12px", borderRadius: "3px", background: color, opacity: 0.8, flex: "none" } }), h("span", { class: "name" }, name), h("span", { class: "meta" }, id)))));
}

function bodiesSection() {
  const st = S.build.stats; if (!st.length || isAssembly(S.part)) return null;
  const owners = S.build.owners ?? [];
  const nameOf = (i) => { const o = owners[i], f = o && S.part?.features.find((x) => x.id === o); if (!f) return `Part ${i + 1}`; const same = owners.filter((x) => x === o).length; return same > 1 ? `${f.name ?? f.id} ${owners.slice(0, i + 1).filter((x) => x === o).length}` : f.name ?? f.id; };
  return h("div", { class: "section" }, h("header", {}, h("span", { class: "grow", title: "The solid bodies this Part Studio makes" }, `Parts (${st.length})`)),
    h("div", { class: "body" }, st.map((m) => h("div", { class: `row ${S.hidden.has(m.index) ? "dim" : ""}` }, h("input", { type: "color", class: "swatch", title: "Colour", value: S.part?.colors?.[m.index] ?? "#9db4d8", oninput: (e) => edit((p) => { p.colors = { ...(p.colors ?? {}), [m.index]: e.target.value }; }, { coalesce: `color${m.index}` }) }), h("span", { class: "name" }, nameOf(m.index)), h("span", { class: "meta" }, `${(m.volume / 1000).toFixed(1)} cm³`),
      h("span", { class: "acts", style: { display: "flex" } }, h("button", { class: "iconbtn", title: S.hidden.has(m.index) ? "Show" : "Hide", onclick: () => { const n = new Set(S.hidden); n.has(m.index) ? n.delete(m.index) : n.add(m.index); S.hidden = n; emit(); } }, icon(S.hidden.has(m.index) ? "eyeoff" : "eye")))))));
}

function configBar() {
  const part = S.part, names = Object.keys(part.configs ?? {});
  const set = (v) => edit((p) => { if (v) p.config = v; else delete p.config; });
  return h("div", { style: { display: "flex", gap: "6px", padding: "0 6px 8px" } },
    h("select", { class: "in", title: "Configuration: named sets of variable values", onchange: async (e) => {
      if (e.target.value === "__new") { const n = await promptText("New configuration", "Name (e.g. Small, Large)", "", "Create"); if (n) edit((p) => { p.configs = { ...(p.configs ?? {}), [n]: {} }; p.config = n; }); else e.target.value = part.config ?? ""; }
      else set(e.target.value);
    } }, h("option", { value: "" }, "Default configuration"), names.map((n) => h("option", { value: n, selected: n === part.config }, n)), h("option", { value: "__new" }, "＋ New configuration…")),
    part.config ? h("button", { class: "btn sm", title: "Delete this configuration", onclick: async () => { if (await confirmBox("Delete configuration?", `Delete "${part.config}"?`, "Delete", true)) edit((p) => { delete p.configs[p.config]; delete p.config; }); } }, icon("trash")) : null);
}

function variablesSection() {
  const part = S.part;
  if (!part) return null;
  const eff = effVars(part), active = part.config;
  const vals = makeEvaluator(eff).variables();
  const names = Object.keys(part.variables);
  const rename = (oldName, input) => {
    const nn = input.value.trim();
    if (nn === oldName) return;
    if (!IDENT.test(nn) || nn in part.variables) { toast(!IDENT.test(nn) ? "Names use letters, digits and _ (no leading digit)" : `"${nn}" already exists`, "err"); input.value = oldName; return; }
    edit((p) => {
      const ren = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k === oldName ? nn : k, v]));
      p.variables = ren(p.variables);
      if (p.configs) p.configs = Object.fromEntries(Object.entries(p.configs).map(([c, o]) => [c, ren(o)]));
    });
    toast(`Renamed. Expressions that used "${oldName}" need updating`);
  };
  return h("div", { class: "section" },
    h("header", {}, h("span", { class: "grow" }, "Variables"), h("button", { class: "iconbtn", title: "Add variable", onclick: () => { let n = 1; while (`var${n}` in part.variables) n++; edit((p) => { p.variables[`var${n}`] = 10; }); } }, icon("plus"))),
    h("div", { class: "body" }, configBar(), names.length ? names.map((k) => {
      const v = vals[k]; const bad = typeof v === "string";
      const overridden = !!active && k in (part.configs?.[active] ?? {});
      const valInput = h("input", { class: `in ${bad ? "bad" : ""}`, style: overridden ? { borderColor: "var(--accent)" } : {}, value: String(eff[k]), title: bad ? v : overridden ? `Overridden in "${active}" (base value ${part.variables[k]})` : "", spellcheck: "false", onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); }, oninput: (e) => {
        const t = e.target.value.trim(); const num = /^-?(\d+\.?\d*|\.\d+)$/.test(t); const val = num ? Number(t) : t;
        edit((p) => { if (p.config) { p.configs[p.config] = { ...(p.configs[p.config] ?? {}), [k]: val }; } else p.variables[k] = val; }, { coalesce: `var:${k}:${active ?? ""}` });
      } });
      const nameInput = h("input", { class: "in", value: k, spellcheck: "false", onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); }, onchange: (e) => rename(k, e.target) });
      return h("div", { class: "var" }, nameInput, valInput, h("span", { class: "val", title: bad ? v : String(v) }, bad ? "error" : /^-?[\d.]+$/.test(String(eff[k]).trim()) ? "" : `= ${+v.toFixed(3)}`),
        overridden ? h("button", { class: "iconbtn", title: "Reset to the default value", onclick: () => edit((p) => { delete p.configs[p.config][k]; }) }, icon("undo"))
          : h("button", { class: "iconbtn", title: "Delete variable", onclick: () => edit((p) => { delete p.variables[k]; for (const c of Object.values(p.configs ?? {})) delete c[k]; }) }, icon("close")));
    }) : h("div", { class: "empty" }, "Add variables like width = 40, then use them in any field: width/2.")));
}

let dragFrom = null;
function featuresSection() {
  const part = S.part;
  if (!part) return h("div", { class: "empty" }, "Open or create a part to start.");
  const feats = part.features;
  const rows = [];
  feats.forEach((f, i) => {
    const meta = FEATURES[f.type] ?? { icon: "cube", label: f.type };
    const err = S.build.errors[f.id];
    const after = S.rollback !== null && i > S.rollback;
    rows.push(h("div", {
      class: `row ${S.selection === f.id ? "sel" : ""} ${f.suppressed || after || f.hidden ? "dim" : ""} ${err ? "err" : ""}`, draggable: "true",
      onclick: () => select(f.id),
      oncontextmenu: (e) => { e.preventDefault(); select(f.id); showMenu(e.clientX, e.clientY, [
        { label: f.type === "sketch" ? "Edit sketch" : "Edit", run: () => { S.selection = f.id; if (f.type === "sketch") S.sketchEdit = f.id; emit(); } },
        { label: "Rename…", run: async () => { const n = await promptText("Rename feature", "Name", f.name ?? meta.label, "Rename"); if (n) setFeature(f.id, { name: n }); } },
        { label: "Duplicate", run: () => duplicateFeature(f.id) }, "-",
        { label: f.suppressed ? "Unsuppress" : "Suppress", run: () => setFeature(f.id, { suppressed: !f.suppressed }, null) },
        ...(["sketch", "plane"].includes(f.type) ? [{ label: f.hidden ? "Show in view" : "Hide in view", run: () => setFeature(f.id, { hidden: !f.hidden }, null) }] : []),
        { label: "Roll back to here", run: () => setRollback(i) }, "-",
        { label: "Delete", danger: true, run: () => deleteFeature(f.id) }]); },
      ondblclick: async () => { if (f.type === "sketch") { S.selection = f.id; S.sketchEdit = f.id; emit(); } else { const n = await promptText("Rename feature", "Name", f.name ?? meta.label, "Rename"); if (n) setFeature(f.id, { name: n }); } },
      ondragstart: (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", f.id); },
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("dragover"); }, ondragleave: (e) => e.currentTarget.classList.remove("dragover"),
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove("dragover"); if (dragFrom !== null) moveFeature(dragFrom, i); dragFrom = null; },
    },
      icon(err ? "warn" : meta.icon), h("span", { class: "name", title: err ?? "" }, f.name ?? meta.label), h("span", { class: "meta" }, summary(f)),
      h("span", { class: "acts" },
        h("button", { class: "iconbtn", title: "Roll back to here", onclick: (e) => { e.stopPropagation(); setRollback(i); } }, icon("chevron")),
        ["sketch", "plane"].includes(f.type)
          ? h("button", { class: "iconbtn", title: f.hidden ? "Show in view" : "Hide in view", onclick: (e) => { e.stopPropagation(); setFeature(f.id, { hidden: !f.hidden }, null); } }, icon(f.hidden ? "eyeoff" : "eye"))
          : h("button", { class: "iconbtn", title: f.suppressed ? "Unsuppress" : "Suppress", onclick: (e) => { e.stopPropagation(); setFeature(f.id, { suppressed: !f.suppressed }, null); } }, icon(f.suppressed ? "eyeoff" : "eye")),
        h("button", { class: "iconbtn", title: "Delete", onclick: (e) => { e.stopPropagation(); deleteFeature(f.id); } }, icon("trash")))));
    if (err && S.selection !== f.id) rows.push(h("div", { class: "err-text" }, err));
    if (S.rollback === i) rows.push(h("div", { class: "rollbar" }, h("span", { style: { cursor: "pointer" }, onclick: () => setRollback(null) }, "▶ Resume (rolled back)")));
  });
  return h("div", { class: "section" }, h("header", {}, h("span", { class: "grow" }, isAssembly(part) ? `Instances & mates (${feats.length})` : `Features (${feats.length})`)),
    h("div", { class: "body" }, feats.length ? rows : h("div", { class: "empty" }, "Start with a Sketch, then Extrude it.")));
}

export function renderDesign(root) {
  if (!S.project) { root.replaceChildren(); return; }
  root.replaceChildren(...[partsSection(), variablesSection(), originSection(), featuresSection(), bodiesSection()].filter(Boolean));
}
