// Right-hand panel: edits the selected feature (schema driven) and sketch shapes.
import { makeEvaluator } from "../kernel/expr.js";
import { h, icon } from "./ui.js";
import { S, emit, feature, setFeature, deleteFeature, edit, select, effVars, addFeature } from "./state.js";
import { FEATURES, PLANE_NAMES } from "./features.js";
import { SK, describe, deleteEntity, sketchStatus, importDXF, exportDXF } from "./sketch.js";
import { onshapeInfo } from "./onshapedlg.js";
import { planeFrames } from "../kernel/vec.js";
import { hole as HOLES } from "../kernel/standard.js";
import { isAssembly, instances, mates, bom } from "./assembly.js";

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(4)));
const evaluator = () => makeEvaluator(effVars());

/** Text input accepting numbers or expressions; commits only valid values. */
function exprInput(value, commit, { unit = "", placeholder = "" } = {}) {
  const ev = evaluator();
  const input = h("input", { class: "in", value: value === undefined ? "" : String(value), placeholder: placeholder || (value === undefined ? "optional" : ""), spellcheck: "false" });
  const calc = h("span", { class: "calc" });
  const check = () => {
    // Empty means "not set" (optional fields use their default), never an error.
    if (!input.value.trim()) { input.classList.remove("bad"); input.title = ""; calc.textContent = ""; return true; }
    try {
      const v = ev(input.value);
      input.classList.remove("bad"); input.title = "";
      calc.textContent = NUMERIC.test(input.value.trim()) ? unit : `= ${fmt(v)} ${unit}`.trim();
      return true;
    } catch (e) { input.classList.add("bad"); input.title = e.message; calc.textContent = ""; return false; }
  };
  input.addEventListener("input", () => { if (check()) { const t = input.value.trim(); commit(!t ? undefined : NUMERIC.test(t) ? Number(t) : t); } });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); e.stopPropagation(); });
  input.addEventListener("calc", check);
  check();
  return h("div", { class: "valwrap" }, input, calc);
}

const row = (label, ...ctl) => h("div", { class: "field" }, h("label", {}, label), h("div", {}, ...ctl));

function vec3Control(f, k, spec) {
  const v = f[k] ?? [0, 0, 0];
  const set = (i, x) => { const next = [...(f[k] ?? [0, 0, 0])]; next[i] = x; setFeature(f.id, { [k]: next }, `f:${f.id}:${k}${i}`); };
  const box = h("div", { class: "vec" }, [0, 1, 2].map((i) => exprInput(v[i], (x) => set(i, x))));
  if (!spec.axes) return box;
  const same = (a) => a.every((x, i) => Number(v[i]) === x);
  return h("div", {}, box, h("div", { class: "seg", style: { marginTop: "5px" } }, spec.axes.map(([vecv, name]) => h("button", { class: same(vecv) ? "on" : "", onclick: () => setFeature(f.id, { [k]: vecv }) }, name))));
}

