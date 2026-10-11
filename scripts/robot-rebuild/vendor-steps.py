# One STEP file per unique non-designed part of the robot (each centred on its own centre of mass, like the parts of the
# step-assembly output), plus classes.json listing them and where every copy goes. Usage: python -I vendor-steps.py <scratch dir>
import json, re, collections, os, sys
from OCP.BRepTools import BRepTools
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shape, TopoDS_Iterator
from OCP.gp import gp_Trsf, gp_Vec
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.TopLoc import TopLoc_Location
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType
from OCP.TDataStd import TDataStd_Name
from OCP.Quantity import Quantity_Color, Quantity_TypeOfColor
from OCP.Interface import Interface_Static
S = sys.argv[1]
rows = json.load(open(f"{S}/out/solids.json")); P = json.load(open(f"{S}/out/placements.json"))
comp = TopoDS_Shape(); BRepTools.Read_s(comp, f"{S}/out/solids.brep", BRep_Builder())
sol = []; it = TopoDS_Iterator(comp)
while it.More(): sol.append(it.Value()); it.Next()
CUSTOM = re.compile(r"^(Side plate [AB]|Shooter mount plate|Intake motor mount|Transfer side plate [AB]|Transfer floor piece|Funnel side [AB]|Bracket [AB],|Bumper bracket [AB]|Transfer motor plate|Intake shaft support)")
SCREW = re.compile(r"\b(screws?|nuts?|lock ?nuts?|bolts?|button head|flat head)\b", re.I)
keep = [p for p in P if p["group"] not in ("Static Pollen Shooter v1", "Proof-of-fit fasteners") and not CUSTOM.match(p["name"] or p["part"]) and not SCREW.search(p["name"] or p["part"])]
os.makedirs(f"{S}/vendor", exist_ok=True)
Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
classes = {}
for p in keep:
    c = classes.setdefault(p["part"], {"name": p["part"], "rep": p["solid"], "placements": []})
    c["placements"].append({"solid": p["solid"], "group": p["group"], "rotation": p["rotation"], "position": p["position"], "instance": p["name"]})
out = []
for k, c in enumerate(sorted(classes.values(), key=lambda c: c["name"])):
    r = rows[c["rep"]]; T = gp_Trsf(); T.SetTranslation(gp_Vec(*(-v for v in r["com"])))
    base = sol[c["rep"]]; T.Multiply(base.Location().Transformation())
    shape = BRepBuilderAPI_Transform(base.Located(TopLoc_Location()), T, True).Shape()
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF")); st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()); ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    lab = st.AddShape(shape, False); TDataStd_Name.Set_s(lab, TCollection_ExtendedString(c["name"]))
    if r["colour"]: h = r["colour"].lstrip("#"); ct.SetColor(lab, Quantity_Color(int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255, Quantity_TypeOfColor.Quantity_TOC_sRGB), XCAFDoc_ColorType.XCAFDoc_ColorSurf)
    w = STEPCAFControl_Writer(); w.SetNameMode(True); w.SetColorMode(True); w.Transfer(doc, STEPControl_AsIs)
    fn = re.sub(r"[^\w.-]+", "-", c["name"]).strip("-")[:60] + f"-{k}"
    w.Write(f"{S}/vendor/{fn}.step"); out.append({"file": f"{fn}.step", "name": c["name"], "count": len(c["placements"]), "placements": c["placements"]})
json.dump(out, open(f"{S}/vendor/classes.json", "w"))
print(len(out), "STEP files,", sum(len(c["placements"]) for c in out), "placements ->", f"{S}/vendor")
