// cadForMe renderer entry: layout, toolbar, viewport wiring, keyboard, welcome screen.
import { h, icon, toast, modal, showMenu } from "./ui.js";
import { Viewport } from "./viewport.js";
import { S, emit, onChange, onBuild, setProject, undo, redo, addFeature, select, setFeature, edit, exportPart, onExternalChange, loadSettings, rebuild, exitView, deleteFeature, feature, createPart, refreshParts, effVars, loadPart, checkInterference, scanKinds, modelStepBytes } from "./state.js";
import { runDrcFor } from "./drc.js";
import { FEATURES, TOOLBAR } from "./features.js";
import { isAssembly, instMatrix, placement, toLocal, solveMates } from "./assembly.js";
import { renderInspector } from "./inspector.js";
import { renderDesign } from "./panels.js";
import { renderVc, vcBusy } from "./vcpanel.js";
import { renderAi, runAi } from "./aipanel.js";
import { openLibrary } from "./library.js";
import { openOnshapeDialog, sendToOnshape, pullOnshape } from "./onshapedlg.js";
import { SK, setTool, sketchHandlers, sketchKey, redraw, frameOfActive, resetSketchState, applyConstraint, toggleConstruction, deleteSelection, sketchStatus, sketchView, regionContains, mirrorSelection, offsetSelection } from "./sketch.js";
import { cloneDialog, settingsDialog, commandPalette, promptText, connectRemote } from "./dialogs.js";
import { perpendicular, planeFrames } from "../kernel/vec.js";
import { makeEvaluator } from "../kernel/expr.js";

const app = document.getElementById("app");
const cad = window.cad;
let vp = null, els = null, lastPartForFit = null;

// ---------- viewport wiring ----------
const pickMode = () => {
  const k = S.pick?.kind;
  if (k === "mate") return { faces: true, edges: false, planes: false };
  if (isAssembly(S.part) && !k && !S.measure && !S.view) return { faces: true, edges: false, planes: false };
  if (S.measure && !k && !S.sketchEdit) return { faces: true, edges: true, planes: false };
  if (!k && !S.sketchEdit && !S.view && S.part) return { faces: true, edges: true, planes: S.showPlanes }; // Onshape: click to pre-select
  if (k === "regions") { const sv = pickedSketchView(); return { region: sv?.frame ?? null }; }
  return { edges: k === "edges", faces: k === "faces" || k === "point" || k === "sketchface" || k === "newsketch", planes: k === "sketchface" || k === "newsketch", planarOnly: k === "sketchface" || k === "newsketch" };
};
const sketchFeatureOf = (f) => (f?.type === "sketch" ? f : f?.sketch ? feature(f.sketch) : null);
function pickedSketchView() { const sf = sketchFeatureOf(feature(S.pick?.id)); return sf ? sketchView(sf) : null; }
function startFeature(t) {
  const pre = S.sel; S.sel = null; vp?.setSelected(null);
  const extra = {};
  if ((t === "fillet" || t === "chamfer") && pre?.type === "edge") extra.edges = [{ p: round(pre.p) }];
  if (t === "shell" && pre?.type === "face") extra.faces = [{ p: round(pre.p), n: round(pre.n, 3) }];
  if (t === "hole" && pre?.type === "face") { extra.position = round(pre.p, 3); extra.normal = round(pre.n, 3); }
  const id = addFeature(t);
  if (id && Object.keys(extra).length) setFeature(id, extra, null);
}
async function startImport() {
  if (!S.part) { toast("Open or create a part first", "err"); return; }
  try {
    const rel = await cad.invoke("import:pick");
    if (rel) addFeature("import", { file: rel, name: await cad.invoke("import:name", rel).catch(() => rel.split("/").pop()) });
  } catch (e) { toast(e.message, "err"); }
}
function startInsert() {
  if (!S.part) { toast("Open or create a part first", "err"); return; }
  if (S.project.parts.length < 2) { toast("Make another part first, then insert it here", "err"); return; }
  addFeature("insert");
}
/** Onshape-style: pressing Sketch asks for a plane or a face first. */
export function startSketch() {
  if (!S.part) { toast("Open or create a part first", "err"); return; }
  // Onshape: a pre-selected flat face or plane is used straight away
  const pre = S.sel; S.sel = null; vp?.setSelected(null);
  if (pre?.type === "face" && pre.planar) { addFeature("sketch", { plane: faceFrame(pre) }); return; }
  if (pre?.type === "plane") { addFeature("sketch", { plane: pre.name }); return; }
  S.sketchEdit = null; S.selection = null; S.pick = { kind: "newsketch" }; emit();
}
/** Sketch frame for a picked face, like Onshape: origin = the part origin projected onto the face, axes aligned to the world. */
const faceFrame = (hit) => {
  const n = round(hit.n, 4), p = hit.p, d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
  const sgn = (x) => (x < 0 ? -1 : 1);
  const x = Math.abs(n[2]) > 0.99 ? [1, 0, 0] : Math.abs(n[1]) > 0.99 ? [-sgn(n[1]), 0, 0] : Math.abs(n[0]) > 0.99 ? [0, sgn(n[0]), 0] : perpendicular(n);
  return { origin: round(n.map((c) => c * d), 4), normal: n, xDir: round(x, 6) };
};
const round = (a, n = 4) => a.map((x) => Math.round(x * 10 ** n) / 10 ** n);