function field(f, spec) {
  const k = spec.k, val = f[k];
  switch (spec.t) {
    case "expr": return row(spec.label, exprInput(val, (x) => setFeature(f.id, { [k]: x }), { unit: spec.unit }));
    case "select": return row(spec.label, h("select", { class: "in", onchange: (e) => { const o = spec.opts.find(([v]) => JSON.stringify(v) === e.target.value); setFeature(f.id, { [k]: o[0] }); } },
      spec.opts.map(([v, l]) => h("option", { value: JSON.stringify(v), selected: JSON.stringify(v) === JSON.stringify(val) }, l))));
    case "check": return h("div", { class: "field" }, h("span"), h("label", { class: "check" }, h("input", { type: "checkbox", checked: val === undefined ? !!spec.def : !!val, onchange: (e) => setFeature(f.id, { [k]: e.target.checked }) }), spec.label));
    case "sketch": {
      const ids = S.part.features.slice(0, S.part.features.findIndex((x) => x.id === f.id)).filter((x) => x.type === "sketch");
      return row(spec.label, h("select", { class: "in", onchange: (e) => setFeature(f.id, { [k]: e.target.value }) },
        h("option", { value: "" }, ids.length ? "Choose a sketch" : "No sketch above"), ids.map((s) => h("option", { value: s.id, selected: s.id === val }, s.name ?? s.id))));
    }
    case "body": {
      const n = S.build.stats.length;
      const opts = [...(spec.noAll ? [] : [["all", "All bodies"]]), ...Array.from({ length: Math.max(n, typeof val === "number" ? val + 1 : 0) }, (_, i) => [i, `Body ${i + 1}`])];
      return row(spec.label, h("select", { class: "in", onchange: (e) => setFeature(f.id, { [k]: e.target.value === "all" ? "all" : Number(e.target.value) }) },
        opts.map(([v, l]) => h("option", { value: v, selected: String(v) === String(val) }, l))));
    }
    case "planeref": {
      const before = S.part.features.slice(0, S.part.features.findIndex((x) => x.id === f.id)).filter((x) => x.type === "plane");
      return row(spec.label, h("select", { class: "in", onchange: (e) => setFeature(f.id, { [k]: e.target.value }) },
        [["XY", "Top (XY)"], ["XZ", "Front (XZ)"], ["YZ", "Right (YZ)"], ...before.map((p) => [p.id, p.name ?? p.id])].map(([v, l]) => h("option", { value: v, selected: v === (val ?? "XY") }, l))));
    }
    case "pts3": {
      const pts = val ?? [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
      return h("div", { class: "field full" }, h("label", {}, spec.label), [0, 1, 2].map((i) => h("div", { class: "vec", style: { marginBottom: "4px" } }, [0, 1, 2].map((a) => exprInput(pts[i]?.[a] ?? 0, (x) => {
        const next = [0, 1, 2].map((j) => [...(f[k]?.[j] ?? pts[j])]); next[i][a] = x; setFeature(f.id, { [k]: next }, `f:${f.id}:${k}${i}${a}`);
      })))));
    }
    case "sketchlist": {
      const idx = S.part.features.findIndex((x) => x.id === f.id), all = S.part.features.slice(0, idx).filter((x) => x.type === "sketch"), chosen = val ?? [];
      return h("div", { class: "field full" }, h("label", {}, `${spec.label} (in order)`), all.length ? all.map((sk) => h("label", { class: "check", style: { marginBottom: "4px" } },
        h("input", { type: "checkbox", checked: chosen.includes(sk.id), onchange: (e) => setFeature(f.id, { [k]: e.target.checked ? [...chosen, sk.id] : chosen.filter((x) => x !== sk.id) }, null) }),
        sk.name ?? sk.id, chosen.includes(sk.id) ? h("span", { class: "meta", style: { marginLeft: "auto", color: "var(--muted)" } }, `#${chosen.indexOf(sk.id) + 1}`) : null)) : h("div", { class: "empty", style: { padding: 0 } }, "Make some sketches first."));
    }
    case "holestd": {
      const opts = [["", "Custom size"], ...Object.keys(HOLES.clearance).flatMap((sz) => [[`c:${sz}`, `${sz} clearance · ${HOLES.clearance[sz]} mm`], [`t:${sz}`, `${sz} tap drill · ${HOLES.tap[sz]} mm`]])];
      return row(spec.label, h("select", { class: "in", onchange: (e) => {
        const [kind, sz] = e.target.value.split(":"); if (!sz) return;
        const patch = { diameter: kind === "c" ? HOLES.clearance[sz] : HOLES.tap[sz] };
        if (f.style === "counterbore") { patch.cboreDiameter = HOLES.cbore[sz][0]; patch.cboreDepth = HOLES.cbore[sz][1]; }
        if (f.style === "countersink") { patch.csinkDiameter = Math.round(HOLES.clearance[sz] * 2 * 10) / 10; }
        setFeature(f.id, patch, null); e.target.value = "";
      } }, opts.map(([v, l]) => h("option", { value: v }, l))));
    }
    case "partref": {
      const others = S.project.parts.filter((x) => x !== S.partPath);
      return row(spec.label, h("select", { class: "in", onchange: (e) => setFeature(f.id, { [k]: e.target.value, name: e.target.value.replace("parts/", "").replace(".part.json", "") }) },
        h("option", { value: "" }, others.length ? "Choose a part" : "No other parts"), others.map((x) => h("option", { value: x, selected: x === val }, x.replace("parts/", "").replace(".part.json", "")))));
    }
    case "json": {
      const area = h("textarea", { class: "in", style: { minHeight: "60px", fontFamily: "var(--mono)", fontSize: "12px" }, spellcheck: "false", placeholder: '{ "width": 40, "height": "base/2" }', value: Object.keys(val ?? {}).length ? JSON.stringify(val) : "",
        onkeydown: (e) => e.stopPropagation(), oninput: (e) => { const t = e.target.value.trim(); try { const o = t ? JSON.parse(t) : {}; if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object"); e.target.classList.remove("bad"); setFeature(f.id, { [k]: o }, `f:${f.id}:${k}`); } catch { e.target.classList.add("bad"); } } });
      return h("div", { class: "field full" }, h("label", {}, `${spec.label} (JSON, optional)`), area, h("div", { class: "help", style: { marginTop: "4px" } }, "Set variables of the inserted part for this copy, e.g. {\"width\": 40}. Values can use this part's variables."));
    }
    case "file": return row(spec.label, h("div", { class: "note", style: { userSelect: "text", wordBreak: "break-all" } }, val || "(none)"));
    case "regions": {
      const list = val ?? [], active = S.pick?.kind === "regions" && S.pick.id === f.id;
      return h("div", { class: "field full" }, h("label", {}, spec.label),
        h("div", { class: `picklist ${active ? "active" : ""}` }, active ? `Click sketch regions (${list.length ? list.length + " selected" : "all"}). Click a selected one to remove it.` : list.length ? `${list.length} region${list.length === 1 ? "" : "s"} selected` : "All regions",
          h("div", { class: "actions", style: { marginTop: "8px" } },
            h("button", { class: `btn sm ${active ? "on" : ""}`, onclick: () => { S.pick = active ? null : { kind: "regions", id: f.id }; emit(); } }, active ? "Stop picking" : "Pick regions"),
            list.length ? h("button", { class: "btn sm", onclick: () => setFeature(f.id, { regions: [] }) }, "Use all") : null)));
    }
    case "vec3": return row(spec.label, vec3Control(f, k, spec));
    case "point": return h("div", {},
      row("Location", h("button", { class: `btn sm ${S.pick?.kind === "point" ? "on" : ""}`, onclick: () => { S.pick = S.pick?.kind === "point" ? null : { kind: "point", id: f.id }; emit(); } }, icon("face"), S.pick?.kind === "point" ? "Click a face…" : "Pick on a face")),
      row("Position", vec3Control(f, "position", {})), row("Direction", vec3Control(f, "normal", { axes: [[[1, 0, 0], "X"], [[0, 1, 0], "Y"], [[0, 0, 1], "Z"], [[0, 0, -1], "−Z"]] })));
    case "edges": case "faces": {
      const list = val ?? [], active = S.pick?.id === f.id && S.pick.kind === spec.t;
      return h("div", { class: "field full" }, h("label", {}, spec.label),
        h("div", { class: `picklist ${active ? "active" : ""}` },
          active ? `Click ${spec.t} in the viewport (${list.length} selected). Click again to remove.` : `${list.length} ${spec.t} selected`,
          h("div", { class: "actions", style: { marginTop: "8px" } },
            h("button", { class: `btn sm ${active ? "on" : ""}`, onclick: () => { S.pick = active ? null : { kind: spec.t, id: f.id }; emit(); } }, active ? "Stop picking" : `Pick ${spec.t}`),
            list.length ? h("button", { class: "btn sm", onclick: () => setFeature(f.id, { [k]: [] }) }, "Clear") : null)));
    }
    case "plane": {
      const custom = typeof val === "object" && val !== null;
      const cplanes = S.part.features.slice(0, S.part.features.findIndex((x) => x.id === f.id)).filter((x) => x.type === "plane");
      return h("div", {},
        cplanes.length ? row("Construction plane", h("select", { class: "in", onchange: (e) => setFeature(f.id, { plane: e.target.value }) }, h("option", { value: "" }, "(use standard plane)"), cplanes.map((p) => h("option", { value: p.id, selected: p.id === val }, p.name ?? p.id)))) : null,
        row(spec.label, h("div", { class: "seg" }, Object.entries(PLANE_NAMES).map(([id, name]) => h("button", { class: val === id ? "on" : "", onclick: () => { setFeature(f.id, { plane: id }); } }, name.split(" ")[0])))),
        h("div", { class: "field" }, h("span"), h("button", { class: `btn sm ${S.pick?.kind === "sketchface" || custom ? "on" : ""}`, onclick: () => { S.pick = S.pick?.kind === "sketchface" ? null : { kind: "sketchface", id: f.id }; emit(); } }, icon("face"), custom ? "On a face (re-pick)" : S.pick?.kind === "sketchface" ? "Click a face…" : "Place on a face")));
    }
    default: return null;
  }
}

function entityFields(e, i, sk) {
  const set = (k, x) => edit((p) => { p.features.find((q) => q.id === sk.id).entities[i][k] = x; }, { coalesce: `e:${sk.id}:${i}:${k}` });
  const num = (k, label, unit = "mm") => row(label, exprInput(e[k], (x) => set(k, x), { unit }));
  const common = [num("cx", "Centre X"), num("cy", "Centre Y")];
  switch (e.type) {
    case "rect": return [...common, num("w", "Width"), num("h", "Height"), num("r", "Corner radius"), num("angle", "Rotation", "°")];
    case "circle": return [...common, num("r", "Radius")];
    case "ellipse": return [...common, num("rx", "Radius X"), num("ry", "Radius Y"), num("angle", "Rotation", "°")];
    case "polygon": return [...common, num("r", "Radius"), num("sides", "Sides", ""), num("angle", "Rotation", "°")];
    case "slot": return [...common, num("length", "Length"), num("width", "Width"), num("angle", "Rotation", "°")];
    case "polyline": return e.points.map((pt, pi) => row(`Point ${pi + 1}`, h("div", { class: "vec", style: { gridTemplateColumns: "1fr 1fr" } },
      [0, 1].map((a) => exprInput(pt[a], (x) => edit((p) => { p.features.find((q) => q.id === sk.id).entities[i].points[pi][a] = x; }, { coalesce: `p:${sk.id}:${i}:${pi}${a}` }))))));
    default: return [];
  }
}

const CONS_NAMES = { horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel", perpendicular: "Perpendicular", equal: "Equal", tangent: "Tangent", midpoint: "Midpoint", concentric: "Concentric", fix: "Fixed", on: "Point on curve", coincident: "Coincident" };
function sketchSection(f) {
  const editing = S.sketchEdit === f.id, st = sketchStatus();
  const out = [];
  if (!editing) out.push(h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: () => { S.sketchEdit = f.id; S.pick = null; emit(); } }, icon("sketch"), "Edit sketch")));
  else if (st) out.push(h("div", { class: "field full" }, st.conflicting?.length ? h("span", { class: "statchip bad" }, `Over-constrained (${st.conflicting.length} conflicting)`) : st.empty ? h("span", { class: "statchip under" }, "Draw something to begin") : st.dof === 0 ? h("span", { class: "statchip ok" }, "Fully defined") : h("span", { class: "statchip under" }, `Under-defined · ${st.dof} degrees of freedom left`)));
  out.push(h("div", { class: "syncbar", style: { marginTop: "8px" } },
    editing ? h("button", { class: "btn sm", title: "Add the lines, arcs and circles of a DXF file to this sketch", onclick: importDXF }, icon("download"), "Import DXF…") : null,
    h("button", { class: "btn sm", title: "Export this sketch's profile as a DXF (laser cutting, CNC)", disabled: !(f.geom ?? []).some((g) => g.t !== "point"), onclick: () => exportDXF(f) }, icon("download"), "Export DXF…")));
  const cons = f.cons ?? [];
  out.push(h("div", { class: "section", style: { margin: "12px -12px 0" } }, h("header", {}, `Constraints & dimensions (${cons.length})`),
    h("div", { class: "body" }, cons.length ? cons.map((c) => {
      const sel = SK.sel.has(c.id);
      return h("div", { class: `ent ${sel ? "sel" : ""}`, onclick: () => { SK.sel = new Set([c.id]); if (!editing) S.sketchEdit = f.id; emit(); } },
        h("span", { class: "grow" }, c.t === "dim" ? `${{ length: "Length", dist: "Distance", hdist: "Horizontal", vdist: "Vertical", radius: "Radius", diameter: "Diameter", angle: "Angle", pdist: "Distance", x: "X", y: "Y" }[c.k]} ${c.a}${c.b ? "–" + c.b : ""}` : `${CONS_NAMES[c.t] ?? c.t} ${c.a}${c.b ? "–" + c.b : ""}`),
        c.t === "dim" ? h("div", { style: { width: "92px" } }, exprInput(c.v, (x) => edit((p) => { p.features.find((q) => q.id === f.id).cons.find((q) => q.id === c.id).v = x; }, { coalesce: `dim:${c.id}` }), {})) : null,
        h("button", { class: "iconbtn", title: "Delete", onclick: (e) => { e.stopPropagation(); edit((p) => { const t = p.features.find((q) => q.id === f.id); t.cons = t.cons.filter((q) => q.id !== c.id); }); } }, icon("trash")));
    }) : h("div", { class: "empty" }, "Use the Dimension tool (D) to give shapes exact sizes; values can be variables like width/2."))));
  if (f.entities?.length) out.push(h("div", { class: "section", style: { margin: "0 -12px" } }, h("header", {}, "Legacy shapes"),
    h("div", { class: "body" }, f.entities.map((e, i) => {
      const sel = SK.sel.has(`e${i}`);
      return h("div", {},
        h("div", { class: `ent ${sel ? "sel" : ""}`, onclick: () => { SK.sel = sel ? new Set() : new Set([`e${i}`]); emit(); } },
          icon(e.type === "polyline" ? "polyline" : e.type), h("span", { class: "grow" }, describe(e)), e.op === "subtract" ? h("span", { class: "tag sub" }, "cut") : null,
          h("button", { class: "iconbtn", title: "Delete shape", onclick: (ev) => { ev.stopPropagation(); deleteEntity(i); } }, icon("trash"))),
        sel ? h("div", { style: { padding: "6px 4px 2px 22px" } }, entityFields(e, i, f)) : null);
    }))));
  return out;
}

/** Onshape's "Sketch" dialog: choose the sketch plane (or click one in the viewport). */
function newSketchPanel() {
  const planes = [["XY", "Top", "#5b8cff"], ["XZ", "Front", "#3ecf8e"], ["YZ", "Right", "#ff6b7a"], ...S.part.features.filter((f) => f.type === "plane" && !f.hidden).map((f) => [f.id, f.name ?? f.id, "#b58cff"])];
  const start = (plane) => { S.pick = null; addFeature("sketch", { plane }); };
  return h("div", { class: "inspector" },
    h("h3", {}, "Sketch"), h("div", { class: "sub" }, "Select a sketch plane"),
    h("div", { class: "picklist active", style: { marginBottom: "10px" } }, "Click a plane or a flat face of a part in the viewport, or choose one below."),
    planes.map(([id, name, color]) => h("div", { class: "row", style: { padding: "8px 10px" }, onclick: () => start(id) }, h("span", { style: { width: "13px", height: "13px", borderRadius: "3px", background: color, opacity: 0.85, flex: "none" } }), h("span", { class: "name" }, name))),
    h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => { S.pick = null; emit(); } }, "Cancel")));
}

