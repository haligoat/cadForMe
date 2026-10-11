// Tiny DOM helpers, icons, toasts, modals.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const P = {
  link: '<path d="M8.5 11.5a3 3 0 004.2 0l2.6-2.6a3 3 0 00-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 00-4.2 0l-2.6 2.6a3 3 0 004.2 4.2l1-1"/>',
  assembly: '<path d="M3 7l4-2 4 2v4l-4 2-4-2z"/><path d="M9 11l4-2 4 2v4l-4 2-4-2z"/>',
  rotate3d: '<path d="M15.5 8A6 6 0 104 10"/><path d="M15.5 4v4h-4"/>',
  explode: '<path d="M10 3v4M10 13v4M3 10h4M13 10h4M5 5l2.5 2.5M15 15l-2.5-2.5M15 5l-2.5 2.5M5 15l2.5-2.5"/>',
  pin: '<path d="M10 17v-5"/><path d="M6 12h8l-1.5-3V4h-5v5z"/>',
  sketch: '<path d="M4 17l3-1 9-9-2-2-9 9-1 3z"/><path d="M13 5l2 2"/>',
  extrude: '<path d="M4 14l6 3 6-3V8l-6-3-6 3z"/><path d="M4 8l6 3 6-3M10 11v6"/>',
  revolve: '<ellipse cx="10" cy="10" rx="6.5" ry="3"/><path d="M10 3v14"/><path d="M3.5 10c0 4 3 7 6.5 7"/>',
  fillet: '<path d="M4 16V9a5 5 0 015-5h7"/><path d="M4 16h12"/>',
  chamfer: '<path d="M4 16V8l4-4h8"/><path d="M4 16h12"/>',
  shell: '<rect x="3.5" y="5" width="13" height="11" rx="1.5"/><rect x="6.5" y="8" width="7" height="5.5" rx="1"/>',
  hole: '<circle cx="10" cy="10" r="3.5"/><rect x="3" y="3" width="14" height="14" rx="2"/>',
  linear: '<rect x="2.5" y="7" width="4" height="6" rx="1"/><rect x="8" y="7" width="4" height="6" rx="1"/><rect x="13.5" y="7" width="4" height="6" rx="1"/>',
  circular: '<circle cx="10" cy="10" r="6.5" stroke-dasharray="2 2.5"/><circle cx="10" cy="3.5" r="1.6"/><circle cx="16.5" cy="10" r="1.6"/><circle cx="10" cy="16.5" r="1.6"/>',
  mirror: '<path d="M10 2.5v15" stroke-dasharray="2 2"/><path d="M8 5L3 10l5 5zM12 5l5 5-5 5z"/>',
  box: '<path d="M3 6.5l7-3.5 7 3.5v7l-7 3.5-7-3.5z"/><path d="M3 6.5l7 3.5 7-3.5M10 10v7"/>',
  cylinder: '<ellipse cx="10" cy="5.5" rx="5.5" ry="2.5"/><path d="M4.5 5.5v9c0 1.4 2.5 2.5 5.5 2.5s5.5-1.100 5.5-2.500v-9"/>',
  sphere: '<circle cx="10" cy="10" r="7"/><ellipse cx="10" cy="10" rx="7" ry="2.5"/>',
  boolean: '<circle cx="8" cy="10" r="5"/><circle cx="12.500" cy="10" r="5"/>',
  transform: '<path d="M10 2v16M2 10h16M10 2l-2 2M10 2l2 2M18 10l-2-2M18 10l-2 2M10 18l-2-2M10 18l2-2M2 10l2-2M2 10l2 2"/>',
  delete: '<path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"/>',
  undo: '<path d="M7 5L3 9l4 4"/><path d="M3 9h8a5 5 0 010 10H8"/>', redo: '<path d="M13 5l4 4-4 4"/><path d="M17 9H9a5 5 0 000 10h3"/>',
  folder: '<path d="M2.500 6a1.500 1.500 0 011.500-1.500h3.500L9.500 6.500H16A1.500 1.500 0 0117.500 8v7A1.500 1.500 0 0116 16.500H4A1.500 1.500 0 012.500 15z"/>',
  branch: '<circle cx="6" cy="4.500" r="1.800"/><circle cx="6" cy="15.500" r="1.800"/><circle cx="14" cy="8" r="1.800"/><path d="M6 6.300v7.400M14 9.800c0 3-8 2-8 4"/>',
  push: '<path d="M10 16V4M5 9l5-5 5 5"/>', pull: '<path d="M10 4v12M5 11l5 5 5-5"/>',
  eye: '<path d="M2 10s3-5.500 8-5.500S18 10 18 10s-3 5.500-8 5.500S2 10 2 10z"/><circle cx="10" cy="10" r="2.200"/>',
  eyeoff: '<path d="M3 3l14 14M8.500 5c.5-.1 1-.2 1.500-.2 5 0 8 5.200 8 5.200s-1 1.800-2.800 3.200M5.500 6.500C3.500 8 2 10 2 10s3 5.500 8 5.500c1.100 0 2.100-.3 3-.7"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"/>', plus: '<path d="M10 4v12M4 10h12"/>', close: '<path d="M5 5l10 10M15 5L5 15"/>',
  check: '<path d="M4 10.500l4 4 8-9"/>', gear: '<circle cx="10" cy="10" r="2.500"/><path d="M10 2.500v2M10 15.500v2M2.500 10h2M15.500 10h2M4.700 4.700l1.400 1.400M13.900 13.900l1.400 1.400M15.300 4.700l-1.400 1.400M6.100 13.900l-1.400 1.400"/>',
  cloud: '<path d="M6 15a3.500 3.500 0 010-7 4.500 4.500 0 018.700 1A3 3 0 0114 15z"/>', download: '<path d="M10 3v10M5 9l5 5 5-5M4 17h12"/>',
  fit: '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/>', cube: '<path d="M3 6.500l7-3.500 7 3.500v7l-7 3.500-7-3.500z"/><path d="M3 6.500l7 3.500 7-3.500M10 10v7"/>',
  rect: '<rect x="3.500" y="5.500" width="13" height="9" rx="1"/>', circle: '<circle cx="10" cy="10" r="6.500"/>', polygon: '<path d="M10 3l6.500 4.700-2.500 7.600H6L3.500 7.700z"/>',
  slot: '<rect x="2.500" y="6.500" width="15" height="7" rx="3.500"/>', ellipse: '<ellipse cx="10" cy="10" rx="7.500" ry="4.500"/>', polyline: '<path d="M3 15l4-8 5 5 5-8"/>',
  select: '<path d="M5 3l11 6.500-5 1.500-2.500 5z"/>', line: '<path d="M4.500 15.500l11-11"/><circle cx="4.500" cy="15.500" r="1.300"/><circle cx="15.500" cy="4.500" r="1.300"/>', arc: '<path d="M4 15.500a8 8 0 0112-10"/>', dim: '<path d="M3 14.500h14M3 11.500v6M17 11.500v6M7.500 8.500h5"/>', pointi: '<circle cx="10" cy="10" r="1.800"/><path d="M10 3v3M10 14v3M3 10h3M14 10h3"/>', constr: '<path d="M3 10h14" stroke-dasharray="2 2"/>', chevron: '<path d="M7 5l5 5-5 5"/>', warn: '<path d="M10 3l8 14H2z"/><path d="M10 8v4M10 14.500v.1"/>',
  commit: '<circle cx="10" cy="10" r="3.500"/><path d="M2 10h4.500M13.500 10H18"/>', face: '<path d="M3 7l7-3 7 3v7l-7 3-7-3z" fill-opacity=".25" fill="currentColor"/>',
  plane: '<path d="M3 13l4-8h10l-4 8z"/>', loft: '<path d="M4 16h12M7 5h6M4 16L7 5M16 16l-3-11"/>', sweep: '<path d="M3 16c6 0 3-11 9-11h5"/><circle cx="3.500" cy="16" r="1.500"/>', split: '<path d="M2.500 10h15" stroke-dasharray="2 2"/><rect x="5" y="3.500" width="10" height="13" rx="1"/>', ruler: '<path d="M3 13l9-9 4 4-9 9z"/><path d="M6 10l1.500 1.500M8.500 7.500L10 9M11 5l1.500 1.500"/>', section: '<rect x="3" y="4" width="14" height="12" rx="1"/><path d="M3 10h14" stroke-dasharray="2 2"/>', copy: '<rect x="7" y="7" width="9" height="9" rx="1.500"/><path d="M4 13V5a1 1 0 011-1h8"/>', refresh: '<path d="M16 8a6.500 6.500 0 00-11.500-2M4 12a6.500 6.500 0 0011.500 2M4 3v3.500h3.500M16 17v-3.500h-3.500"/>',
};
export function icon(name, cls = "") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 20 20"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.5"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  if (cls) s.setAttribute("class", cls);
  s.innerHTML = P[name] ?? P.cube;
  return s;
}