// Assemblies: a click selects the instance that owns the clicked body; Fasten picks two faces.
function pickMateFace(hit, owner) {
  if (!hit || hit.type !== "face" || !owner) return;
  const f = feature(owner); if (f?.type !== "insert") return;
  const loc = { inst: owner, ...toLocal(f, hit.p, hit.n) };
  if (!S.pick.first) { S.pick = { kind: "mate", first: loc }; emit(); return; }
  const first = S.pick.first;
  if (first.inst === owner) { toast("Pick a face on a different part", "err"); return; }
  let mover = first, anchor = loc;
  if (feature(mover.inst)?.fixed && !feature(anchor.inst)?.fixed) [mover, anchor] = [anchor, mover];
  S.pick = null;
  addFeature("mate", { kind: "fasten", a: anchor, b: mover, offset: 0, angle: 0 });
}
function onViewportClick(hit) {
  if (isAssembly(S.part) && !S.view && !S.measure) {
    const owner = hit && hit.body !== undefined ? S.build.owners?.[hit.body] ?? null : null;
    if (S.pick?.kind === "mate") { pickMateFace(hit, owner); return; }
    if (!S.pick) { select(owner); return; }
  }
  if (S.measure && !S.pick && !S.sketchEdit) {
    if (!hit || hit.type === "plane") return;
    const pt = hit.at ?? hit.p, m = S.measure;
    if (m.pts.length >= 2) { m.pts = []; m.kinds = []; }
    m.pts.push(pt); m.kinds.push(hit.type === "face" ? { n: hit.n } : { edge: true });
    vp.setMeasure(m.pts); emit(); return;
  }
  const pk = S.pick;
  if (!pk) { S.sel = hit ? { ...hit } : null; vp.setSelected(S.sel); emit(); return; } // pre-selection
  if (pk.kind === "newsketch") {
    if (!hit || (hit.type === "face" && !hit.planar)) return;
    if (hit.type === "plane") { S.pick = null; addFeature("sketch", { plane: hit.name }); }
    else if (hit.type === "face") { S.pick = null; addFeature("sketch", { plane: faceFrame(hit) }); }
    return;
  }
  const f = feature(pk.id); if (!f) return;
  if (!hit) { return; }
  if (pk.kind === "regions" && hit.type === "region") {
    const sv = pickedSketchView(); const r = sv?.regions.find((x) => regionContains(x, hit.p)); if (!r) return;
    const cur = f.regions ?? [];
    const inside = cur.filter((p) => regionContains(r, p));
    setFeature(f.id, { regions: inside.length ? cur.filter((p) => !regionContains(r, p)) : [...cur, round(hit.p, 4)] }, null);
    return;
  }
  if (pk.kind === "edges" && hit.type === "edge") {
    const p = round(hit.p);
    const idx = (f.edges ?? []).findIndex((r) => Math.hypot(r.p[0] - p[0], r.p[1] - p[1], r.p[2] - p[2]) < 0.01);
    setFeature(f.id, { edges: idx >= 0 ? f.edges.filter((_, i) => i !== idx) : [...(f.edges ?? []), { p }] }, null);
  } else if (pk.kind === "faces" && hit.type === "face") {
    const p = round(hit.p), n = round(hit.n, 3);
    const idx = (f.faces ?? []).findIndex((r) => Math.hypot(r.p[0] - p[0], r.p[1] - p[1], r.p[2] - p[2]) < 0.2 && r.n[0] * n[0] + r.n[1] * n[1] + r.n[2] * n[2] > 0.9);
    setFeature(f.id, { faces: idx >= 0 ? f.faces.filter((_, i) => i !== idx) : [...(f.faces ?? []), { p, n }] }, null);
  } else if (pk.kind === "point" && hit.type === "face") {
    setFeature(f.id, { position: round(hit.p, 3), normal: round(hit.n, 3) }, null);
  } else if (pk.kind === "sketchface") {
    if (hit.type === "face" && !hit.planar) return;
    if (hit.type === "plane") { setFeature(f.id, { plane: hit.name, offset: 0 }, null); S.pick = null; emit(); }
    else if (hit.type === "face") {
      setFeature(f.id, { plane: faceFrame(hit), offset: 0 }, null);
      S.pick = null; emit();
    }
  }
}

