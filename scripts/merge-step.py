# Merge the chunk STEP files written by scripts/export-step.mjs into one STEP file, keeping every part's name and colour.
# Each chunk part is named "row N"; its real name and colour (sRGB hex) are row N of <chunk dir>/parts.json.
# Needs OCP (cadquery-ocp).  Usage: python -I scripts/merge-step.py <chunk dir> <out.step>
import glob, json, re, sys, time
from OCP.STEPCAFControl import STEPCAFControl_Reader, STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType, XCAFDoc_ColorTool
from OCP.TDF import TDF_Label, TDF_ChildIterator
from OCP.TDataStd import TDataStd_Name
from OCP.TopLoc import TopLoc_Location
from OCP.Quantity import Quantity_Color, Quantity_TypeOfColor
from OCP.Interface import Interface_Static
from OCP.gp import gp_Trsf, gp_Vec, gp_Ax1, gp_Pnt, gp_Dir
import math

t = time.time()
PARTS = json.load(open(sys.argv[1] + "/parts.json"))
def srgb(hexc):
    h = hexc.lstrip('#'); return Quantity_Color(int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255, Quantity_TypeOfColor.Quantity_TOC_sRGB)
SURF = XCAFDoc_ColorType.XCAFDoc_ColorSurf
GEN = XCAFDoc_ColorType.XCAFDoc_ColorGen

def name(lab):
    a = TDataStd_Name()
    return a.Get().ToExtString() if lab.FindAttribute(TDataStd_Name.GetID_s(), a) else ""

out = TDocStd_Document(TCollection_ExtendedString("merged"))
ost, oct_ = XCAFDoc_DocumentTool.ShapeTool_s(out.Main()), XCAFDoc_DocumentTool.ColorTool_s(out.Main())
count = 0

def add_assembly(row):
    """An assembly cadSlop imported as one body: add the file's own parts (names, colours), moved the way the import moved it:
    anchor to the origin, rotate about X, then Y, then Z (degrees), then to position."""
    global count
    tr = gp_Trsf(); tr.SetTranslation(gp_Vec(*[-v for v in row["anchor"]]))
    for ax, deg in zip(((1, 0, 0), (0, 1, 0), (0, 0, 1)), row["orient"]):
        if deg: r = gp_Trsf(); r.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(*ax)), math.radians(deg)); tr = r.Multiplied(tr)
    t2 = gp_Trsf(); t2.SetTranslation(gp_Vec(*row["position"])); tr = t2.Multiplied(tr)
    doc = TDocStd_Document(TCollection_ExtendedString("asm"))
    rd = STEPCAFControl_Reader(); rd.SetNameMode(True); rd.SetColorMode(True)
    assert rd.ReadFile(row["file"]) == 1, row["file"]
    rd.Transfer(doc)
    st2 = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    title = row["name"]
    def colour2(labs):
        c = Quantity_Color()
        for lab in labs:
            for kind in (SURF, GEN):
                if XCAFDoc_ColorTool.GetColor_s(lab, kind, c): return c
        return None
    def walk2(lab, loc, nm, chain):
        global count
        ref = TDF_Label()
        if st2.IsReference_s(lab):
            st2.GetReferredShape_s(lab, ref)
            walk2(ref, loc.Multiplied(st2.GetLocation_s(lab)), name(lab) or name(ref) or nm, (lab,) + chain); return
        if st2.IsAssembly_s(lab):
            it2 = TDF_ChildIterator(lab, False)
            while it2.More():
                if st2.IsComponent_s(it2.Value()): walk2(it2.Value(), loc, nm, chain + (lab,))
                it2.Next()
            return
        shape = st2.GetShape_s(lab).Moved(TopLoc_Location(tr).Multiplied(loc))
        new = ost.AddShape(shape, False)
        part = (name(lab) or nm or "part").split("__")[0].strip()
        TDataStd_Name.Set_s(new, TCollection_ExtendedString(f"{title}: {part}"))
        c = colour2((lab,) + chain)
        if c is not None: oct_.SetColor(new, c, SURF)
        count += 1
    it2 = TDF_ChildIterator(st2.Label(), False)
    while it2.More():
        lab = it2.Value()
        if st2.IsTopLevel(lab) and st2.IsFree_s(lab): walk2(lab, TopLoc_Location(), name(lab), ())
        it2.Next()
for f in sorted(glob.glob(sys.argv[1] + "/c*.step")):
    doc = TDocStd_Document(TCollection_ExtendedString("chunk"))
    r = STEPCAFControl_Reader(); r.SetNameMode(True); r.SetColorMode(True)
    assert r.ReadFile(f) == 1, f
    r.Transfer(doc)
    st, ct = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()), XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    def colour(*labs):
        c = Quantity_Color()
        for lab in labs:
            for kind in (SURF, GEN):
                if XCAFDoc_ColorTool.GetColor_s(lab, kind, c): return c
        return None

    def walk(lab, loc, nm, inst):
        global count
        ref = TDF_Label()
        if st.IsReference_s(lab):
            st.GetReferredShape_s(lab, ref)
            walk(ref, loc.Multiplied(st.GetLocation_s(lab)), name(lab) or name(ref) or nm, lab)
            return
        if st.IsAssembly_s(lab):
            it = TDF_ChildIterator(lab, False)
            while it.More():
                if st.IsComponent_s(it.Value()): walk(it.Value(), loc, nm, inst)
                it.Next()
            return
        raw = name(lab) or nm or ""
        m = re.match(r"^row (\d+)$", raw)
        if m and PARTS[int(m.group(1))].get("file"):
            add_assembly(PARTS[int(m.group(1))]); return
        shape = st.GetShape_s(lab).Moved(loc)
        new = ost.AddShape(shape, False)
        if m:
            row = PARTS[int(m.group(1))]
            TDataStd_Name.Set_s(new, TCollection_ExtendedString(row["name"]))
            oct_.SetColor(new, srgb(row["color"]), SURF)
        else:
            TDataStd_Name.Set_s(new, TCollection_ExtendedString(raw or f"part {count + 1}"))
            c = colour(lab, inst) if inst is not None else colour(lab)
            if c is not None: oct_.SetColor(new, c, SURF)
        count += 1

    it = TDF_ChildIterator(st.Label(), False)
    while it.More():
        lab = it.Value()
        if st.IsTopLevel(lab) and st.IsFree_s(lab): walk(lab, TopLoc_Location(), name(lab), None)
        it.Next()
    print("read", f.split("/")[-1], count, "parts", round(time.time() - t), "s", flush=True)

Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
w = STEPCAFControl_Writer(); w.SetNameMode(True); w.SetColorMode(True)
w.Transfer(out, STEPControl_AsIs); w.Write(sys.argv[2])
print("wrote", count, "parts", round(time.time() - t), "s")
