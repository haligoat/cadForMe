// Feature metadata: toolbar entries, defaults and inspector field schemas.
const MODES = [["new", "New"], ["add", "Add"], ["cut", "Remove"], ["intersect", "Intersect"]]; // Onshape's operation names
const AXES = [[[1, 0, 0], "X"], [[0, 1, 0], "Y"], [[0, 0, 1], "Z"]];

export const FEATURES = {
  onshape: { label: "Onshape feature", icon: "cloud", fields: [] },
  sketch: { label: "Sketch", icon: "sketch", fields: [
    { k: "plane", t: "plane", label: "Plane" }, { k: "offset", t: "expr", label: "Offset", unit: "mm" }] },
  plane: { label: "Plane", icon: "plane", fields: [
    { k: "mode", t: "select", label: "Type", opts: [["offset", "Offset"], ["threePoint", "Three points"], ["pointNormal", "Point + normal"], ["midplane", "Midplane"], ["angle", "At angle"]] },
    { k: "from", t: "planeref", label: "From plane", showIf: (f) => ["offset", "angle"].includes(f.mode ?? "offset") },
    { k: "distance", t: "expr", label: "Distance", unit: "mm", showIf: (f) => (f.mode ?? "offset") === "offset" },
    { k: "pts", t: "pts3", label: "Points", showIf: (f) => f.mode === "threePoint" },
    { k: "origin", t: "vec3", label: "Point", showIf: (f) => f.mode === "pointNormal" }, { k: "normal", t: "vec3", label: "Normal", axes: AXES, showIf: (f) => f.mode === "pointNormal" },
    { k: "a", t: "planeref", label: "Plane A", showIf: (f) => f.mode === "midplane" }, { k: "b", t: "planeref", label: "Plane B", showIf: (f) => f.mode === "midplane" },
    { k: "axis", t: "vec3", label: "Rotate axis", axes: AXES, showIf: (f) => f.mode === "angle" }, { k: "point", t: "vec3", label: "Axis point", showIf: (f) => f.mode === "angle" },
    { k: "angle", t: "expr", label: "Angle", unit: "°", showIf: (f) => f.mode === "angle" }] },
  extrude: { label: "Extrude", icon: "extrude", fields: [
    { k: "sketch", t: "sketch", label: "Sketch" }, { k: "regions", t: "regions", label: "Regions" }, { k: "distance", t: "expr", label: "Depth", unit: "mm" },
    { k: "mode", t: "select", label: "Operation", opts: MODES }, { k: "flip", t: "check", label: "Opposite direction" },
    { k: "symmetric", t: "check", label: "Symmetric" }, { k: "through", t: "check", label: "Through all" },
    { k: "draft", t: "expr", label: "Draft angle", unit: "°" }, { k: "twist", t: "expr", label: "Twist", unit: "°", showIf: (f) => !f.draft }] },
  loft: { label: "Loft", icon: "loft", fields: [
    { k: "sketches", t: "sketchlist", label: "Sketches" }, { k: "ruled", t: "check", label: "Straight (ruled) surfaces" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  sweep: { label: "Sweep", icon: "sweep", fields: [
    { k: "profile", t: "sketch", label: "Profile sketch" }, { k: "path", t: "sketch", label: "Path sketch" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  split: { label: "Split", icon: "split", fields: [
    { k: "body", t: "body", label: "Body" }, { k: "origin", t: "vec3", label: "Plane point" }, { k: "normal", t: "vec3", label: "Plane normal", axes: AXES },
    { k: "keep", t: "select", label: "Keep", opts: [["both", "Both sides"], ["above", "Above (+normal)"], ["below", "Below"]] }] },
  revolve: { label: "Revolve", icon: "revolve", fields: [
    { k: "sketch", t: "sketch", label: "Sketch" }, { k: "regions", t: "regions", label: "Regions" }, { k: "axis", t: "select", label: "Axis", opts: [["X", "Sketch X axis"], ["Y", "Sketch Y axis"]] },
    { k: "angle", t: "expr", label: "Angle", unit: "°" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  fillet: { label: "Fillet", icon: "fillet", fields: [
    { k: "edges", t: "edges", label: "Edges" }, { k: "radius", t: "expr", label: "Radius", unit: "mm" }] },
  chamfer: { label: "Chamfer", icon: "chamfer", fields: [
    { k: "edges", t: "edges", label: "Edges" }, { k: "radius", t: "expr", label: "Distance", unit: "mm" }] },
  shell: { label: "Shell", icon: "shell", fields: [
    { k: "faces", t: "faces", label: "Faces to open" }, { k: "thickness", t: "expr", label: "Thickness", unit: "mm" }] },
  hole: { label: "Hole", icon: "hole", fields: [
    { k: "position", t: "point", label: "Position" }, { k: "std", t: "holestd", label: "Standard size" }, { k: "diameter", t: "expr", label: "Diameter", unit: "mm" },
    { k: "style", t: "select", label: "Style", opts: [["simple", "Simple"], ["counterbore", "Counterbore"], ["countersink", "Countersink"]] },
    { k: "through", t: "check", label: "Through all" }, { k: "depth", t: "expr", label: "Depth", unit: "mm", showIf: (f) => !f.through },
    { k: "cboreDiameter", t: "expr", label: "C'bore dia.", unit: "mm", showIf: (f) => f.style === "counterbore" },
    { k: "cboreDepth", t: "expr", label: "C'bore depth", unit: "mm", showIf: (f) => f.style === "counterbore" },
    { k: "csinkDiameter", t: "expr", label: "C'sink dia.", unit: "mm", showIf: (f) => f.style === "countersink" }, { k: "csinkAngle", t: "expr", label: "C'sink angle", unit: "°", showIf: (f) => f.style === "countersink" }] },
  linearPattern: { label: "Linear pattern", icon: "linear", fields: [
    { k: "body", t: "body", label: "Body" }, { k: "direction", t: "vec3", label: "Direction", axes: AXES },
    { k: "distance", t: "expr", label: "Spacing", unit: "mm" }, { k: "count", t: "expr", label: "Count" },
    { k: "count2", t: "expr", label: "Rows (2nd dir.)" }, { k: "direction2", t: "vec3", label: "2nd direction", axes: AXES, showIf: (f) => Number(f.count2) > 1 || typeof f.count2 === "string" }, { k: "distance2", t: "expr", label: "2nd spacing", unit: "mm", showIf: (f) => Number(f.count2) > 1 || typeof f.count2 === "string" },
    { k: "merge", t: "check", label: "Merge into body", def: true }] },
  circularPattern: { label: "Circular pattern", icon: "circular", fields: [
    { k: "body", t: "body", label: "Body" }, { k: "axis", t: "vec3", label: "Axis", axes: AXES }, { k: "origin", t: "vec3", label: "Axis point" },
    { k: "count", t: "expr", label: "Count" }, { k: "angle", t: "expr", label: "Total angle", unit: "°" }, { k: "merge", t: "check", label: "Merge into body", def: true }] },
  mirror: { label: "Mirror", icon: "mirror", fields: [
    { k: "body", t: "body", label: "Body" }, { k: "normal", t: "vec3", label: "Plane normal", axes: AXES }, { k: "origin", t: "vec3", label: "Plane point" },
    { k: "merge", t: "check", label: "Merge into body", def: true }] },
  box: { label: "Box", icon: "box", fields: [
    { k: "position", t: "vec3", label: "Base centre" }, { k: "w", t: "expr", label: "Width X", unit: "mm" }, { k: "d", t: "expr", label: "Depth Y", unit: "mm" },
    { k: "h", t: "expr", label: "Height Z", unit: "mm" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  cylinder: { label: "Cylinder", icon: "cylinder", fields: [
    { k: "position", t: "vec3", label: "Base centre" }, { k: "direction", t: "vec3", label: "Direction", axes: AXES },
    { k: "r", t: "expr", label: "Radius", unit: "mm" }, { k: "h", t: "expr", label: "Height", unit: "mm" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  sphere: { label: "Sphere", icon: "sphere", fields: [
    { k: "position", t: "vec3", label: "Centre" }, { k: "r", t: "expr", label: "Radius", unit: "mm" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  transform: { label: "Move / rotate", icon: "transform", fields: [
    { k: "body", t: "body", label: "Body" }, { k: "translate", t: "vec3", label: "Move by" }, { k: "rotate", t: "expr", label: "Rotate", unit: "°" },
    { k: "scale", t: "expr", label: "Scale" }, { k: "axis", t: "vec3", label: "Rotate axis", axes: AXES }, { k: "origin", t: "vec3", label: "Rotate/scale about" }, { k: "copy", t: "check", label: "Make a copy" }] },
  boolean: { label: "Boolean", icon: "boolean", fields: [
    { k: "a", t: "body", label: "Body A", noAll: true }, { k: "b", t: "body", label: "Body B", noAll: true },
    { k: "op", t: "select", label: "Operation", opts: [["union", "Union"], ["subtract", "A − B"], ["intersect", "Intersect"]] }] },
  gear: { label: "Spur gear", icon: "circular", fields: [
    { k: "module", t: "expr", label: "Module", unit: "mm" }, { k: "teeth", t: "expr", label: "Teeth" }, { k: "thickness", t: "expr", label: "Thickness", unit: "mm" },
    { k: "bore", t: "expr", label: "Bore", unit: "mm" }, { k: "pressure", t: "expr", label: "Pressure angle", unit: "°" }, { k: "position", t: "vec3", label: "Move by" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  coil: { label: "Coil / spring", icon: "sweep", fields: [
    { k: "radius", t: "expr", label: "Coil radius", unit: "mm" }, { k: "pitch", t: "expr", label: "Pitch", unit: "mm" }, { k: "height", t: "expr", label: "Height", unit: "mm" },
    { k: "wire", t: "expr", label: "Wire dia.", unit: "mm" }, { k: "position", t: "vec3", label: "Move by" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  insert: { label: "Insert part", icon: "cube", fields: [
    // assembly instances (have `orient`) vs. the older in-part insert (single-axis rotate, scale, boolean mode)
    { k: "part", t: "partref", label: "Part Studio" }, { k: "vars", t: "json", label: "Variable overrides" },
    { k: "fixed", t: "check", label: "Fixed (won't move)", showIf: (f) => f.orient !== undefined },
    { k: "position", t: "vec3", label: "Position", showIf: (f) => f.orient !== undefined },
    { k: "orient", t: "vec3", label: "Rotation X, Y, Z (°)", showIf: (f) => f.orient !== undefined },
    { k: "scale", t: "expr", label: "Scale", showIf: (f) => f.orient === undefined },
    { k: "position", t: "vec3", label: "Move by", showIf: (f) => f.orient === undefined }, { k: "rotate", t: "expr", label: "Rotate", unit: "°", showIf: (f) => f.orient === undefined },
    { k: "axis", t: "vec3", label: "Rotate axis", axes: AXES, showIf: (f) => f.orient === undefined },
    { k: "origin", t: "vec3", label: "Rotate/scale about", showIf: (f) => f.orient === undefined }, { k: "mode", t: "select", label: "Operation", opts: MODES, showIf: (f) => f.orient === undefined }] },
  mate: { label: "Fasten mate", icon: "link", fields: [
    { k: "offset", t: "expr", label: "Gap", unit: "mm" }, { k: "angle", t: "expr", label: "Spin", unit: "°" }] },
  import: { label: "Import", icon: "download", fields: [
    { k: "file", t: "file", label: "File" }, { k: "scale", t: "expr", label: "Scale" },
    { k: "anchor", t: "vec3", label: "Anchor (point in file)", showIf: (f) => f.anchor !== undefined }, { k: "orient", t: "vec3", label: "Rotation X, Y, Z (°)", showIf: (f) => f.orient !== undefined },
    { k: "position", t: "vec3", label: "Move by" }, { k: "mode", t: "select", label: "Operation", opts: MODES }] },
  deleteBody: { label: "Delete body", icon: "delete", fields: [{ k: "body", t: "body", label: "Body" }] },
};

/** Default values for a new feature. ctx: {sketches: [...ids unused], bodies: n} */
export function defaultsFor(type, ctx) {
  const firstBody = ctx.bodies === 0;
  const sk = ctx.unusedSketches.at(-1) ?? ctx.sketches.at(-1) ?? "";
  switch (type) {
    case "sketch": return { plane: "XY", offset: 0, geom: [], cons: [] };
    case "extrude": return { sketch: sk, distance: 10, mode: firstBody ? "new" : "add" };
    case "revolve": return { sketch: sk, axis: "Y", angle: 360, mode: firstBody ? "new" : "add" };
    case "fillet": return { edges: [], radius: 2 };
    case "chamfer": return { edges: [], radius: 1 };
    case "shell": return { faces: [], thickness: 2 };
    case "hole": return { position: [0, 0, 0], normal: [0, 0, 1], diameter: 6, style: "simple", through: true, depth: 10, cboreDiameter: 10, cboreDepth: 3 };
    case "linearPattern": return { body: "all", direction: [1, 0, 0], distance: 20, count: 3, merge: true };
    case "circularPattern": return { body: "all", axis: [0, 0, 1], origin: [0, 0, 0], count: 4, angle: 360, merge: true };
    case "mirror": return { body: "all", normal: [1, 0, 0], origin: [0, 0, 0], merge: true };
    case "box": return { position: [0, 0, 0], w: 20, d: 20, h: 20, mode: firstBody ? "new" : "add" };
    case "cylinder": return { position: [0, 0, 0], direction: [0, 0, 1], r: 10, h: 20, mode: firstBody ? "new" : "add" };
    case "sphere": return { position: [0, 0, 0], r: 10, mode: firstBody ? "new" : "add" };
    case "transform": return { body: 0, translate: [20, 0, 0], rotate: 0, axis: [0, 0, 1], origin: [0, 0, 0], copy: false };
    case "boolean": return { a: 0, b: 1, op: "union" };
    case "deleteBody": return { body: 0 };
    case "plane": return { mode: "offset", from: "XY", distance: 10 };
    case "loft": return { sketches: ctx.unusedSketches.slice(-2), ruled: false, mode: firstBody ? "new" : "add" };
    case "sweep": return { profile: ctx.unusedSketches.at(-2) ?? "", path: ctx.unusedSketches.at(-1) ?? "", mode: firstBody ? "new" : "add" };
    case "split": return { body: 0, origin: [0, 0, 0], normal: [0, 0, 1], keep: "both" };
    case "gear": return { module: 1.5, teeth: 24, thickness: 6, bore: 8, pressure: 20, position: [0, 0, 0], mode: firstBody ? "new" : "add" };
    case "coil": return { radius: 8, pitch: 4, height: 24, wire: 1.5, position: [0, 0, 0], mode: firstBody ? "new" : "add" };
    case "insert": return { part: "", vars: {}, scale: 1, position: [0, 0, 0], rotate: 0, axis: [0, 0, 1], origin: [0, 0, 0], mode: "new" };
    case "import": return { file: "", scale: 1, position: [0, 0, 0], mode: firstBody ? "new" : "add" };
    default: return {};
  }
}

export const TOOLBAR = [
  ["sketch", "plane"], ["extrude", "revolve", "sweep", "loft"], ["fillet", "chamfer", "shell", "hole", "split"],
  ["linearPattern", "circularPattern", "mirror"], ["box", "cylinder", "sphere", "gear", "coil"], ["boolean", "transform", "deleteBody"], ["import", "insert"],
];

export const PLANE_NAMES = { XY: "Top (XY)", XZ: "Front (XZ)", YZ: "Right (YZ)" };

/** One-line summary shown next to a feature in the tree. */
export function summary(f) {
  const v = (x) => (typeof x === "number" ? +x.toFixed(3) : x);
  switch (f.type) {
    case "sketch": {
      // e.g. "4 lines, 2 circles" (what you'd see drawn), or "empty"
      const counts = {};
      for (const g of f.geom ?? []) if (g.t !== "point" && !g.construction) counts[g.t] = (counts[g.t] ?? 0) + 1;
      if (f.entities?.length) counts.shape = f.entities.length;
      const word = { line: "line", circle: "circle", arc: "arc", ellipse: "ellipse", shape: "shape" };
      const parts = Object.entries(counts).map(([t, n]) => `${n} ${word[t] ?? t}${n === 1 ? "" : "s"}`);
      return parts.length ? parts.join(", ") : "empty";
    }
    case "extrude": return `${f.mode ?? ""} ${v(f.through ? "through" : f.distance)}`;
    case "revolve": return `${v(f.angle)}°`;
    case "fillet": case "chamfer": return `r ${v(f.radius)} · ${f.edges?.length ?? 0} edge${f.edges?.length === 1 ? "" : "s"}`;
    case "shell": return `${v(f.thickness)} mm`;
    case "hole": return `Ø${v(f.diameter)}`;
    case "linearPattern": case "circularPattern": return `×${v(f.count)}`;
    case "onshape": return "Onshape only";
    case "plane": return f.mode === "offset" || !f.mode ? `${f.from ?? "XY"} + ${f.distance}` : f.mode;
    case "loft": return `${f.sketches?.length ?? 0} sketches`;
    case "gear": return `m${f.module} z${f.teeth}`;
    case "insert": return f.orient !== undefined ? (f.fixed ? "fixed" : "") : String(f.part ?? "").split("/").pop().replace(".part.json", "");
    case "mate": return f.offset ? `gap ${f.offset}` : "fasten";
    case "import": return String(f.file ?? "").split("/").pop();
    default: return "";
  }
}