function syncViewport() {
  if (!vp) return;
  const f = S.selection ? feature(S.selection) : null;
  const refs = [];
  if (f && !S.view) {
    (f.edges ?? []).forEach((r) => refs.push({ kind: "edge", p: r.p }));
    (f.faces ?? []).forEach((r) => refs.push({ kind: "face", p: r.p, n: r.n }));
    if (f.type === "hole" && Array.isArray(f.position) && f.position.every((x) => typeof x === "number")) refs.push({ kind: "point", p: f.position });
  }
  vp.setPicks(refs);
  try {
    const frames = S.part && !S.view ? planeFrames(S.part, makeEvaluator(effVars())) : new Map();
    vp.setUserPlanes([...frames].filter(([id]) => !feature(id)?.hidden).map(([id, fr]) => ({ id, frame: fr, selected: id === S.selection })), S.pick?.kind === "newsketch");
  } catch { vp.setUserPlanes([]); }
  // finished sketches (thin curves) and shaded regions, like Onshape
  const editing = S.sketchEdit && !S.view;
  const used = new Set((S.part?.features ?? []).filter((x) => x.sketch).map((x) => x.sketch));
  const showSk = [];
  if (S.part && !editing) for (const sf of S.part.features) if (sf.type === "sketch" && !sf.suppressed && !sf.hidden && (!used.has(sf.id) || sf.id === S.selection || sf.id === f?.sketch)) { const v = sketchView(sf); if (v) showSk.push({ frame: v.frame, curves: v.curves, color: sf.id === S.selection || sf.id === f?.sketch ? 0x7aa2ff : 0x5b6f9a }); }
  vp.setSketchView(showSk);
  const rsk = !editing && f ? sketchFeatureOf(f) : null, rv = rsk ? sketchView(rsk) : null;
  if (rv && (f.type === "sketch" || f.type === "extrude" || f.type === "revolve")) {
    const chosen = f.type === "sketch" ? [] : f.regions ?? [];
    vp.setRegions(rv.frame, rv.regions.map((r) => ({ outer: r.outer, holes: r.holes, selected: f.type !== "sketch" && (!chosen.length || chosen.some((p) => regionContains(r, p))) })));
  } else vp.setRegions(null, []);
  const frame = S.sketchEdit && !S.view ? frameOfActive() : null;
  if (frame) { vp.enterSketch(frame); redraw(vp); } else { vp.exitSketch(); document.getElementById("sklabels")?.replaceChildren(); }
  vp.setPlanesVisible(S.showPlanes || S.pick?.kind === "sketchface" || S.pick?.kind === "newsketch" || (!S.build.stats.length && !frame && !!S.part && !S.build.busy), S.pick?.kind === "newsketch" || S.pick?.kind === "sketchface");
  vp.setHidden(S.hidden);
  vp.setSection(S.section ? { axis: S.section.axis, pos: S.section.pos, flip: S.section.flip } : null);
  if (!S.measure) vp.setMeasure([]);
  // assembly: move/rotate gizmo on the selected instance (unless it's fixed or placed by a mate), exploded view
  const asm = isAssembly(S.part) && !S.view;
  const driven = asm ? solveMates(structuredClone(S.part)).driven : new Set();
  const inst = asm && f?.type === "insert" && f.orient !== undefined && !f.fixed && !driven.has(f.id) && !S.pick && !S.explode ? f : null;
  if (inst) {
    const M = instMatrix(inst), inv = M.clone().invert(), mode = S.gizmoMode ?? "translate";
    vp.attachGizmo(`${inst.id}|${JSON.stringify([inst.position, inst.orient])}|${mode}`, M, mode, {
      onDrag: (proxy) => vp.setOwnerDelta(inst.id, proxy.matrix.clone().multiply(inv)),
      onCommit: (proxy) => setFeature(inst.id, placement(proxy.position, proxy.quaternion), null),
    });
  } else vp.detachGizmo();
  vp.setExplode(asm ? S.explode ?? 0 : 0, asm ? (S.part.features.find((x) => x.type === "insert" && x.fixed)?.id ?? null) : null);
}

onBuild(() => {
  if (!vp) return;
  const fit = lastPartForFit !== (S.view?.id ?? S.partPath);
  vp.setBodies(S.build.meshes, { refit: fit && S.build.meshes.length > 0 });
  vp.setOwners(S.build.owners);
  if (fit && S.build.meshes.length) lastPartForFit = S.view?.id ?? S.partPath;
  vp.setGhost(S.view && S.showGhost ? S.ghostBuild?.meshes ?? null : null);
  syncViewport();
});

// ---------- chrome ----------
function topbar() {
  const st = S.vc.status;
  const synced = S.project?.config?.remote;
  const partName = S.part?.name || S.partPath?.replace(/^parts\//, "").replace(".part.json", "");
  return h("div", { class: "topbar" },
    h("div", { class: "brand" }, "cad", h("b", {}, "ForMe")),
    h("div", { class: "crumb" }, h("strong", {}, S.project.name), partName ? ` / ${partName}` : ""),
    h("div", { class: "pill", style: { cursor: "pointer" }, title: "Version control", onclick: () => { S.tab = "vc"; emit(); } }, icon("branch"), st?.branch ?? "main", st?.changes.length ? h("span", { class: "badge" }, st.changes.length) : null),
    synced ? h("div", { class: "pill", style: { cursor: "pointer" }, title: "Sync with team", onclick: () => { S.tab = "vc"; emit(); } }, icon("cloud"), `↓${st?.behind ?? 0}  ↑${st?.ahead ?? 0}`) : null,
    h("div", { class: "spacer" }),
    h("button", { class: "btn ghost", title: "Undo (⌘Z)", disabled: !S.undo.length || !!S.view, onclick: undo }, icon("undo")),
    h("button", { class: "btn ghost", title: "Redo (⇧⌘Z)", disabled: !S.redo.length || !!S.view, onclick: redo }, icon("redo")),
    h("button", { class: "btn", disabled: !S.part, title: "Design check: build errors, loose pieces, thin spots, screw holes, printer bed, Onshape readiness. Unchanged parts are skipped", onclick: () => S.partPath && runDrcFor([S.partPath]) }, icon("check"), "DRC"),
    h("button", { class: "btn", title: "Onshape: import, push, pull", onclick: openOnshapeDialog }, icon("cloud"), "Onshape"),
    h("button", { class: "btn", title: "Search every command (⌘K)", onclick: openPalette }, "Search  ⌘K"),
    h("button", { class: "btn", disabled: !S.build.stats.length, title: "Export this part", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, [
      { label: "STL (3D printing)", run: () => exportPart("stl") },
      { label: "STEP (other CAD)", run: () => exportPart("step") },
      { label: "Drawing (SVG, dimensioned views)", run: () => exportPart("drawing") }]); } }, icon("download"), "Export ▾"),
    h("button", { class: "btn ghost", title: "Settings (your name, GitHub)", onclick: settingsDialog }, icon("gear")));
}