let lastSig = "";
export function renderInspector(root) {
  const f = S.selection ? feature(S.selection) : null;
  if (!f) { lastSig = ""; root.replaceChildren(helpPanel()); return; }
  const meta = FEATURES[f.type] ?? { label: f.type, fields: [] };
  const err = S.build.errors[f.id];
  const visible = meta.fields.filter((s) => !s.showIf || s.showIf(f));
  const sig = JSON.stringify([f.id, f.type, visible.map((s) => s.k), f.edges?.length, f.faces?.length, f.regions?.length, f.sketches?.join(), f.mode, f.draft, f.keep, f.entities?.length, f.cons?.length, [...SK.sel].join(), S.sketchEdit === f.id, SK.tool, sketchStatus()?.dof, sketchStatus()?.conflicting?.length, S.pick?.kind, !!err, S.draft === f.id, typeof f.plane, f.mode, f.style, f.through, S.build.stats.length, f.points?.length]);
  if (sig === lastSig && root.contains(document.activeElement) && document.activeElement.tagName === "INPUT") {
    // keep the caret: only refresh computed values
    root.querySelectorAll(".valwrap input").forEach((i) => i.dispatchEvent(new Event("calc")));
    return;
  }
  lastSig = sig;
  const children = [
    h("h3", {}, h("input", { class: "in", style: { fontWeight: 600, fontSize: "14px", padding: "3px 6px", border: "1px solid transparent", background: "transparent" }, value: f.name ?? meta.label, onfocus: (e) => (e.target.style.borderColor = "var(--line)"), onblur: (e) => (e.target.style.borderColor = "transparent"), onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); }, oninput: (e) => setFeature(f.id, { name: e.target.value }, `name:${f.id}`) })),
    h("div", { class: "sub" }, `${meta.label} · id ${f.id}`),
    err ? h("div", { class: "banner err", style: { position: "static", marginBottom: "12px", pointerEvents: "auto" } }, icon("warn"), h("div", { class: "grow", style: { userSelect: "text" } }, err)) : null,
    visible.map((s) => field(f, s)),
    f.type === "sketch" ? sketchSection(f) : null,
    f.type === "onshape" ? h("div", {}, h("div", { class: "help", style: { marginTop: 0 } }, "This feature exists in Onshape only. cadForMe keeps it exactly as it is and never changes it, but can't model it, so the 3D view here is missing its effect. Edit it in Onshape, then pull."),
      h("div", { class: "actions" }, h("button", { class: "btn", onclick: async () => { try { const i = await onshapeInfo(S.partPath); if (i.url) window.cad.invoke("onshape:open", i.url); } catch { /* not linked */ } } }, icon("cloud"), "Open in Onshape"))) : null,
  ];
  if (f.type === "extrude" || f.type === "revolve") children.push(h("div", { class: "help" }, "Tip: values can be expressions like ", h("code", {}, "width/2"), " using your variables."));
  if (!(f.type === "sketch" && S.sketchEdit === f.id)) children.push(h("div", { class: "actions" },
    S.draft === f.id ? [h("button", { class: "btn primary", onclick: () => { S.draft = null; S.pick = null; S.sketchEdit = null; emit(); } }, icon("check"), "Done"), h("button", { class: "btn", onclick: () => deleteFeature(f.id) }, "Cancel")]
      : [h("button", { class: "btn danger", onclick: () => deleteFeature(f.id) }, icon("trash"), "Delete"), h("button", { class: "btn ghost", onclick: () => select(null) }, "Close")]));
  root.replaceChildren(h("div", { class: "inspector" }, children));
}

