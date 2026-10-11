// three.js viewport: bodies, edge/face picking, highlights, sketch overlay, ghost (history diff) overlay.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

const COLORS = [0x8fa8c8, 0xc99d7e, 0x8fbf9f, 0xc98fa5, 0xa58fc9];
const ACCENT = 0x5b8cff, ORANGE = 0xff9a45;
/**
 * Line positions of the "sharp" edges only. An edge where the faces on either side meet smoothly (tangent) is hidden,
 * like Onshape, so curved shapes made of many faces don't look striped. Normals are looked up at the edge's own vertices.
 */
function sharpEdgeLines(m) {
  const key = (x, y, z) => `${Math.round(x * 200)},${Math.round(y * 200)},${Math.round(z * 200)}`;
  const V = m.vertices, N = m.normals, T = m.triangles;
  // which face (group) each vertex belongs to, and the face normal there
  const at = new Map(); // key -> Map(group -> normal)
  m.faceGroups.forEach((g, gi) => {
    for (let t = g.start; t < g.start + g.count; t++) {
      const vi = T[t], k = key(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
      if (!at.has(k)) at.set(k, new Map());
      const mm = at.get(k); if (!mm.has(gi)) mm.set(gi, [N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]]);
    }
  });
  const L = m.lines, out = [];
  for (const g of m.edgeGroups) {
    // the faces an edge separates are the ones touching both ends of one of its segments
    const mid = g.start + 2 * Math.floor((g.count / 2) / 2);
    const A = at.get(key(L[mid * 3], L[mid * 3 + 1], L[mid * 3 + 2])), B = at.get(key(L[mid * 3 + 3], L[mid * 3 + 4], L[mid * 3 + 5]));
    let sharp = true;
    if (A && B) {
      const common = [...A.keys()].filter((f) => B.has(f));
      if (common.length === 2) { const n1 = A.get(common[0]), n2 = A.get(common[1]); sharp = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < 0.985; } // > ~10 degrees = a crease
    }
    if (sharp) for (let i = g.start * 3; i < (g.start + g.count) * 3; i++) out.push(L[i]);
  }
  return new Float32Array(out);
}
const niceStep = (x) => { const p = 10 ** Math.floor(Math.log10(x)); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

export class Viewport {
  constructor(container, handlers = {}) {
    this.h = handlers;
    this.canvas = container.querySelector("canvas");
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(90, -120, 80);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(0.4, 0.6, 1); this.camera.add(key);
    const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5); fill.position.set(-1, -0.2, 0.3); this.camera.add(fill);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false; this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener("change", () => { this.updateGrid(); this.requestRender(); this.h.onCamera?.(); });

    this.bodies = []; this.ghost = []; this.groupBodies = new THREE.Group(); this.groupGhost = new THREE.Group();
    this.groupHi = new THREE.Group(); this.groupSketch = new THREE.Group(); this.groupRegions = new THREE.Group(); this.groupSketchView = new THREE.Group(); this.groupUserPlanes = new THREE.Group(); this.groupMeasure = new THREE.Group(); this.groupGrid = new THREE.Group(); this.groupDatum = new THREE.Group();
    this.scene.add(this.groupMeasure, this.groupGrid, this.groupDatum, this.groupUserPlanes, this.groupBodies, this.groupGhost, this.groupHi, this.groupRegions, this.groupSketchView, this.groupSketch);
    this.lineMats = new Set();
    this.buildDatum(); this.buildAxes(); this.buildCube();
    this.sketchFrame = null; this.gridKey = ""; this.hover = null; this.picks = [];
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(); this.down = null;

    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerdown", (e) => { this.down = { x: e.clientX, y: e.clientY, b: e.button }; if (this.sketchFrame && e.button === 0 && this.cubeFace(e) === null) this.h.onSketchDown?.(this.planePoint(e), e); });
    this.canvas.addEventListener("pointerup", (e) => this.onUp(e));
    this.canvas.addEventListener("pointerleave", () => this.setHover(null));
    this.canvas.addEventListener("dblclick", (e) => { if (this.sketchFrame) this.h.onSketchDouble?.(this.planePoint(e), e); });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.fit();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.controls.update(); this.renderer.render(this.scene, this.camera); this.renderCube(); });
  }
  resize() {
    const w = this.canvas.clientWidth || 1, hgt = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt; this.camera.updateProjectionMatrix();
    this.lineMats.forEach((m) => m.resolution.set(w, hgt));
    this.requestRender();
  }

  // ---------- view cube (Onshape style) ----------
  buildCube() {
    const label = (text, color) => {
      const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
      g.fillStyle = color; g.fillRect(0, 0, 128, 128); g.strokeStyle = "#9c8664"; g.lineWidth = 6; g.strokeRect(0, 0, 128, 128);
      g.fillStyle = "#3a2c1e"; g.font = "600 25px -apple-system, Helvetica, Arial"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 64, 66);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    };
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z
    this.cubeViews = ["right", "left", "back", "front", "top", "bottom"];
    const names = ["RIGHT", "LEFT", "BACK", "FRONT", "TOP", "BOTTOM"], cols = ["#eadcc3", "#eadcc3", "#e2d2b5", "#e2d2b5", "#f3e9d7", "#d8c6a5"];
    this.cubeMats = names.map((n, i) => new THREE.MeshBasicMaterial({ map: label(n, cols[i]) }));
    this.cubeScene = new THREE.Scene();
    this.cubeMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.cubeMats);
    this.cubeScene.add(this.cubeMesh);
    this.cubeCam = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 20);
    this.cubeSize = 104; this.cubeHover = -1;
  }
  cubeRect() { const w = this.canvas.clientWidth, h = this.canvas.clientHeight; return { x: w - this.cubeSize - 16, y: h - this.cubeSize - 46, w: this.cubeSize, h: this.cubeSize }; }
  renderCube() {
    const r = this.cubeRect(), pr = this.renderer.getPixelRatio();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.cubeCam.position.copy(dir.multiplyScalar(6)); this.cubeCam.up.copy(this.camera.up); this.cubeCam.lookAt(0, 0, 0);
    const prev = this.renderer.getViewport(new THREE.Vector4()), prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = false; this.renderer.setScissorTest(true);
    const y = this.canvas.clientHeight - r.y - r.h;
    this.renderer.setViewport(r.x, y, r.w, r.h); this.renderer.setScissor(r.x, y, r.w, r.h);
    this.renderer.clearDepth();
    this.cubeMats.forEach((m, i) => m.color.setScalar(i === this.cubeHover ? 1.35 : 1));
    this.renderer.render(this.cubeScene, this.cubeCam);
    this.renderer.setScissorTest(false); this.renderer.setViewport(prev); this.renderer.autoClear = prevAuto; void pr;
  }
  /** Which cube face (index) is under the pointer, or -1. */
  cubeFace(e) {
    const rc = this.canvas.getBoundingClientRect(), r = this.cubeRect(), x = e.clientX - rc.left - r.x, y = e.clientY - rc.top - r.y;
    if (x < 0 || y < 0 || x > r.w || y > r.h) return null;
    const ndc = new THREE.Vector2((x / r.w) * 2 - 1, -((y / r.h) * 2 - 1));
    const rc2 = new THREE.Raycaster(); rc2.setFromCamera(ndc, this.cubeCam);
    const hit = rc2.intersectObject(this.cubeMesh, false)[0];
    return hit ? Math.floor(hit.faceIndex / 2) : -1;
  }

  // ---------- scene content ----------
  thick(positions, color, width = 2, opacity = 1, depthTest = true, dashed = false) {
    const g = new LineSegmentsGeometry(); g.setPositions(positions);
    const ps = this.pixelSize();
    const m = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthTest, dashed, dashSize: ps * 7, gapSize: ps * 5 });
    m.resolution.set(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1);
    this.lineMats.add(m);
    const l = new LineSegments2(g, m); l.computeLineDistances();
    return l;
  }
  disposeGroup(g) {
    for (const o of [...g.children]) {
      g.remove(o); o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => { this.lineMats.delete(m); m.dispose(); });
    }
  }

  buildBodies(meshes, target, { ghost = false } = {}) {
    this.disposeGroup(target);
    const out = [];
    meshes.forEach((m, i) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(m.triangles, 1));
      const colors = this.h.colors?.() ?? {};
      const mat = ghost
        ? new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })
          : new THREE.MeshStandardMaterial({ color: colors[i] ?? COLORS[i % COLORS.length], metalness: 0.2, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const mesh = new THREE.Mesh(geo, mat); target.add(mesh);
      const shown = ghost ? m.lines : sharpEdgeLines(m);
      const edges = ghost ? this.thick(m.lines, ORANGE, 1.5, 0.8, false) : this.thick(shown.length ? shown : new Float32Array(6), 0x3b2f22, 1.4);
      target.add(edges);
      out.push({ ...m, mesh, edges });
    });
    return out;
  }
  // ---------- assemblies: which instance owns each body, exploded view, move/rotate gizmo ----------
  setOwners(owners) { this.owners = owners ?? []; this.deltas = new Map(); this.applyOffsets(); }
  setExplode(k, anchor = null) { this.explode = k; this.explodeAnchor = anchor; this.applyOffsets(); }
  setOwnerDelta(owner, m) { (this.deltas ??= new Map()).set(owner, m); this.applyOffsets(); }
  applyOffsets() {
    const owners = this.owners ?? [], bodies = this.bodies ?? [];
    let centers = null;
    if (this.explode && bodies.length) {
      const all = new THREE.Box3(), per = new Map();
      bodies.forEach((b, i) => { b.mesh.geometry.computeBoundingBox(); const bb = b.mesh.geometry.boundingBox; all.union(bb); const o = owners[i]; per.set(o, (per.get(o) ?? new THREE.Box3()).union(bb)); });
      // spread away from the fixed part (it stays put) or, with nothing fixed, from the middle
      const c0 = (this.explodeAnchor && per.get(this.explodeAnchor) ? per.get(this.explodeAnchor) : all).getCenter(new THREE.Vector3());
      centers = new Map([...per].map(([o, bb]) => [o, bb.getCenter(new THREE.Vector3()).sub(c0).multiplyScalar(this.explode)]));
    }
    bodies.forEach((b, i) => {
      const m = new THREE.Matrix4();
      const d = this.deltas?.get(owners[i]); if (d) m.copy(d);
      const off = centers?.get(owners[i]); if (off) m.premultiply(new THREE.Matrix4().makeTranslation(off.x, off.y, off.z));
      for (const o of [b.mesh, b.edges]) { if (!o) continue; o.matrixAutoUpdate = false; o.matrix.copy(m); o.matrixWorldNeedsUpdate = true; }
    });
    this.refreshHighlights?.(); this.requestRender();
  }
  /** Show a move (translate) or rotate gizmo at `matrix`; onDrag(proxy) while dragging, onCommit(proxy) on release. */
  attachGizmo(key, matrix, mode, { onDrag, onCommit }) {
    if (this.gizmo?.key === key) return;
    this.detachGizmo();
    const proxy = new THREE.Object3D();
    matrix.decompose(proxy.position, proxy.quaternion, proxy.scale);
    this.scene.add(proxy);
    const tc = new TransformControls(this.camera, this.canvas);
    tc.setMode(mode); tc.setSpace(mode === "rotate" ? "local" : "world"); tc.setSize(0.9); tc.attach(proxy);
    const helper = tc.getHelper ? tc.getHelper() : tc;
    this.scene.add(helper);
    tc.addEventListener("dragging-changed", (e) => { this.controls.enabled = !e.value; this.gizmoBusy = e.value; if (!e.value) { this.gizmoJustDragged = true; onCommit(proxy); } });
    tc.addEventListener("objectChange", () => { proxy.updateMatrix(); onDrag(proxy); });
    tc.addEventListener("change", () => this.requestRender());
    this.gizmo = { key, tc, proxy, helper };
    this.requestRender();
  }
  detachGizmo() {
    const g = this.gizmo; if (!g) return;
    g.tc.detach(); this.scene.remove(g.helper); this.scene.remove(g.proxy); g.tc.dispose(); this.gizmo = null; this.controls.enabled = true; this.requestRender();
  }

  setBodies(meshes, { refit = false } = {}) {
    this.bodies = this.buildBodies(meshes, this.groupBodies);
    this._planar = new Map(); this.selected = null;
    this.bounds = this.computeBounds();
    this.updateClipping();
    this.setHidden(this.h.hidden?.() ?? new Set());
    if (this.section) this.setSection(this.section);
    this.fadeBodies(!!this.sketchFrame);
    this.applyOffsets();
    if (refit) this.fit();
    this.refreshHighlights(); this.requestRender();
  }
  setHidden(set) {
    this.bodies.forEach((b, i) => { const v = !set.has(i); b.mesh.visible = v; b.edges.visible = v; });
    this.requestRender();
  }
  setMeasure(points) {
    this.disposeGroup(this.groupMeasure);
    if (points.length) {
      const g = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
      const dots = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x3ecf8e, size: 11, sizeAttenuation: false, depthTest: false })); dots.renderOrder = 20; this.groupMeasure.add(dots);
      if (points.length === 2) this.groupMeasure.add(this.thick(points.flat(), 0x3ecf8e, 2, 1, false));
    }
    this.requestRender();
  }
  /** Clip the model with a plane. section = {axis: "x"|"y"|"z", pos, flip} or null. */
  setSection(section) {
    this.section = section;
    this.renderer.localClippingEnabled = !!section;
    const plane = section ? new THREE.Plane(new THREE.Vector3(section.axis === "x" ? (section.flip ? 1 : -1) : 0, section.axis === "y" ? (section.flip ? 1 : -1) : 0, section.axis === "z" ? (section.flip ? 1 : -1) : 0), section.flip ? -section.pos : section.pos) : null;
    this.clipPlane = plane;
    for (const b of this.bodies) { b.mesh.material.clippingPlanes = plane ? [plane] : []; b.mesh.material.needsUpdate = true; b.edges.material.clippingPlanes = plane ? [plane] : []; b.edges.material.clipping = !!plane; b.edges.material.needsUpdate = true; }
    this.requestRender();
  }
  setGhost(meshes) {
    this.ghost = meshes ? this.buildBodies(meshes, this.groupGhost, { ghost: true }) : [];
    if (!meshes) this.disposeGroup(this.groupGhost);
    this.requestRender();
  }
  computeBounds() {
    const b = new THREE.Box3();
    for (const body of this.bodies) body.mesh.geometry.computeBoundingBox?.(), body.mesh.geometry.boundingBox && b.union(body.mesh.geometry.boundingBox);
    return b.isEmpty() ? null : b;
  }
  updateClipping() {
    const size = this.bounds ? this.bounds.getSize(new THREE.Vector3()).length() : 100;
    this.camera.near = Math.max(0.05, size / 2000); this.camera.far = Math.max(2000, size * 60); this.camera.updateProjectionMatrix();
  }

  // ---------- datum planes, axes, grid ----------
  buildDatum() {
    const mk = (color, rot) => {
      const g = new THREE.PlaneGeometry(1, 1);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.set(...rot); return m;
    };
    this.datum = { XY: mk(0x5b8cff, [0, 0, 0]), XZ: mk(0x3ecf8e, [Math.PI / 2, 0, 0]), YZ: mk(0xff6b7a, [0, Math.PI / 2, 0]) };
    for (const [k, m] of Object.entries(this.datum)) { m.userData.plane = k; m.scale.set(80, 80, 1); this.groupDatum.add(m); }
    this.groupDatum.visible = false;
  }
  /** Construction planes: [{id, frame, selected}] drawn as translucent squares. */
  setUserPlanes(list, onTop = false) {
    this.disposeGroup(this.groupUserPlanes);
    const size = this.bounds ? Math.max(40, this.bounds.getSize(new THREE.Vector3()).length() * 0.6) : 60;
    for (const p of list) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: p.selected ? ORANGE : 0xb58cff, transparent: true, opacity: p.selected ? 0.28 : onTop ? 0.2 : 0.13, side: THREE.DoubleSide, depthWrite: false }));
      const [x, y, n] = [new THREE.Vector3(...p.frame.x), new THREE.Vector3(...p.frame.y), new THREE.Vector3(...p.frame.n)];
      m.matrixAutoUpdate = false; m.matrix.makeBasis(x, y, n).setPosition(new THREE.Vector3(...p.frame.origin));
      m.userData.plane = p.id; this.groupUserPlanes.add(m);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)), new THREE.LineBasicMaterial({ color: 0xb58cff, transparent: true, opacity: 0.5 }));
      e.matrixAutoUpdate = false; e.matrix.copy(m.matrix); this.groupUserPlanes.add(e);
    }
    this.requestRender();
  }
  setPlanesVisible(v, onTop = false) {
    this.groupDatum.visible = v;
    const s = this.bounds ? Math.max(50, this.bounds.getSize(new THREE.Vector3()).length() * 0.7) : 80;
    Object.values(this.datum).forEach((m) => { m.scale.set(s, s, 1); m.material.depthTest = true; m.renderOrder = 0; m.material.opacity = onTop ? 0.2 : 0.1; m.material.needsUpdate = true; });
    // Onshape-style labels on the planes
    if (!this.datumLabels) {
      const mk = (text, color) => { const c = document.createElement("canvas"); c.width = 256; c.height = 96; const g = c.getContext("2d"); g.fillStyle = color; g.font = "600 56px -apple-system, Helvetica, Arial"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 128, 50); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false })); sp.renderOrder = 6; return sp; };
      this.datumLabels = { XY: mk("Top", "#2f5fc4"), XZ: mk("Front", "#1f7a4d"), YZ: mk("Right", "#b8343f") };
      Object.values(this.datumLabels).forEach((sp) => this.groupDatum.add(sp));
    }
    const k = s * 0.36, w = s * 0.13;
    this.datumLabels.XY.position.set(k, k, 0); this.datumLabels.XZ.position.set(k, 0, k); this.datumLabels.YZ.position.set(0, k, k);
    Object.values(this.datumLabels).forEach((sp) => sp.scale.set(w, w * 0.375, 1));
    this.requestRender();
  }
  /** World point -> canvas pixels (for tests and overlays). */
  projectWorld(p) { const v = new THREE.Vector3(...p).project(this.camera); return [(v.x * 0.5 + 0.5) * this.canvas.clientWidth, (-v.y * 0.5 + 0.5) * this.canvas.clientHeight]; }
  buildAxes() {
    const L = 40;
    for (const [dir, color] of [[[L, 0, 0], 0xff6b7a], [[0, L, 0], 0x3ecf8e], [[0, 0, L], 0x5b8cff]]) {
      this.groupGrid.add(this.thick([0, 0, 0, ...dir], color, 2, 0.9));
    }
  }
  updateGrid() {
    const f = this.sketchFrame;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const ps = (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / (this.canvas.clientHeight || 1);
    const minor = niceStep(ps * 16), major = minor * 5;
    const key = `${f ? "s" : "g"}${minor}${f ? JSON.stringify(f.origin) + JSON.stringify(f.n) : ""}`;
    this.snapStep = minor;
    if (key === this.gridKey) return;
    this.gridKey = key;
    if (this.gridObj) { this.groupGrid.remove(this.gridObj); this.gridObj.geometry.dispose(); this.gridObj.material.dispose(); this.lineMats.delete(this.gridObj.material); }
    const n = 40, ext = n * minor;
    const o = f?.origin ?? [0, 0, 0], x = f?.x ?? [1, 0, 0], y = f?.y ?? [0, 1, 0];
    const pts = [], strong = [];
    const P = (a, b) => [o[0] + x[0] * a + y[0] * b, o[1] + x[1] * a + y[1] * b, o[2] + x[2] * a + y[2] * b];
    for (let i = -n; i <= n; i++) {
      const isMajor = Math.round(i * minor / major) * major === i * minor;
      const dst = isMajor ? strong : pts;
      dst.push(...P(i * minor, -ext), ...P(i * minor, ext), ...P(-ext, i * minor), ...P(ext, i * minor));
    }
    const grp = new THREE.Group();
    grp.add(this.thick(pts, 0xcdbb9c, 1, f ? 0.8 : 0.5), this.thick(strong, 0xb39c78, 1, f ? 0.9 : 0.6));
    grp.geometry = { dispose() {} }; grp.material = { dispose() {} };
    this.gridObj = grp; this.groupGrid.add(grp);
  }

  // ---------- camera ----------
  fit() {
    const b = this.bounds ?? new THREE.Box3(new THREE.Vector3(-30, -30, 0), new THREE.Vector3(30, 30, 30));
    const c = b.getCenter(new THREE.Vector3()), r = Math.max(10, b.getSize(new THREE.Vector3()).length() / 2);
    const d = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 0.95;
    this.controls.target.copy(c);
    const dir = this.sketchFrame ? new THREE.Vector3(...this.sketchFrame.n) : new THREE.Vector3(0.55, -0.75, 0.5).normalize();
    this.camera.position.copy(c).addScaledVector(dir, d);
    this.camera.lookAt(c); this.controls.update(); this.updateGrid(); this.requestRender();
  }
  setView(name) {
    const dirs = { iso: [0.55, -0.75, 0.5], top: [0, 0, 1], front: [0, -1, 0], right: [1, 0, 0], back: [0, 1, 0], left: [-1, 0, 0], bottom: [0, 0, -1] };
    const v = new THREE.Vector3(...dirs[name]).normalize();
    const t = this.controls.target, d = this.camera.position.distanceTo(t);
    this.camera.up.set(0, name === "top" ? 1 : name === "bottom" ? -1 : 0, name === "top" || name === "bottom" ? 0 : 1);
    this.camera.position.copy(t).addScaledVector(v, d); this.camera.lookAt(t); this.controls.update();
    if (name === "top" || name === "bottom") this.camera.up.set(0, 0, 1);
    this.syncUp();
    this.requestRender();
  }
  /** OrbitControls caches the up axis at construction; re-sync it whenever camera.up changes. */
  syncUp() { this.controls._quat.setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0)); this.controls._quatInverse.copy(this.controls._quat).invert(); }
  normalToSketch() { if (this.sketchFrame) { this.lookAlong(this.sketchFrame); this.requestRender(); } }
  lookAlong(frame) {
    const t = this.controls.target.clone();
    const o = new THREE.Vector3(...frame.origin), n = new THREE.Vector3(...frame.n);
    t.sub(o).projectOnPlane(n).add(o); // keep the target on the sketch plane
    const d = this.camera.position.distanceTo(this.controls.target);
    this.controls.target.copy(t);
    this.camera.up.set(...frame.y); this.syncUp(); // orbit around the sketch's own "up" so you can tilt both ways
    this.camera.position.copy(t).addScaledVector(n, d); this.camera.lookAt(t); this.controls.update();
  }

  // ---------- sketch mode ----------
  /** Onshape-style: while sketching, the model goes see-through so the sketch is never buried behind faces. */
  fadeBodies(on) {
    for (const b of this.bodies ?? []) {
      const m = b.mesh?.material; if (!m) continue;
      m.transparent = on; m.opacity = on ? 0.18 : 1; m.depthWrite = !on; m.needsUpdate = true;
      if (b.edges?.material) { b.edges.material.transparent = on; b.edges.material.opacity = on ? 0.35 : 1; b.edges.material.needsUpdate = true; }
    }
  }
  enterSketch(frame) {
    const first = !this.sketchFrame;
    this.sketchFrame = frame; this.gridKey = "";
    // Onshape: left button draws, right-drag orbits (⇧ + right-drag pans), scroll zooms
    this.controls.enableRotate = true;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    if (first || this._sketchKey !== JSON.stringify(frame)) this.lookAlong(frame);
    this._sketchKey = JSON.stringify(frame);
    this.fadeBodies(true);
    this.updateGrid(); this.requestRender();
  }
  exitSketch() {
    if (!this.sketchFrame) return;
    this.sketchFrame = null; this._sketchKey = null; this.gridKey = ""; this.controls.enableRotate = true; this.fadeBodies(false);
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.camera.up.set(0, 0, 1); this.syncUp(); this.setView("iso"); this.disposeGroup(this.groupSketch); this.updateGrid(); this.requestRender();
  }
  /** Draw sketch geometry. items: [{pts:[[x,y]...], closed?, color, width, dashed, opacity}] in local coords; dots: [{p, color, size}]. */
  drawSketch(items, dots = []) {
    this.disposeGroup(this.groupSketch);
    const f = this.sketchFrame; if (!f) { this.requestRender(); return; }
    const W = (p, lift = 0.02) => [f.origin[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.n[0] * lift, f.origin[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.n[1] * lift, f.origin[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.n[2] * lift];
    for (const it of items) {
      const seg = [];
      const pts = it.pts;
      for (let i = 0; i < pts.length - 1; i++) seg.push(...W(pts[i]), ...W(pts[i + 1]));
      if (it.closed && pts.length > 2) seg.push(...W(pts.at(-1)), ...W(pts[0]));
      if (seg.length) this.groupSketch.add(this.thick(seg, it.color ?? ACCENT, it.width ?? 2.5, it.opacity ?? 1, false, !!it.dashed));
    }
    const byStyle = new Map();
    for (const d of dots) { const k = `${d.color ?? 0xffffff}:${d.size ?? 7}`; (byStyle.get(k) ?? byStyle.set(k, []).get(k)).push(d); }
    for (const [k, list] of byStyle) {
      const [color, size] = k.split(":").map(Number);
      const g = new THREE.BufferGeometry().setFromPoints(list.map((d) => new THREE.Vector3(...W(d.p, 0.05))));
      const pt = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }));
      pt.renderOrder = 10; this.groupSketch.add(pt);
    }
    this.requestRender();
  }
  /** Sketch-local [x, y] -> screen pixels relative to the canvas. */
  project(p, frame) {
    const f = frame ?? this.sketchFrame; if (!f) return null;
    const v = new THREE.Vector3(f.origin[0] + f.x[0] * p[0] + f.y[0] * p[1], f.origin[1] + f.x[1] * p[0] + f.y[1] * p[1], f.origin[2] + f.x[2] * p[0] + f.y[2] * p[1]).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.canvas.clientWidth, (-v.y * 0.5 + 0.5) * this.canvas.clientHeight];
  }
  /** Shaded sketch regions. regions: [{outer: [[x,y]..], holes: [[[x,y]..]], selected}] in frame-local coords. */
  setRegions(frame, regions) {
    this.disposeGroup(this.groupRegions);
    if (frame) for (const r of regions) {
      const shape = new THREE.Shape(r.outer.map((p) => new THREE.Vector2(p[0], p[1])));
      for (const h of r.holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: r.selected ? ORANGE : ACCENT, transparent: true, opacity: r.selected ? 0.35 : 0.1, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      const [x, y, n] = [new THREE.Vector3(...frame.x), new THREE.Vector3(...frame.y), new THREE.Vector3(...frame.n)];
      m.matrixAutoUpdate = false; m.matrix.makeBasis(x, y, n).setPosition(new THREE.Vector3(...frame.origin).addScaledVector(n, 0.01));
      this.groupRegions.add(m);
    }
    this.requestRender();
  }
  /** Finished sketches drawn as thin curves. sketches: [{frame, curves: [[x,y]..][], color}] */
  setSketchView(sketches) {
    this.disposeGroup(this.groupSketchView);
    for (const sk of sketches) {
      const f = sk.frame, seg = [];
      const W = (p) => [f.origin[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.n[0] * 0.015, f.origin[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.n[1] * 0.015, f.origin[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.n[2] * 0.015];
      for (const pts of sk.curves) for (let i = 0; i < pts.length - 1; i++) seg.push(...W(pts[i]), ...W(pts[i + 1]));
      if (seg.length) this.groupSketchView.add(this.thick(seg, sk.color ?? 0x7aa2ff, 1.6, 0.9, false, !!sk.dashed));
    }
    this.requestRender();
  }
  pickRegion(e, frame) {
    this.setMouse(e); this.raycaster.setFromCamera(this.mouse, this.camera);
    const n = new THREE.Vector3(...frame.n), o = new THREE.Vector3(...frame.origin);
    const hit = this.raycaster.ray.intersectPlane(new THREE.Plane(n, -n.dot(o)), new THREE.Vector3());
    if (!hit) return null;
    const d = hit.sub(o);
    return { type: "region", p: [d.dot(new THREE.Vector3(...frame.x)), d.dot(new THREE.Vector3(...frame.y))] };
  }
  pixelSize() { const d = this.camera.position.distanceTo(this.controls.target); return (2 * d * Math.tan((this.camera.fov * Math.PI) / 360)) / (this.canvas.clientHeight || 1); }
  planePoint(e) {
    const f = this.sketchFrame; if (!f) return null;
    this.setMouse(e); this.raycaster.setFromCamera(this.mouse, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(...f.n), -new THREE.Vector3(...f.n).dot(new THREE.Vector3(...f.origin)));
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    const d = hit.sub(new THREE.Vector3(...f.origin));
    const raw = [d.dot(new THREE.Vector3(...f.x)), d.dot(new THREE.Vector3(...f.y))];
    const s = e.altKey ? 0 : this.snapStep;
    return { raw, p: s ? raw.map((v) => Math.round(v / s) * s) : raw, snap: s };
  }

  // ---------- picking ----------
  setMouse(e) { const r = this.canvas.getBoundingClientRect(); this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); this.rect = r; }

  /** Is face group gi of body bi flat? (all vertex normals agree) */
  isPlanar(bi, gi) {
    this._planar ??= new Map();
    const key = `${bi}:${gi}`;
    if (this._planar.has(key)) return this._planar.get(key);
    const body = this.bodies[bi], g = body?.faceGroups[gi];
    let flat = !!g;
    if (g) {
      const N = body.normals, i0 = body.triangles[g.start] * 3, n0 = [N[i0], N[i0 + 1], N[i0 + 2]];
      for (let k = g.start; k < g.start + g.count && flat; k++) { const j = body.triangles[k] * 3; if (n0[0] * N[j] + n0[1] * N[j + 1] + n0[2] * N[j + 2] < 0.9995) flat = false; }
    }
    this._planar.set(key, flat);
    return flat;
  }
  pick(e, { faces = true, edges = true, planes = false, region = null, planarOnly = false } = {}) {
    if (region) return this.pickRegion(e, region);
    this.setMouse(e); this.raycaster.setFromCamera(this.mouse, this.camera);
    let faceHit = null;
    if (faces && this.bodies.length) {
      const hits = this.raycaster.intersectObjects(this.bodies.map((b) => b.mesh), false);
      if (hits[0]) {
        const hit = hits[0], bi = this.bodies.findIndex((b) => b.mesh === hit.object), body = this.bodies[bi];
        const idx = hit.faceIndex * 3;
        const gi = body.faceGroups.findIndex((g) => idx >= g.start && idx < g.start + g.count);
        const nrm = this.interpNormal(body, hit);
        faceHit = { type: "face", body: bi, group: gi, p: hit.point.toArray(), n: nrm, dist: hit.distance, planar: this.isPlanar(bi, gi) };
      }
    }
    if (planes) {
      const ph = this.raycaster.intersectObjects([...Object.values(this.datum), ...this.groupUserPlanes.children.filter((c) => c.isMesh)], false)[0];
      if (ph && !faceHit) return { type: "plane", name: ph.object.userData.plane, p: ph.point.toArray() }; // part faces win over reference planes (Onshape)
    }
    if (planarOnly && faceHit && !faceHit.planar) return null; // a curved face is in the way: you can only sketch on flat ones
    let edgeHit = null;
    if (edges) edgeHit = this.pickEdge(e, faceHit?.dist);
    return edgeHit ?? faceHit;
  }
  interpNormal(body, hit) {
    const nA = body.mesh.geometry.attributes.normal, f = hit.face;
    const a = new THREE.Vector3().fromBufferAttribute(nA, f.a), b = new THREE.Vector3().fromBufferAttribute(nA, f.b), c = new THREE.Vector3().fromBufferAttribute(nA, f.c);
    const pa = new THREE.Vector3().fromBufferAttribute(body.mesh.geometry.attributes.position, f.a), pb = new THREE.Vector3().fromBufferAttribute(body.mesh.geometry.attributes.position, f.b), pc = new THREE.Vector3().fromBufferAttribute(body.mesh.geometry.attributes.position, f.c);
    const bc = new THREE.Vector3(); THREE.Triangle.getBarycoord(hit.point, pa, pb, pc, bc);
    return a.multiplyScalar(bc.x).add(b.multiplyScalar(bc.y)).add(c.multiplyScalar(bc.z)).normalize().toArray();
  }
  pickEdge(e, faceDist) {
    this.setMouse(e); this.raycaster.setFromCamera(this.mouse, this.camera);
    const r = this.rect ?? this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), cam = this.camera.position;
    let best = null; const R2 = 7 * 7;
    const proj = (v, out) => { out.copy(v).project(this.camera); return [(out.x * 0.5 + 0.5) * r.width, (-out.y * 0.5 + 0.5) * r.height, out.z]; };
    this.bodies.forEach((body, bi) => {
      const L = body.lines;
      body.edgeGroups.forEach((g, gi) => {
        for (let v = g.start; v < g.start + g.count; v += 2) {
          A.set(L[v * 3], L[v * 3 + 1], L[v * 3 + 2]); B.set(L[v * 3 + 3], L[v * 3 + 4], L[v * 3 + 5]);
          const [ax, ay, az] = proj(A, new THREE.Vector3()), [bx, by, bz] = proj(B, new THREE.Vector3());
          if (az > 1 && bz > 1) continue;
          const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
          const t = len2 ? Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / len2)) : 0;
          const px = ax + dx * t, py = ay + dy * t, d2 = (mx - px) ** 2 + (my - py) ** 2;
          if (d2 > R2 || (best && d2 >= best.d2)) continue;
          const pt = new THREE.Vector3(); this.raycaster.ray.distanceSqToSegment(A, B, null, pt); // exact 3D point (screen-space t is not perspective-correct)
          const dist = pt.distanceTo(cam);
          if (faceDist !== undefined && dist > faceDist + Math.max(0.05, faceDist * 0.004)) continue; // hidden behind a face
          best = { d2, body: bi, group: gi, dist, at: pt.toArray() };
        }
      });
    });
    if (!best) return null;
    return { type: "edge", body: best.body, group: best.group, p: this.edgeRefPoint(best.body, best.group), at: best.at, dist: best.dist };
  }
  /** A point exactly on the edge: the midpoint of straight edges, a mid-vertex of curved ones. */
  edgeRefPoint(bi, gi) {
    const body = this.bodies[bi], g = body.edgeGroups[gi], L = body.lines;
    const V = (i) => [L[i * 3], L[i * 3 + 1], L[i * 3 + 2]];
    let p;
    if (g.count <= 2) { const a = V(g.start), b = V(g.start + 1); p = a.map((x, i) => (x + b[i]) / 2); }
    else { const segs = g.count / 2; p = V(g.start + 2 * Math.floor(segs / 2)); }
    return p.map((x) => Math.round(x * 1e4) / 1e4);
  }

  onMove(e) {
    const cf = this.cubeFace(e);
    if (cf !== null && !e.buttons) { if (cf !== this.cubeHover) { this.cubeHover = cf; this.requestRender(); } this.canvas.style.cursor = cf >= 0 ? "pointer" : ""; return; }
    if (this.cubeHover !== -1) { this.cubeHover = -1; this.requestRender(); }
    if (this.sketchFrame) { this.h.onSketchMove?.(this.planePoint(e), e); return; }
    if (e.buttons) return;
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      const mode = this.h.pickMode?.() ?? { faces: false, edges: false, planes: false };
      if (!mode.faces && !mode.edges && !mode.planes) { this.setHover(null); return; }
      this.setHover(this.pick(e, mode));
    });
  }
  onUp(e) {
    const cf = this.cubeFace(e);
    if (cf !== null && cf >= 0 && this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 4 && e.button === 0) { this.down = null; this.h.onCube?.(this.cubeViews[cf]); return; }
    if (this.sketchFrame) { this.down = null; if (e.button === 0) this.h.onSketchUp?.(this.planePoint(e), e); return; }
    const d = this.down; this.down = null;
    if (this.gizmoJustDragged || this.gizmo?.tc.axis) { this.gizmoJustDragged = false; return; }
    if (!d || d.b !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) { if (this.sketchFrame) this.h.onSketchUp?.(this.planePoint(e), e); return; }
    if (this.sketchFrame) { this.h.onSketchClick?.(this.planePoint(e), e); return; }
    const mode = this.h.pickMode?.() ?? {};
    this.h.onClick?.(mode.faces || mode.edges || mode.planes || mode.region ? this.pick(e, mode) : null, e);
  }
  setHover(hit) {
    if (hit?.type === "region") hit = null;
    const key = hit ? `${hit.type}${hit.body}${hit.group}${hit.name}` : "";
    if (key === this._hoverKey) return;
    this._hoverKey = key; this.hover = hit; this.refreshHighlights();
    this.canvas.style.cursor = hit ? "pointer" : "";
  }

  // ---------- highlights ----------
  faceGeo(body, gi) {
    const g = body.faceGroups[gi]; const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", body.mesh.geometry.attributes.position); geo.setAttribute("normal", body.mesh.geometry.attributes.normal);
    geo.setIndex(new THREE.BufferAttribute(body.triangles.subarray(g.start, g.start + g.count), 1));
    return geo;
  }
  edgePositions(body, gi) { const g = body.edgeGroups[gi]; return body.lines.subarray(g.start * 3, (g.start + g.count) * 3); }
  addFace(body, gi, color, opacity) {
    if (!body || gi < 0) return;
    const mesh = new THREE.Mesh(this.faceGeo(body, gi), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    this.groupHi.add(mesh);
  }
  addEdge(body, gi, color, width) { if (body && gi >= 0) this.groupHi.add(this.thick(this.edgePositions(body, gi), color, width, 1, false)); }

  /** Resolve a stored reference ({p, n}) to the matching face / edge group in the current mesh. */
  resolveFace(ref) {
    let best = null; const P = new THREE.Vector3(...ref.p), tri = new THREE.Triangle(), tmp = new THREE.Vector3();
    this.bodies.forEach((body, bi) => {
      const pos = body.vertices;
      body.faceGroups.forEach((g, gi) => {
        for (let i = g.start; i < g.start + g.count; i += 3) {
          const a = body.triangles[i], b = body.triangles[i + 1], c = body.triangles[i + 2];
          tri.a.set(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]); tri.b.set(pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]); tri.c.set(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]);
          const d = tri.closestPointToPoint(P, tmp).distanceTo(P);
          if (d < 0.2 && (!best || d < best.d)) {
            if (ref.n) { const nn = tri.getNormal(new THREE.Vector3()); if (nn.dot(new THREE.Vector3(...ref.n)) < 0.5) continue; }
            best = { d, bi, gi };
          }
        }
      });
    });
    return best;
  }
  resolveEdge(ref) {
    let best = null; const P = new THREE.Vector3(...ref.p), A = new THREE.Vector3(), B = new THREE.Vector3(), line = new THREE.Line3(), tmp = new THREE.Vector3();
    this.bodies.forEach((body, bi) => {
      const L = body.lines;
      body.edgeGroups.forEach((g, gi) => {
        for (let v = g.start; v < g.start + g.count; v += 2) {
          A.set(L[v * 3], L[v * 3 + 1], L[v * 3 + 2]); B.set(L[v * 3 + 3], L[v * 3 + 4], L[v * 3 + 5]);
          const d = line.set(A, B).closestPointToPoint(P, true, tmp).distanceTo(P);
          if (d < 0.2 && (!best || d < best.d)) best = { d, bi, gi };
        }
      });
    });
    return best;
  }
  setPicks(refs) { this.picks = refs ?? []; this.refreshHighlights(); }
  setSelected(hit) { this.selected = hit; this.refreshHighlights(); }
  refreshHighlights() {
    this.disposeGroup(this.groupHi);
    for (const ref of this.picks) {
      if (ref.kind === "edge") { const r = this.resolveEdge(ref); if (r) this.addEdge(this.bodies[r.bi], r.gi, ORANGE, 3.5); }
      else if (ref.kind === "face") { const r = this.resolveFace(ref); if (r) this.addFace(this.bodies[r.bi], r.gi, ORANGE, 0.5); }
      else if (ref.kind === "point") {
        const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...ref.p)]);
        this.groupHi.add(new THREE.Points(g, new THREE.PointsMaterial({ color: ORANGE, size: 12, sizeAttenuation: false, depthTest: false })));
      }
    }
    const sel = this.selected;
    if (sel?.type === "face" && this.bodies[sel.body]) this.addFace(this.bodies[sel.body], sel.group, 0xffb547, 0.45);
    else if (sel?.type === "edge" && this.bodies[sel.body]) this.addEdge(this.bodies[sel.body], sel.group, 0xffb547, 4);
    else if (sel?.type === "plane") { const m = this.datum[sel.name] ?? this.groupUserPlanes.children.find((c) => c.isMesh && c.userData.plane === sel.name); if (m) { const c = m.clone(); c.material = m.material.clone(); c.material.color.set(0xffb547); c.material.opacity = 0.35; this.groupHi.add(c); } }
    const h = this.hover;
    if (h?.type === "face") this.addFace(this.bodies[h.body], h.group, ACCENT, 0.35);
    else if (h?.type === "edge") this.addEdge(this.bodies[h.body], h.group, ACCENT, 3.5);
    else if (h?.type === "plane") { const m = this.datum[h.name] ?? this.groupUserPlanes.children.find((c) => c.isMesh && c.userData.plane === h.name); if (m) { const c = m.clone(); c.material = m.material.clone(); c.material.opacity = 0.35; this.groupHi.add(c); } }
    this.requestRender();
  }

  screenshot() { this.renderer.render(this.scene, this.camera); return this.canvas.toDataURL("image/png"); }
}