// Onshape's sketch toolbar replaces the part toolbar while a sketch is open.
function variantTool(kind) {
  const vars = kind === "rect" ? [["rect", "Corner rectangle", "rect"], ["crect", "Centre-point rectangle", "rect"]] : [["arc3", "3-point arc", "arc"], ["tarc", "Tangent arc", "arc"], ["arcc", "Centre-point arc", "arc"]];
  const cur = vars.find(([t]) => t === (kind === "rect" ? SK.rectVar : SK.arcVar));
  const active = vars.some(([t]) => t === SK.tool);
  return h("div", { class: "toolsplit" },
    h("button", { class: `tool ${active ? "active" : ""}`, title: cur[1], onclick: () => setTool(cur[0]) }, icon(cur[2]), h("span", { class: "lbl" }, cur[1].includes("rectangle") ? "Rectangle" : "Arc")),
    h("button", { class: "caret", title: "More options", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, vars.map(([t, label]) => ({ label: `${t === cur[0] ? "✓ " : "   "}${label}`, run: () => { if (kind === "rect") SK.rectVar = t; else SK.arcVar = t; setTool(t); } }))); } }, "▾"));
}
function sketchToolbar() {
  const T = (t, ic, l, title) => h("button", { class: `tool ${SK.tool === t ? "active" : ""}`, title: title ?? l, onclick: () => setTool(SK.tool === t ? "select" : t) }, icon(ic), h("span", { class: "lbl" }, l));
  const A = (ic, l, title, run, on = false) => h("button", { class: `tool ${on ? "active" : ""}`, title, onclick: run }, icon(ic), h("span", { class: "lbl" }, l));
  const C = (k, glyph, l) => h("button", { class: "tool", title: `${l} (select shapes first)`, onclick: () => applyConstraint(k) }, h("span", { class: "g" }, glyph), h("span", { class: "lbl" }, l));
  return h("div", { class: "toolbar sketching" },
    h("div", { class: "group" }, T("line", "line", "Line", "Line (L)"), variantTool("rect"), T("circle", "circle", "Circle", "Centre-point circle (C)"), variantTool("arc"), T("ellipse", "ellipse", "Ellipse"), T("polygon", "polygon", "Polygon"), T("slot", "slot", "Slot"), T("point", "pointi", "Point", "Point (P)")),
    h("div", { class: "group" }, A("constr", "Construction", "Toggle construction (Q)", toggleConstruction, SK.construction)),
    h("div", { class: "group" }, T("sfillet", "fillet", "Fillet", "Sketch fillet: click a corner"), T("trim", "delete", "Trim", "Trim (T): click the piece to remove"), A("circular", "Offset", "Offset the selected loop or circles", offsetSelection), A("mirror", "Mirror", "Mirror the selected shapes across a line", mirrorSelection, SK.tool === "mirror")),
    h("div", { class: "group" }, T("dim", "dim", "Dimension", "Dimension (D)")),
    h("div", { class: "group" }, C("coincident", "●", "Coincident"), C("concentric", "◎", "Concentric"), C("parallel", "∥", "Parallel"), C("tangent", "T", "Tangent"), C("horizontal", "H", "Horizontal"), C("vertical", "V", "Vertical"),
      C("perpendicular", "⟂", "Perpendicular"), C("equal", "=", "Equal"), C("midpoint", "M", "Midpoint"), C("symmetric", "⇋", "Symmetric"), C("fix", "▣", "Fix")));
}

async function runInterference() {
  toast("Checking for overlaps…");
  try {
    const r = await checkInterference();
    S.interference = r.hits.map((x) => ({ ...x, nameA: feature(x.ownerA)?.name ?? x.ownerA, nameB: feature(x.ownerB)?.name ?? x.ownerB }));
    S.selection = null; emit();
    toast(r.hits.length ? `${r.hits.length} overlap${r.hits.length === 1 ? "" : "s"} found (listed on the right)` : "No overlaps: everything fits", r.hits.length ? "err" : "ok");
  } catch (e) { toast(e.message, "err"); }
}
// Assemblies get their own toolbar (Onshape-style): insert, mate, move/rotate, fix, explode, interference.
function assemblyToolbar() {
  const dis = !S.part || !!S.view;
  const f = S.selection ? feature(S.selection) : null, inst = f?.type === "insert" ? f : null;
  const tool = (ic, label, title, on, run, off = false) => h("button", { class: `tool ${on ? "active" : ""}`, disabled: dis || off, title, onclick: run }, icon(ic), label);
  return h("div", { class: "toolbar" },
    h("div", { class: "group" },
      tool("cube", "Insert", "Insert a Part Studio (or another assembly) into this assembly", false, startInsert),
      tool("link", "Fasten", "Fasten mate: click a face on the part to move, then the face it should sit against", S.pick?.kind === "mate", () => { S.explode = 0; S.pick = S.pick?.kind === "mate" ? null : { kind: "mate" }; S.selection = null; emit(); })),
    h("div", { class: "group" },
      tool("transform", "Move", "Drag the arrows to move the selected part (W)", (S.gizmoMode ?? "translate") === "translate", () => { S.gizmoMode = "translate"; emit(); }),
      tool("rotate3d", "Rotate", "Drag the rings to rotate the selected part (E)", S.gizmoMode === "rotate", () => { S.gizmoMode = "rotate"; emit(); }),
      tool("pin", inst?.fixed ? "Unfix" : "Fix", "Fix the selected part so it never moves", !!inst?.fixed, () => inst && setFeature(inst.id, { fixed: !inst.fixed }), !inst)),
    h("div", { class: "group" },
      tool("explode", "Explode", "Spread the parts apart to see how it goes together", !!S.explode, () => { S.explode = S.explode ? 0 : 0.6; emit(); }),
      S.explode ? h("input", { type: "range", min: 0.1, max: 1.5, step: 0.05, value: S.explode, title: "How far apart", style: { width: "110px", alignSelf: "center" }, oninput: (e) => { S.explode = Number(e.target.value); vp?.setExplode(S.explode); } }) : null,
      tool("warn", "Interference", "Find parts that overlap", false, runInterference)));
}