const MATERIALS = [["Aluminum 6061", 2.7], ["Steel (mild)", 7.85], ["Stainless steel", 8.0], ["Brass", 8.5], ["Copper", 8.96], ["Titanium", 4.43], ["ABS plastic", 1.05], ["PLA plastic", 1.24], ["PETG plastic", 1.27], ["Nylon", 1.15], ["Oak wood", 0.75]];
const fmtMass = (g) => (g >= 1000 ? `${(g / 1000).toFixed(3)} kg` : `${g.toFixed(2)} g`);

// Assembly overview (nothing selected): how to use it, BOM, mate problems, overlaps.
function assemblyPanel() {
  const part = S.part, insts = instances(part), rows = bom(part, S.build);
  const sec = (title, ...kids) => h("div", { class: "section", style: { margin: "0 -12px" } }, h("header", {}, title), h("div", { class: "body", style: { padding: "0 12px 10px" } }, ...kids));
  const csv = () => {
    const text = ["Part Studio,Qty,Variable overrides", ...rows.map((r) => `"${r.name}",${r.qty},"${JSON.stringify(r.vars).replace(/"/g, "'")}"`)].join("\n");
    window.cad.invoke("export:save", { name: `${part.name ?? "assembly"} BOM`, ext: "csv", bytes: new TextEncoder().encode(text) });
  };
  return h("div", { class: "inspector" },
    h("h3", {}, part.name ?? "Assembly"), h("div", { class: "sub" }, `${insts.length} instance${insts.length === 1 ? "" : "s"} · ${mates(part).length} mate${mates(part).length === 1 ? "" : "s"}`),
    !insts.length ? h("div", { class: "note", style: { lineHeight: 1.7 } },
      h("div", {}, h("b", {}, "1. Insert"), " a Part Studio (toolbar). The first one is fixed in place."),
      h("div", {}, h("b", {}, "2. Fasten"), ": click a face on the part to move, then the face it should sit against."),
      h("div", {}, h("b", {}, "3. Move / Rotate"), " anything that isn't fastened by dragging the arrows or rings (W / E)."),
      h("button", { class: "btn primary", style: { marginTop: "10px" }, onclick: () => addFeature("insert") }, icon("cube"), "Insert a Part Studio")) : null,
    (S.mateProblems ?? []).length ? sec("Mate problems", ...S.mateProblems.map((m) => h("div", { class: "note", style: { color: "var(--orange)" } }, m))) : null,
    S.interference ? sec(`Interference (${S.interference.length})`, S.interference.length
      ? S.interference.map((x) => h("div", { class: "row", onclick: () => select(x.ownerA) }, icon("warn"), h("span", { class: "name" }, `${x.nameA} ↔ ${x.nameB}`), h("span", { class: "meta" }, x.volume < 0 ? "?" : `${(x.volume / 1000).toFixed(2)} cm³`)))
      : h("div", { class: "note", style: { color: "var(--green)" } }, "No overlaps: everything fits.")) : null,
    rows.length ? sec("Bill of materials",
      h("table", { class: "bom" }, h("tr", {}, h("th", {}, "Part Studio"), h("th", {}, "Qty")),
        rows.map((r) => h("tr", {}, h("td", {}, r.name, Object.keys(r.vars).length ? h("span", { class: "meta" }, ` (${Object.entries(r.vars).map(([k, v]) => `${k}=${v}`).join(", ")})`) : null), h("td", {}, String(r.qty))))),
      h("button", { class: "btn sm", style: { marginTop: "8px" }, onclick: csv }, icon("download"), "Export BOM (CSV)")) : null);
}

