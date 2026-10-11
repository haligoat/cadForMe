// Body bookkeeping for Onshape. cadSlop features pick bodies by number ("body 2"); Onshape picks them with queries.
// Replaying the body list feature by feature tells us which features' output makes up body N at any point, and that
// becomes a qCreatedBy query in Onshape.
//
// An entry is { from: [feature ids whose output is (part of) this body], shared?, pure?, moves? }:
//   shared: the query would also catch other bodies (one feature made several copies), so it can't pick this one alone
//   pure:   id of the box/cylinder that made it, while nothing but whole-body moves has touched it since
//   moves:  the transforms applied to it while it was pure (nativize folds them into the primitive)
// The list is null once a feature changes the bodies in a way we can't follow (e.g. an "add" that merges by touch).

const PRIMITIVES = new Set(["box", "cylinder", "sphere", "import", "insert"]);   // default mode "new"
const MAKERS = new Set(["extrude", "revolve", "loft", "sweep", "gear", "coil"]);  // default mode: new if no bodies yet, else add
const PASSIVE = new Set(["sketch", "plane"]);
const TOUCH_ALL = new Set(["fillet", "chamfer", "shell", "hole"]);                 // may reshape any body, never adds or removes one

export function pickBodies(bodies, sel) {
  if (sel === undefined || sel === "all") return bodies.map((_, i) => i);
  return (Array.isArray(sel) ? sel : [sel]).map(Number).filter((i) => i >= 0 && i < bodies.length);
}
const plain = (e) => ({ from: e.from, ...(e.shared ? { shared: true } : {}) });

function step(bodies, f) {
  if (PASSIVE.has(f.type)) return bodies;
  if (TOUCH_ALL.has(f.type)) return bodies.map(plain);
  if (PRIMITIVES.has(f.type) || MAKERS.has(f.type)) {
    const mode = f.mode ?? (PRIMITIVES.has(f.type) || !bodies.length ? "new" : "add");
    if (mode === "new") return [...bodies, { from: [f.id], ...(f.type === "box" || f.type === "cylinder" ? { pure: f.id, moves: [] } : {}) }];
    if (mode === "cut" || mode === "intersect") return bodies.map(plain);
    return bodies.length ? null : [{ from: [f.id] }];   // add: cadSlop merges whatever it touches, which we can't know here
  }
  switch (f.type) {
    case "boolean": {
      const a = Number(f.a), b = Number(f.b);
      if (!bodies[a] || !bodies[b] || a === b) return bodies;   // the kernel reports it and leaves the bodies alone
      const res = { from: [...new Set([...bodies[a].from, ...bodies[b].from, f.id])], ...(bodies[a].shared || bodies[b].shared ? { shared: true } : {}) };
      return bodies.map((x, i) => (i === a ? res : x)).filter((_, i) => i !== b);
    }
    case "transform": {
      const idx = pickBodies(bodies, f.body);
      if (f.copy) return [...bodies, ...idx.map(() => ({ from: [f.id], ...(idx.length > 1 ? { shared: true } : {}) }))];
      const whole = f.scale === undefined || Number(f.scale) === 1;
      return bodies.map((e, i) => (!idx.includes(i) ? e : e.pure && whole && idx.length === 1 ? { ...e, moves: [...e.moves, f.id] } : plain(e)));
    }
    case "mirror": case "linearPattern": case "circularPattern": {
      const idx = pickBodies(bodies, f.body);
      if (f.merge !== false) return bodies.map((e, i) => (idx.includes(i) ? { from: [...e.from, f.id], ...(e.shared || idx.length > 1 ? { shared: true } : {}) } : e));
      const several = idx.length > 1 || f.type !== "mirror";   // a pattern makes several copies, all created by the one feature
      return [...bodies, ...idx.map(() => ({ from: [f.id], ...(several ? { shared: true } : {}) }))];
    }
    case "deleteBody": { const drop = new Set(pickBodies(bodies, f.body)); return bodies.filter((_, i) => !drop.has(i)); }
    default: return null;   // split, onshape-only features, anything new: can't follow
  }
}

/** Body list just before each feature: Map(feature id -> entries, or null when unknown). `.final` is the list at the end. */
export function bodiesBefore(features) {
  const at = new Map();
  let bodies = [];
  for (const f of features) {
    at.set(f.id, bodies);
    if (!f.suppressed && bodies) bodies = step(bodies, f);
  }
  at.final = bodies;
  return at;
}