function toolbar() {
  if (S.sketchEdit && !S.view) return sketchToolbar();
  if (isAssembly(S.part)) return assemblyToolbar();
  const dis = !S.part || !!S.view;
  return h("div", { class: "toolbar" }, TOOLBAR.map((group) => h("div", { class: "group" }, group.map((t) => {
    const f = FEATURES[t];
    const active = S.selection && feature(S.selection)?.type === t && S.draft;
    return h("button", { class: `tool ${active ? "active" : ""}`, disabled: dis, title: f.label, onclick: () => (t === "sketch" ? startSketch() : t === "import" ? startImport() : t === "insert" ? startInsert() : startFeature(t)) }, icon(f.icon), f.label.replace("Linear pattern", "Lin. pat.").replace("Circular pattern", "Circ. pat.").replace("Delete body", "Delete").replace("Move / rotate", "Move").replace("Insert part", "Insert"));
  }))));
}

function leftPanel() {
  const nChanges = S.vc.status?.changes.length ?? 0;
  const tabs = h("div", { class: "tabs" },
    h("button", { class: `tab ${S.tab === "design" ? "active" : ""}`, onclick: () => { S.tab = "design"; emit(); } }, "Design"),
    h("button", { class: `tab ${S.tab === "vc" ? "active" : ""}`, onclick: () => { S.tab = "vc"; emit(); } }, "Version control ", nChanges ? h("span", { class: "badge" }, nChanges) : null),
    h("button", { class: `tab ${S.tab === "ai" ? "active" : ""}`, onclick: () => { S.tab = "ai"; emit(); } }, "AI"));
  const body = h("div", { class: "scroll", id: "leftscroll" });
  return { tabs, body };
}

const HINTS = {
  select: "Click to select (⇧ to add), drag shapes to move them. Pick constraints above to apply them to the selection",
  line: "Click points to chain lines. Click the first point (or Esc) to finish. Near-horizontal/vertical lines auto-constrain; hold ⌥ for none",
  rect: "Click two opposite corners", crect: "Click the centre, then a corner", circle: "Click the centre, then a point on the circle",
  arc3: "Click the start, the end, then a point on the arc", arcc: "Click the centre, the start, then the end direction", polygon: `Click the centre, then a corner (${SK.sides} sides)`,
  slot: "Click the two end centres, then set the width", point: "Click to place a point",
  ellipse: "Click the centre, the end of the long axis, then a point on the short side", trim: "Click the piece of a line, arc or circle to remove, back to the nearest crossing", sfillet: "Click a corner where two lines meet, then type the radius", mirror: "Click the line to mirror across",
  tarc: "Click the end of a line or arc, then where the arc should end",
  dim: "Click a line, circle, arc, or two shapes (points / lines), then type the value. ⇧ = horizontal/vertical distance",
};
const planeLabel = (pl) => (typeof pl === "string" ? ({ XY: "Top plane", XZ: "Front plane", YZ: "Right plane" }[pl] ?? feature(pl)?.name ?? pl) : "Face of part");
/** Onshape-style feature dialog for sketches: name, Sketch plane selection, ✓ / ✗. */
function sketchDialog() {
  const f = S.sketchEdit ? feature(S.sketchEdit) : S.pick?.id ? feature(S.pick.id) : null;
  const picking = S.pick?.kind === "newsketch" || S.pick?.kind === "sketchface";
  const st = f && S.sketchEdit ? sketchStatus() : null;
  const finish = () => { S.sketchEdit = null; S.pick = null; S.draft = null; sketchSnap = null; emit(); };
  const cancel = () => {
    if (S.pick?.kind === "newsketch") { S.pick = null; emit(); return; }
    const snap = sketchSnap; S.sketchEdit = null; S.pick = null;
    if (snap?.isNew) deleteFeature(snap.id);
    else if (snap) edit((p) => { const old = JSON.parse(snap.json); p.features = old.features; p.variables = old.variables; });
    sketchSnap = null; S.draft = null; emit();
  };
  return h("div", { class: "overlay featdlg" },
    h("div", { class: "fd-head" }, icon("sketch"), h("span", { class: "fd-title" }, f?.name ?? "Sketch"),
      h("button", { class: "fd-ok", title: "Finish sketch (Enter)", disabled: !f, onclick: finish }, icon("check")),
      h("button", { class: "fd-x", title: "Cancel (Esc)", onclick: cancel }, icon("close"))),
    h("div", { class: "fd-body" },
      h("div", { class: "fd-label" }, "Sketch plane"),
      h("div", { class: `fd-sel ${picking ? "active" : ""}`, title: "Click, then pick a plane or a flat face", onclick: () => { if (f) { S.pick = { kind: "sketchface", id: f.id }; emit(); } } },
        picking ? "Select a plane or a flat face" : planeLabel(f?.plane)),
      f ? h("label", { class: "check", style: { marginTop: "8px" } }, h("input", { type: "checkbox", checked: SK.showCons, onchange: (e) => { SK.showCons = e.target.checked; redraw(vp); } }), "Show constraints") : null,
      f && S.sketchEdit ? h("div", { class: "help", style: { marginTop: "8px" } }, "Right-drag (two-finger click-drag) to rotate · ⇧ right-drag to pan · ", h("a", { href: "#", style: { color: "var(--accent)" }, onclick: (e) => { e.preventDefault(); vp.normalToSketch(); } }, "Normal to sketch (N)")) : null,
      st && !st.empty ? h("div", { style: { marginTop: "8px" } }, st.conflicting?.length ? h("span", { class: "statchip bad" }, "Over-defined") : st.dof === 0 ? h("span", { class: "statchip ok" }, "Fully defined") : h("span", { class: "statchip under" }, `Under-defined · ${st.dof} DOF`)) : null));
}
let sketchSnap = null, lastSketchEdit = null;
function trackSketchSession() {
  if (S.sketchEdit && S.sketchEdit !== lastSketchEdit) sketchSnap = { id: S.sketchEdit, json: JSON.stringify(S.part), isNew: S.draft === S.sketchEdit };
  if (!S.sketchEdit) sketchSnap = null;
  lastSketchEdit = S.sketchEdit;
}

