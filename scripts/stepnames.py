# Leaf solids of a STEP assembly with their names (part name + the assembly path above it), colours and bounding boxes, as JSON.
# Usage: python -I stepnames.py in.step out.json
import json, sys
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType, XCAFDoc_ColorTool
from OCP.Quantity import Quantity_Color, Quantity_TypeOfColor
from OCP.TDF import TDF_Label, TDF_ChildIterator
from OCP.TDataStd import TDataStd_Name
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.TopLoc import TopLoc_Location

doc = TDocStd_Document(TCollection_ExtendedString("doc"))
r = STEPCAFControl_Reader(); r.SetNameMode(True)
assert r.ReadFile(sys.argv[1]) == 1
r.Transfer(doc)
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
def colour(labs):
    c = Quantity_Color()
    for lab in labs:
        for kind in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
            if XCAFDoc_ColorTool.GetColor_s(lab, kind, c): return '#%02X%02X%02X' % tuple(round(255 * v) for v in c.Values(Quantity_TypeOfColor.Quantity_TOC_sRGB))
    return None

def name(lab):
    a = TDataStd_Name()
    return a.Get().ToExtString() if lab.FindAttribute(TDataStd_Name.GetID_s(), a) else ""

out = []
def walk(lab, loc, path, chain=()):
    ref = TDF_Label()
    if st.IsReference_s(lab):
        st.GetReferredShape_s(lab, ref)
        walk(ref, loc.Multiplied(st.GetLocation_s(lab)), path + [name(lab) or name(ref)], (lab,) + chain)
        return
    if st.IsAssembly_s(lab):
        it = TDF_ChildIterator(lab, False)
        while it.More():
            if st.IsComponent_s(it.Value()): walk(it.Value(), loc, path, chain + (lab,))
            it.Next()
        return
    shape = st.GetShape_s(lab).Moved(loc)
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        b = Bnd_Box(); BRepBndLib.Add_s(ex.Current(), b)
        p0, p1 = b.CornerMin(), b.CornerMax(); x0, y0, z0, x1, y1, z1 = p0.X(), p0.Y(), p0.Z(), p1.X(), p1.Y(), p1.Z()
        # the solid's own colour first, then its part, then the instances / assemblies above it
        sub = TDF_Label(); own = colour([sub]) if st.FindSubShape(lab, ex.Current(), sub) else None
        out.append({"path": path + [name(lab)], "bbox": [[x0, y0, z0], [x1, y1, z1]], "color": own or colour((lab,) + chain)})
        ex.Next()

it = TDF_ChildIterator(st.Label(), False)
while it.More():
    lab = it.Value()
    if st.IsTopLevel(lab) and st.IsFree_s(lab): walk(lab, TopLoc_Location(), [name(lab)])
    it.Next()
json.dump(out, open(sys.argv[2], "w"))
print("solids", len(out))