function helpPanel() {
  if (isAssembly(S.part)) return assemblyPanel();
  const st = S.build.stats, mat = S.part?.material;
  const owners = S.build.owners ?? [];
  const bodyName = (i) => { const f = S.part?.features.find((x) => x.id === owners[i]); const same = owners.filter((x) => x === owners[i]).length; return f ? (same > 1 ? `${f.name ?? f.id} ${owners.slice(0, i + 1).filter((x) => x === owners[i]).length}` : f.name ?? f.id) : `Part ${i + 1}`; };
  const total = st.reduce((a, m) => a + (m.mass ?? 0), 0);
  return h("div", { class: "inspector" },
    h("h3", {}, "Properties"), h("div", { class: "sub" }, "Select a feature to edit it."),
    S.part ? h("div", { class: "field" }, h("label", {}, "Material"), h("select", { class: "in", onchange: (e) => { const m = MATERIALS.find(([n]) => n === e.target.value); edit((p) => { if (m) p.material = { name: m[0], density: m[1] }; else delete p.material; }); } },
      h("option", { value: "" }, "(none)"), MATERIALS.map(([n, d]) => h("option", { value: n, selected: mat?.name === n }, `${n} · ${d} g/cm³`)))) : null,
    st.length ? st.map((m) => h("div", { class: "section", style: { margin: "0 -12px" } }, h("header", {}, bodyName(m.index)),
      h("div", { class: "body", style: { padding: "0 12px 10px", color: "var(--muted)", fontSize: "12.5px", lineHeight: 1.7 } },
        h("div", {}, `Volume ${(m.volume / 1000).toFixed(2)} cm³`), m.area == null ? null : h("div", {}, `Surface ${(m.area / 100).toFixed(2)} cm²`),
        m.mass !== null ? h("div", { style: { color: "var(--text)" } }, `Mass ${fmtMass(m.mass)}`) : null,
        m.com ? h("div", {}, `Centre of mass ${m.com.map((x) => x.toFixed(1)).join(", ")} mm`) : null,
        h("div", {}, `Size ${m.size.map((x) => x.toFixed(1)).join(" × ")} mm`)))) : h("div", { class: "empty", style: { padding: "0" } }, "No solid yet. Make a sketch, then extrude it."),
    st.length > 1 && total ? h("div", { class: "note", style: { marginTop: "8px" } }, `Total mass ${fmtMass(total)}`) : null,
    h("div", { class: "help" }, h("b", {}, "Navigate: "), "drag to orbit, scroll to zoom, right-drag to pan.", h("br"), h("b", {}, "Undo: "), "⌘Z. Edits save automatically; commit them in Version Control."));
}
