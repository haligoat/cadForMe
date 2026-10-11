# Rebuild a plate-like part (flat caps, all other faces straight through) as a cadForMe part: one sketch + extrude per
# thickness level (the slab's exact outline from a section), and every hole that goes all the way through in one
# "Holes" sketch + cut. Sketch points get x/y dimensions, circles their diameter, so every sketch is fully defined.
# Usage: python -I plate2part.py <scratch dir> "<part name>" <out.part.json>
import json, sys, math, os
import numpy as np
from OCP.BRepTools import BRepTools, BRepTools_WireExplorer
from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.TopoDS import TopoDS_Shape, TopoDS_Iterator, TopoDS
from OCP.TopExp import TopExp_Explorer, TopExp
from OCP.TopAbs import TopAbs_FACE, TopAbs_WIRE, TopAbs_EDGE, TopAbs_REVERSED
from OCP.BRepAdaptor import BRepAdaptor_Surface, BRepAdaptor_Curve
from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Line, GeomAbs_Circle
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.gp import gp_Pnt
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
D, NAME, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
rows = json.load(open(f"{D}/out/solids.json"))
comp = TopoDS_Shape(); BRepTools.Read_s(comp, f"{D}/out/solids.brep", BRep_Builder())
sol = []; it = TopoDS_Iterator(comp)
while it.More(): sol.append(it.Value()); it.Next()
shape = sol[next(k for k, r in enumerate(rows) if r["name"] == NAME)]
# cadForMe standard planes: XY (n +Z, x X, y Y), XZ (n -Y, x X, y Z), YZ (n +X, x Y, y Z)
STD = {"XY": ([1, 0, 0], [0, 1, 0], [0, 0, 1]), "XZ": ([1, 0, 0], [0, 0, 1], [0, -1, 0]), "YZ": ([0, 1, 0], [0, 0, 1], [1, 0, 0])}
def faces(s):
    ex = TopExp_Explorer(s, TopAbs_FACE)
    while ex.More(): yield TopoDS.Face(ex.Current()); ex.Next()
def area(f): g = GProp_GProps(); BRepGProp.SurfaceProperties_s(f, g); return g.Mass()
caps = [f for f in faces(shape) if BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane]
big = max(caps, key=area); d = BRepAdaptor_Surface(big).Plane().Axis().Direction(); nrm = np.array([d.X(), d.Y(), d.Z()])
std = next(k for k, (x, y, n) in STD.items() if abs(abs(np.dot(n, nrm)) - 1) < 1e-6)
X, Y, N = (np.array(v, float) for v in STD[std])
lev = sorted({round(float(np.dot([BRepAdaptor_Surface(f).Plane().Location().X(), BRepAdaptor_Surface(f).Plane().Location().Y(), BRepAdaptor_Surface(f).Plane().Location().Z()], N)), 4)
              for f in caps if abs(abs(np.dot([BRepAdaptor_Surface(f).Plane().Axis().Direction().X(), BRepAdaptor_Surface(f).Plane().Axis().Direction().Y(), BRepAdaptor_Surface(f).Plane().Axis().Direction().Z()], N)) - 1) < 1e-6})
# levels closer than 0.05 mm are one level (e.g. a merged tab that sits 0.017 mm proud)
snapped = []
for h in lev:
    if snapped and abs(h - snapped[-1]) < 0.05: continue
    snapped.append(h)
if lev[-1] - snapped[-1] > 1e-9 and abs(lev[-1] - snapped[-1]) < 0.05: snapped[-1] = lev[-1]   # keep the true outer face
lev = snapped if not os.environ.get('NOSNAP') else lev
# a slab's outline: the cap face(s) of the solid cut to a thin layer just above the slab bottom
def slab_loops(h0, h1):
    pts = [np.array([-1e4, -1e4, -1e4]), np.array([1e4, 1e4, 1e4])]
    lo = h0 + 1e-3 * (h1 - h0); hi = h0 + 0.5 * (h1 - h0)
    a = -1e4 * (np.ones(3) - np.abs(N)) + N * min(lo, hi) * np.sign(N.sum()) if False else None
    # box covering everything along X/Y of the frame, and [lo, hi] along N (N has one non-zero component)
    k = int(np.argmax(np.abs(N))); s = N[k]
    mn = [-1e4] * 3; mx = [1e4] * 3; vals = sorted([lo * s, hi * s]); mn[k], mx[k] = vals
    cut = BRepAlgoAPI_Common(shape, BRepPrimAPI_MakeBox(gp_Pnt(*mn), gp_Pnt(*mx)).Shape()).Shape()
    loops = []
    for f in faces(cut):
        a = BRepAdaptor_Surface(f)
        if a.GetType() != GeomAbs_Plane: continue
        dd = a.Plane().Axis().Direction(); v = np.array([dd.X(), dd.Y(), dd.Z()])
        loc = a.Plane().Location(); h = np.dot([loc.X(), loc.Y(), loc.Z()], N)
        if abs(abs(np.dot(v, N)) - 1) > 1e-6 or abs(h - lo) > 1e-4: continue
        wx = TopExp_Explorer(f, TopAbs_WIRE)
        while wx.More():
            loop = []; we = BRepTools_WireExplorer(TopoDS.Wire(wx.Current()))
            while we.More():
                e = we.Current(); c = BRepAdaptor_Curve(e); rev = e.Orientation() == TopAbs_REVERSED
                p0, p1 = c.Value(c.FirstParameter()), c.Value(c.LastParameter())
                P = lambda p: (round(float(np.dot([p.X(), p.Y(), p.Z()], X)), 4), round(float(np.dot([p.X(), p.Y(), p.Z()], Y)), 4))
                a0, a1 = (P(p1), P(p0)) if rev else (P(p0), P(p1))
                if c.GetType() == GeomAbs_Line: loop.append(("line", a0, a1))
                elif c.GetType() == GeomAbs_Circle:
                    ci = c.Circle(); cc = ci.Location(); ctr = P(cc); r = ci.Radius()
                    if abs(c.LastParameter() - c.FirstParameter() - 2 * math.pi) < 1e-6: loop.append(("circle", ctr, r))
                    else:
                        mid = c.Value((c.FirstParameter() + c.LastParameter()) / 2); m = P(mid)
                        # counter-clockwise from s to e in sketch coordinates: check the midpoint is on the left of s->e
                        cross = (a1[0] - a0[0]) * (m[1] - a0[1]) - (a1[1] - a0[1]) * (m[0] - a0[0])
                        s_, e_ = (a0, a1) if cross > 0 else (a1, a0)
                        # cross > 0: mid is left of s->e, i.e. the arc bulges left, which is CW from s to e... decide by angles instead
                        ang = lambda q: math.atan2(q[1] - ctr[1], q[0] - ctr[0])
                        t0, tm, t1 = ang(a0), ang(m), ang(a1)
                        ccw = ((tm - t0) % (2 * math.pi)) < ((t1 - t0) % (2 * math.pi))
                        loop.append(("arc", ctr, a0 if ccw else a1, a1 if ccw else a0, r))
                else: raise SystemExit(f"{NAME}: edge type {c.GetType()} not handled")
                we.Next()
            loops.append(loop); wx.Next()
    return loops