function overlays() {
  trackSketchSession();
  const out = [];
  if ((S.sketchEdit && !S.view) || S.pick?.kind === "newsketch" || (S.pick?.kind === "sketchface" && feature(S.pick.id)?.type === "sketch")) out.push(sketchDialog());
  if (S.sketchEdit && !S.view) {
    out.push(h("div", { class: "overlay hint", style: { top: "auto", bottom: "44px" } }, HINTS[SK.tool] ?? ""));
    out.push(h("div", { class: "overlay cursorinfo" }, SK.info));
  } else if (S.pick) {
    const f = feature(S.pick.id); const n = f?.[S.pick.kind]?.length ?? 0;
    if (S.pick.kind === "mate") { out.push(h("div", { class: "overlay hint" }, S.pick.first ? "Now click the face it should sit against (Esc to cancel)" : "Fasten: click a face on the part you want to move (Esc to cancel)")); }
    else {
    const msg = { edges: `Click edges to add or remove them (${n} selected)`, faces: `Click faces to add or remove them (${n} selected)`, point: "Click a face to place the hole", sketchface: "Click a plane or a face to sketch on", newsketch: "Pick a plane or a flat face to sketch on (Esc to cancel)", regions: "Click sketch regions to include them. Nothing picked = all regions" }[S.pick.kind];
    out.push(h("div", { class: "overlay hint" }, msg));
  } }
  if (S.view) out.push(h("div", { class: "overlay banner" }, icon("eye"), h("div", { class: "grow" }, h("b", {}, "Viewing an older version"), `  ${S.view.id.slice(0, 7)} · read-only. `, S.showGhost ? "Orange = your current work." : ""),
    h("button", { class: `btn sm ${S.showGhost ? "on" : ""}`, onclick: () => { S.showGhost = !S.showGhost; rebuild(); } }, "Compare"), h("button", { class: "btn sm primary", onclick: exitView }, "Back to current")));
  else if (S.error) out.push(h("div", { class: "overlay banner err" }, icon("warn"), h("div", { class: "grow", style: { userSelect: "text" } }, S.error), h("button", { class: "btn sm", onclick: () => { S.error = null; emit(); } }, "Dismiss")));
  if (S.measure && !S.sketchEdit) {
    const m = S.measure, [a, b] = m.pts;
    const fmt = (v) => v.toFixed(3).replace(/\.?0+$/, "");
    let body;
    if (a && b) {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], dist = Math.hypot(...d);
      const na = m.kinds[0]?.n, nb = m.kinds[1]?.n;
      const ang = na && nb ? (Math.acos(Math.max(-1, Math.min(1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]))) * 180) / Math.PI : null;
      body = [h("div", {}, "Distance ", h("b", {}, `${fmt(dist)} mm`)), h("div", {}, `ΔX ${fmt(d[0])}   ΔY ${fmt(d[1])}   ΔZ ${fmt(d[2])}`), ang !== null ? h("div", {}, "Angle between faces ", h("b", {}, `${fmt(ang)}°`)) : null];
    } else body = h("div", {}, a ? "Click a second point" : "Click two points on the model (faces or edges)");
    out.push(h("div", { class: "overlay measure" }, h("div", { style: { display: "flex", gap: "12px", alignItems: "center" } }, h("b", {}, "Measure"), h("button", { class: "btn sm", onclick: () => { S.measure = null; emit(); } }, "Done")), body));
  }
  if (S.section && !S.sketchEdit) {
    const sc = S.section, bb = S.build.stats.length ? S.build.stats.reduce((acc, m) => [acc[0].map((v, i) => Math.min(v, m.bounds[0][i])), acc[1].map((v, i) => Math.max(v, m.bounds[1][i]))], [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]]) : [[-50, -50, -50], [50, 50, 50]];
    const i = { x: 0, y: 1, z: 2 }[sc.axis], lo = bb[0][i] - 1, hi = bb[1][i] + 1;
    out.push(h("div", { class: "overlay section-panel" }, h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: "8px" } }, h("b", {}, "Section view"), h("button", { class: "btn sm", onclick: () => { S.section = null; emit(); } }, "Done")),
      h("div", { class: "seg", style: { marginBottom: "8px" } }, ["x", "y", "z"].map((a) => h("button", { class: sc.axis === a ? "on" : "", onclick: () => { const j = { x: 0, y: 1, z: 2 }[a]; S.section = { ...sc, axis: a, pos: (bb[0][j] + bb[1][j]) / 2 }; emit(); } }, a.toUpperCase()))),
      h("input", { type: "range", min: lo, max: hi, step: (hi - lo) / 200, value: sc.pos, oninput: (e) => { S.section = { ...sc, pos: Number(e.target.value) }; vp.setSection(S.section); redrawSectionLabel(e.target); } }),
      h("div", { class: "note", style: { marginTop: "4px" }, id: "seclabel" }, `${sc.axis.toUpperCase()} = ${sc.pos.toFixed(1)} mm`),
      h("label", { class: "check", style: { marginTop: "6px" } }, h("input", { type: "checkbox", checked: sc.flip, onchange: (e) => { S.section = { ...sc, flip: e.target.checked }; emit(); } }), "Flip side")));
  }
  out.push(h("div", { class: "overlay vbtns" },
    h("button", { class: `btn sm ${S.measure ? "on" : ""}`, title: "Measure distances and angles", onclick: () => { S.measure = S.measure ? null : { pts: [], kinds: [] }; S.pick = null; emit(); } }, icon("ruler")),
    h("button", { class: `btn sm ${S.section ? "on" : ""}`, title: "Section view", onclick: () => { S.section = S.section ? null : { axis: "z", pos: S.build.stats.length ? (S.build.stats[0].bounds[0][2] + S.build.stats[0].bounds[1][2]) / 2 : 0, flip: false }; emit(); } }, icon("section")),
    h("button", { class: "btn sm", title: "Isometric view", onclick: () => vp.setView("iso") }, "Iso"),
    h("button", { class: "btn sm", title: "Fit to view", onclick: () => vp.fit() }, icon("fit"))));
  return out;
}

