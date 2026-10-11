# Read the flat robot STEP once: list every solid with its name, colour and mass properties, and cache the geometry.
# Usage: python -I inspect.py <in.step> <out dir>
import json, sys, time, os
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType, XCAFDoc_ColorTool
from OCP.TDF import TDF_Label, TDF_ChildIterator
from OCP.TDataStd import TDataStd_Name
from OCP.Quantity import Quantity_Color, Quantity_TypeOfColor
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopoDS import TopoDS
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.BRepTools import BRepTools
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Compound
from OCP.TopLoc import TopLoc_Location
from OCP.IFSelect import IFSelect_RetDone

t0 = time.time()
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
r = STEPCAFControl_Reader(); r.SetNameMode(True); r.SetColorMode(True)
assert r.ReadFile(src) == IFSelect_RetDone, "read failed"
print(f"parsed {time.time()-t0:.0f}s", flush=True)
r.Transfer(doc)
print(f"transferred {time.time()-t0:.0f}s", flush=True)
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()); ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

def name(lab):
    a = TDataStd_Name()
    return a.Get().ToExtString() if lab.FindAttribute(TDataStd_Name.GetID_s(), a) else ""
def colour(lab, shape):
    c = Quantity_Color()
    for typ in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
        if XCAFDoc_ColorTool.GetColor_s(lab, typ, c) or ct.GetColor(shape, typ, c):
            rgb = c.Values(Quantity_TypeOfColor.Quantity_TOC_sRGB)
            return "#%02x%02x%02x" % tuple(round(v * 255) for v in rgb)
    return None

rows, bb = [], BRep_Builder(); comp = TopoDS_Compound(); bb.MakeCompound(comp)
tree = []
def walk(lab, loc, path, depth):
    shape = st.GetShape_s(lab)
    nm = name(lab)
    if st.IsReference_s(lab):
        ref = TDF_Label(); st.GetReferredShape_s(lab, ref)
        walk(ref, loc.Multiplied(st.GetLocation_s(lab)), path + ([nm] if nm else []), depth); return
    if st.IsAssembly_s(lab):
        tree.append({"depth": depth, "name": nm, "kind": "assembly"})
        it = TDF_ChildIterator(lab, False)
        while it.More():
            if st.IsComponent_s(it.Value()): walk(it.Value(), loc, path + ([nm] if nm else []), depth + 1)
            it.Next()
        return
    col = colour(lab, shape)
    ex = TopExp_Explorer(shape, TopAbs_SOLID); k = 0
    while ex.More():
        s = TopoDS.Solid(ex.Current()).Moved(loc); k += 1
        g = GProp_GProps(); BRepGProp.VolumeProperties_s(s, g)
        m = g.MatrixOfInertia(); c = g.CentreOfMass()
        a = GProp_GProps(); BRepGProp.SurfaceProperties_s(s, a)
        rows.append({"i": len(rows), "name": nm, "path": path, "colour": col, "vol": g.Mass(), "area": a.Mass(),
                     "com": [c.X(), c.Y(), c.Z()], "inertia": [[m.Value(i, j) for j in (1, 2, 3)] for i in (1, 2, 3)]})
        bb.Add(comp, s); ex.Next()
    tree.append({"depth": depth, "name": nm, "kind": "part", "solids": k})

roots = []
it = TDF_ChildIterator(st.Label(), False)
while it.More():
    if st.IsFree_s(it.Value()) and st.IsTopLevel(it.Value()): roots.append(it.Value())
    it.Next()
print("roots", len(roots), flush=True)
for lab in roots: walk(lab, TopLoc_Location(), [], 0)
json.dump(rows, open(f"{out}/solids.json", "w"))
json.dump(tree, open(f"{out}/tree.json", "w"))
BRepTools.Write_s(comp, f"{out}/solids.brep")
print(f"{len(rows)} solids, done {time.time()-t0:.0f}s", flush=True)