let toastBox;
export const cleanError = (m) => String(m).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
export function toast(msg, kind = "") {
  msg = cleanError(msg);
  toastBox ??= document.body.appendChild(h("div", { class: "toasts" }));
  const t = toastBox.appendChild(h("div", { class: `toast ${kind}` }, msg));
  setTimeout(() => t.remove(), kind === "err" ? 7000 : 3200);
}

/** Modal dialog. Resolves with the value passed to close(value) or undefined on dismiss. */
export function modal({ title, body, actions = [], wide = false, onClose }) {
  return new Promise((resolve) => {
    const back = h("div", { class: "modalback" });
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); onClose?.(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(undefined); } };
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(undefined); });
    const content = typeof body === "function" ? body(close) : body;
    const foot = actions.map((a) => h("button", { class: `btn ${a.primary ? "primary" : ""}`, onclick: async () => {
      if (a.run) { const r = await a.run(); if (r === false) return; close(r ?? a.value); } else close(a.value);
    } }, a.label));
    back.append(h("div", { class: `modal ${wide ? "wide" : ""}` }, h("h2", {}, title), h("div", { class: "body" }, content), foot.length ? h("footer", {}, foot) : null));
    document.body.append(back);
    back.querySelector("input,textarea")?.focus();
  });
}

export const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`; if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
};
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** Floating context menu. items: [{label, run, danger?, disabled?} | "-"] */
export function showMenu(x, y, items) {
  document.querySelector(".ctxmenu")?.remove();
  const menu = h("div", { class: "ctxmenu", style: { left: `${x}px`, top: `${y}px` } }, items.map((it) => (it === "-" ? h("div", { class: "sep" }) : h("div", { class: `item ${it.danger ? "danger" : ""} ${it.disabled ? "off" : ""}`, onclick: () => { if (it.disabled) return; menu.remove(); it.run(); } }, it.label))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight) menu.style.top = `${innerHeight - r.height - 8}px`;
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", close, true); } };
  setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}