function redrawSectionLabel(el) { const l = document.getElementById("seclabel"); if (l && S.section) l.textContent = `${S.section.axis.toUpperCase()} = ${Number(el.value).toFixed(1)} mm`; }

function statusbar() {
  const b = S.build, errs = Object.keys(b.errors).length;
  const tot = b.stats.reduce((a, m) => a + m.volume, 0);
  return h("div", { class: "status" },
    h("span", { class: b.busy ? "" : errs ? "bad" : "ok" }, b.busy ? (S.part?.features?.some((f) => f.type === "import") && S.part.features.length > 60 ? "Rebuilding… large model, about 90 seconds the first time" : "Rebuilding…") : errs ? `${errs} feature${errs === 1 ? "" : "s"} with errors` : S.part ? `Built in ${b.ms} ms` : ""),
    b.stats.length ? h("span", {}, `${b.stats.length} bod${b.stats.length === 1 ? "y" : "ies"} · ${(tot / 1000).toFixed(2)} cm³`) : null,
    h("span", { class: "grow" }), S.view ? h("span", {}, "Read-only history view") : S.part ? h("span", {}, "Autosaved") : null,
    vcBusy() ? h("span", {}, `Syncing (${vcBusy()})…`) : null);
}

// ---------- render ----------
let leftEls = null;
function typingIn(root) { const a = document.activeElement; return a && root?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }

function build() {
  app.replaceChildren();
  app.className = "";
  els = { top: h("div"), tool: h("div"), left: h("div", { class: "left" }), view: h("div", { class: "viewwrap" }), right: h("div", { class: "right" }), status: h("div") };
  const canvas = h("canvas", { id: "viewport", tabindex: "0" });
  els.view.append(canvas); els.over = h("div"); els.view.append(els.over);
  app.append(els.top, els.tool, els.left, els.view, els.right, els.status);
  leftEls = leftPanel(); els.left.append(leftEls.tabs, leftEls.body);
  const handlers = { pickMode, onClick: onViewportClick, hidden: () => S.hidden, colors: () => S.part?.colors ?? {}, onCube: (v) => { if (S.sketchEdit) return; vp.setView(v); } };
  vp = new Viewport(els.view, handlers);
  Object.assign(handlers, sketchHandlers(vp));
  window.__vp = vp;
}

function render() {
  if (!S.project) { renderWelcome(); return; }
  if (!els) build();
  const setIf = (el, node) => { el.replaceWith(node); return node; };
  els.top = setIf(els.top, topbar()); els.tool = setIf(els.tool, toolbar()); els.status = setIf(els.status, statusbar());
  const t = leftPanel(); leftEls.tabs.replaceWith(t.tabs); leftEls.tabs = t.tabs;
  if (!typingIn(leftEls.body)) { S.tab === "vc" ? renderVc(leftEls.body) : S.tab === "ai" ? renderAi(leftEls.body) : renderDesign(leftEls.body); }
  const f = S.selection ? feature(S.selection) : null;
  app.classList.toggle("no-right", false);
  if (!typingIn(els.right) || !f) renderInspector(els.right); else renderInspector(els.right);
  els.over.replaceWith(h("div", {}, overlays())); els.over = els.view.lastElementChild;
  syncViewport();
}
onChange(render);
document.addEventListener("focusout", () => setTimeout(() => { if (S.project && !typingIn(leftEls?.body)) emit(); }, 30));

// ---------- welcome ----------
async function openFolder(dir) {
  try {
    let info = await cad.invoke("project:open", dir);
    if (info.needsInit) {
      let sample = false;
      const ok = await modal({ title: "Start a cadForMe project here?", body: h("div", {}, h("div", { class: "note", style: { marginBottom: "10px", userSelect: "text" } }, dir),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: false, onchange: (e) => { sample = e.target.checked; } }), "Include an example part (Bracket)")),
        actions: [{ label: "Cancel" }, { label: "Create project", primary: true, value: true }] });
      if (!ok) return;
      info = await cad.invoke("project:init", dir, { sample });
    }
    resetSketchState(); lastPartForFit = null; els = null;
    await setProject(info);
  } catch (e) { toast(e.message, "err"); }
}
async function newOrOpen() { const dir = await cad.invoke("project:pick"); if (dir) openFolder(dir); }
async function doClone() {
  const spec = await cloneDialog(); if (!spec) return;
  const dir = await cad.invoke("project:pick"); if (!dir) return;
  try { toast("Cloning…"); const info = await cad.invoke("project:clone", { spec, dir }); lastPartForFit = null; els = null; await setProject(info); toast("Cloned", "ok"); }
  catch (e) { toast(e.message, "err"); }
}

