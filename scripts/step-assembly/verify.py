# Read the rebuilt assembly back and match every placed solid to the original flat solids (centre of mass, volume).
# Usage: python -I verify.py <solids.json from inspect.py> <rebuilt.step>; the last line is RESULT {json}.
import json, sys, numpy as np
from scipy.spatial import cKDTree
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TDF import TDF_Label, TDF_ChildIterator
from OCP.TDataStd import TDataStd_Name
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopLoc import TopLoc_Location
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
rows = json.load(open(sys.argv[1]))
doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
r = STEPCAFControl_Reader(); r.SetNameMode(True); r.ReadFile(sys.argv[2]); r.Transfer(doc)
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
def name(lab):
    a = TDataStd_Name(); return a.Get().ToExtString() if lab.FindAttribute(TDataStd_Name.GetID_s(), a) else ""
got, tree, parts = [], [], set()
def walk(lab, loc, depth):
    if st.IsReference_s(lab):
        ref = TDF_Label(); st.GetReferredShape_s(lab, ref); walk(ref, loc.Multiplied(st.GetLocation_s(lab)), depth); return
    if st.IsAssembly_s(lab):
        tree.append(("  " * depth) + name(lab))
        it = TDF_ChildIterator(lab, False)
        while it.More():
            if st.IsComponent_s(it.Value()): walk(it.Value(), loc, depth + 1)
            it.Next()
        return
    parts.add(lab.Tag())
    ex = TopExp_Explorer(st.GetShape_s(lab).Moved(loc), TopAbs_SOLID)
    while ex.More():
        g = GProp_GProps(); BRepGProp.VolumeProperties_s(ex.Current(), g); c = g.CentreOfMass(); m = g.MatrixOfInertia()
        got.append((g.Mass(), [c.X(), c.Y(), c.Z()], [[m.Value(i, j) for j in (1, 2, 3)] for i in (1, 2, 3)])); ex.Next()
roots = []
it = TDF_ChildIterator(st.Label(), False)
while it.More():
    if st.IsFree_s(it.Value()) and st.IsTopLevel(it.Value()): roots.append(it.Value())
    it.Next()
for lab in roots: walk(lab, TopLoc_Location(), 0)
print("roots", len(roots), "| assemblies:", *tree, sep="\n  ")
print(f"solids: original {len(rows)}, rebuilt {len(got)}; unique part shapes {len(parts)}")
ov = sum(x["vol"] for x in rows); gv = sum(x[0] for x in got); print(f"total volume: original {ov:.1f}, rebuilt {gv:.1f} mm3 ({abs(gv-ov)/ov*100:.5f}% diff)")
oc = np.array([x["com"] for x in rows]); t = cKDTree(np.array([x[1] for x in got]))
import collections
gv_ = np.array([x[0] for x in got])
dd, ii = t.query(oc, k=8)
d, idx = [], []
taken = set()
for k in np.argsort(dd[:, 0]):   # closest first, prefer same volume, each rebuilt solid used once
    best = None
    for dist, j in zip(dd[k], ii[k]):
        if j in taken: continue
        if abs(gv_[j] - rows[k]["vol"]) / max(rows[k]["vol"], 1e-9) < 1e-4: best = (dist, j); break
    if best is None: best = next(((a, b) for a, b in zip(dd[k], ii[k]) if b not in taken), (dd[k][0], ii[k][0]))
    taken.add(best[1]); d.append((k, best))
d.sort(); idx = [b[1] for _, b in d]; d = [b[0] for _, b in d]
used = np.zeros(len(got), int)
bad = 0; worst = 0
for k, (dist, j) in enumerate(zip(d, idx)):
    used[j] += 1
    dv = abs(got[j][0] - rows[k]["vol"]) / max(rows[k]["vol"], 1e-9)
    di = np.abs(np.array(got[j][2]) - np.array(rows[k]["inertia"])).max() / max(np.abs(np.array(rows[k]["inertia"])).max(), 1e-9)
    worst = max(worst, dist)
    if dist > 0.01 or dv > 1e-5 or di > 1e-4:
        bad += 1
print(f"every original solid matched: worst centre offset {worst:.6f} mm, mismatches {bad}, rebuilt solids matched more than once {int((used > 1).sum())}, unmatched {int((used == 0).sum())}")
print("RESULT " + json.dumps({"original": len(rows), "rebuilt": len(got), "unique": len(parts), "volumeDiffPct": abs(gv - ov) / ov * 100,
      "worstOffsetMm": float(worst), "unmatched": int((used == 0).sum()), "duplicates": int((used > 1).sum()), "assemblies": [t.strip() for t in tree]}))