def loop_key(l): return json.dumps(sorted(json.dumps(e) for e in l))
slabs = []
for h0, h1 in zip(lev, lev[1:]):
    loops = slab_loops(h0, h1)
    if not loops: continue   # empty between two separate parts of the solid
    if slabs and slabs[-1]["key"] == sorted(loop_key(l) for l in loops) and abs(slabs[-1]["h1"] - h0) < 1e-6: slabs[-1]["h1"] = h1; continue
    slabs.append({"h0": h0, "h1": h1, "loops": loops, "key": sorted(loop_key(l) for l in loops)})
# holes all the way through: a circle loop present in every slab
circ = lambda l: len(l) == 1 and l[0][0] == "circle"
through = set.intersection(*[{json.dumps(l) for l in s["loops"] if circ(l)} for s in slabs]) if slabs else set()
feats = []; k = [0]
def nid(p): k[0] += 1; return f"{p}{k[0]}"
def sketch(name, offset, loops):
    geom, cons, pid = [], [], {}
    def pt(xy):
        if xy not in pid:
            i = nid("p"); pid[xy] = i; geom.append({"id": i, "t": "point", "x": xy[0], "y": xy[1]})
            cons.append({"id": nid("d"), "t": "dim", "k": "x", "a": i, "v": xy[0]}); cons.append({"id": nid("d"), "t": "dim", "k": "y", "a": i, "v": xy[1]})
        return pid[xy]
    for l in loops:
        for e in l:
            if e[0] == "line": geom.append({"id": nid("l"), "t": "line", "a": pt(e[1]), "b": pt(e[2])})
            elif e[0] == "circle":
                c = nid("p"); ci = nid("c"); geom.append({"id": c, "t": "point", "x": e[1][0], "y": e[1][1]}); geom.append({"id": ci, "t": "circle", "c": c, "r": round(e[2], 4)})
                cons += [{"id": nid("d"), "t": "dim", "k": "x", "a": c, "v": e[1][0]}, {"id": nid("d"), "t": "dim", "k": "y", "a": c, "v": e[1][1]}, {"id": nid("d"), "t": "dim", "k": "diameter", "a": ci, "v": round(2 * e[2], 4)}]
            elif e[0] == "arc": geom.append({"id": nid("a"), "t": "arc", "c": pt(e[1]), "s": pt(e[2]), "e": pt(e[3])})
    sid = nid("sk"); f = {"id": sid, "type": "sketch", "name": name, "plane": std, "geom": geom, "cons": cons}
    if abs(offset) > 1e-9: f["offset"] = round(offset, 4)
    feats.append(f); return sid
for i, s in enumerate(slabs):
    loops = [l for l in s["loops"] if json.dumps(l) not in through]
    sid = sketch(f"{'Plate' if len(slabs) == 1 else f'Level {i + 1}'} profile", s["h0"], loops)
    feats.append({"id": nid("ex"), "type": "extrude", "name": "Plate" if len(slabs) == 1 else f"Level {i + 1} ({s['h1'] - s['h0']:g} mm)", "sketch": sid, "distance": round(s["h1"] - s["h0"], 4), "mode": "new" if i == 0 else "add"})
if through:
    sid = sketch("Holes", lev[0], [json.loads(t) for t in sorted(through)])
    feats.append({"id": nid("ex"), "type": "extrude", "name": f"Holes ({len(through)})", "sketch": sid, "distance": round(lev[-1] - lev[0], 4), "through": True, "mode": "cut"})
json.dump({"name": NAME.split(" (")[0], "description": NAME, "variables": {}, "features": feats}, open(OUT, "w"), indent=1)
print(f"{NAME}: plane {std}, levels {lev}, {len(slabs)} extrude(s), {len(through)} through-holes -> {OUT}")