function renderWelcome() {
  els = null; vp = null;
  app.className = "";
  // Just one thing to do: open a folder. (New project / clone / recent live in the File menu.)
  app.replaceChildren(h("div", { class: "welcome", style: { gridRow: "1 / -1" } }, h("div", { class: "card", style: { textAlign: "center" } },
    h("h1", {}, "cad", h("b", {}, "ForMe")),
    h("div", { class: "big", style: { gridTemplateColumns: "1fr", maxWidth: "260px", margin: "18px auto 0" } },
      h("button", { onclick: newOrOpen }, icon("folder"), "Open Folder")),
    h("p", { class: "note", style: { marginTop: "14px" } }, "Pick any folder. If it isn't a cadForMe project yet, you can start one there."))));
}

// ---------- commands & keyboard ----------
function commands() {
  const c = [];
  for (const [t, f] of Object.entries(FEATURES)) if (t !== "onshape" && t !== "mate") c.push({ name: `Add ${f.label}`, run: () => addFeature(t) });
  c.push({ name: "Undo", key: "⌘Z", run: undo }, { name: "Redo", key: "⇧⌘Z", run: redo },
    { name: "Fit view", key: "F", run: () => vp?.fit() }, { name: "View: Isometric", run: () => vp?.setView("iso") }, { name: "View: Top", run: () => vp?.setView("top") }, { name: "View: Front", run: () => vp?.setView("front") }, { name: "View: Right", run: () => vp?.setView("right") },
    { name: "Export STL", run: () => exportPart("stl") }, { name: "Export STEP", run: () => exportPart("step") }, { name: "Export drawing (SVG)", run: () => exportPart("drawing") },
    { name: "New part", run: async () => { const n = await promptText("New part", "Part name", "", "Create"); if (n) createPart(n); } },
    { name: "Onshape…", run: openOnshapeDialog }, { name: "Send part to Onshape", run: () => S.partPath && sendToOnshape(S.partPath).catch((e) => toast(e.message, "err")) }, { name: "Pull part from Onshape", run: () => S.partPath && pullOnshape(S.partPath).catch((e) => toast(e.message, "err")) }, { name: "Go to AI", run: () => { S.tab = "ai"; emit(); } },
    { name: "Design check (DRC): this part", run: () => S.partPath && runDrcFor([S.partPath]) }, { name: "Design check (DRC): all parts (skips unchanged)", run: async () => runDrcFor(await cad.invoke("fs:list")) },
    { name: "Standard parts library…", run: openLibrary }, { name: "Measure", run: () => { S.measure = { pts: [], kinds: [] }; emit(); } }, { name: "Section view", run: () => { S.section = { axis: "z", pos: 0, flip: false }; emit(); } }, { name: "Toggle planes", run: () => { S.showPlanes = !S.showPlanes; emit(); } },
    { name: "Go to Design", run: () => { S.tab = "design"; emit(); } }, { name: "Go to Version control", run: () => { S.tab = "vc"; emit(); } },
    { name: "Connect to GitHub…", run: async () => { const s = await connectRemote(S.project.config?.remote); if (s) { S.project = { ...S.project, ...(await cad.invoke("vcs:setRemote", s)) }; emit(); } } },
    { name: "Open project…", run: newOrOpen }, { name: "Clone from team…", run: doClone }, { name: "Reveal project in Finder", run: () => cad.invoke("fs:reveal") }, { name: "Settings", run: settingsDialog });
  return c;
}
async function openPalette() { if (!S.project) return; const cmd = await commandPalette(commands()); cmd?.run(); }

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (!S.project || typing) return;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); toast("Edits save automatically. Commit them in Version control"); return; }
  if (S.sketchEdit && e.key === "Enter" && SK.tool !== "line" && !SK.draft) { e.preventDefault(); S.sketchEdit = null; S.pick = null; S.draft = null; emit(); return; }
  if (S.sketchEdit && e.key.toLowerCase() === "n" && !mod) { e.preventDefault(); vp.normalToSketch(); return; }
  if (S.sketchEdit && e.key.toLowerCase() === "q" && !mod) { e.preventDefault(); toggleConstruction(); return; }
  if (sketchKey(e, vp)) { e.preventDefault(); return; }
  if (isAssembly(S.part) && !mod && (e.key === "w" || e.key === "e")) { S.gizmoMode = e.key === "w" ? "translate" : "rotate"; emit(); return; }
  if (e.key === "Escape") { if (S.sel) { S.sel = null; vp?.setSelected(null); emit(); } else if (S.measure) { S.measure = null; emit(); } else if (S.pick) { S.pick = null; emit(); } else if (S.sketchEdit) { S.sketchEdit = null; emit(); } else if (S.selection) select(null); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && S.selection && !S.view) { e.preventDefault(); deleteFeature(S.selection); return; }
  if (e.key.toLowerCase() === "f" && !mod) vp?.fit();
});

cad.onFilesChanged((rel) => onExternalChange(rel));
// File menu (and files opened from Finder / the cadForMe menu-bar app)
cad.onMenu(async (cmd, arg) => {
  if (cmd === "open") { await openFolder(arg.dir); if (arg.rel && S.project?.parts?.includes(arg.rel)) await loadPart(arg.rel); }
  else if (cmd === "palette") openPalette();
});

(async function start() {
  await loadSettings();
  render();
  // Start empty: nothing opens until you open a folder.
})();
window.__app = { S, runDrcFor, loadPart, startSketch, addFeature, edit, setFeature, select, emit, openFolder, vp: () => vp, SK, setTool, runAi, openOnshapeDialog, openPalette, settingsDialog, openLibrary, createPart, checkInterference, runInterference, modelStepBytes };
