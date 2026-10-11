# Rebuild the flat robot STEP as a real assembly: identical solids become one part used many times (exact rigid
# transform, checked vertex by vertex), parts are grouped into subassemblies by their name prefix, names and colours kept.
# Usage: python -I build.py <out dir from inspect.py> <result.step> [keyword groups JSON]; writes <out dir>/parts.json too
import json, sys, time, re, collections
import numpy as np
from scipy.spatial import cKDTree
from OCP.BRepTools import BRepTools
from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.TopoDS import TopoDS, TopoDS_Shape, TopoDS_Iterator
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_VERTEX
from OCP.gp import gp_Trsf, gp_Vec
from OCP.TopLoc import TopLoc_Location
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType, XCAFDoc_ColorTool
from OCP.TDataStd import TDataStd_Name
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.Quantity import Quantity_Color, Quantity_TypeOfColor
from OCP.Interface import Interface_Static

t0 = time.time()
D, OUT = sys.argv[1], sys.argv[2]
rows = json.load(open(f"{D}/solids.json"))
comp = TopoDS_Shape(); BRepTools.Read_s(comp, f"{D}/solids.brep", BRep_Builder())
solids = []
it = TopoDS_Iterator(comp)
while it.More(): solids.append(it.Value()); it.Next()
assert len(solids) == len(rows), (len(solids), len(rows))
print(f"loaded {len(solids)} solids {time.time()-t0:.0f}s", flush=True)

def verts(s):
    ex = TopExp_Explorer(s, TopAbs_VERTEX); out = []
    while ex.More():
        p = BRep_Tool.Pnt_s(TopoDS.Vertex(ex.Current())); out.append((p.X(), p.Y(), p.Z())); ex.Next()
    return np.unique(np.round(np.array(out, dtype=float).reshape(-1, 3), 6), axis=0)

V = [None] * len(solids)
def V_(i):
    if V[i] is None: V[i] = verts(solids[i])
    return V[i]

TOL = 0.005   # mm
def check(R, P, Q, cP, cQ, tree):
    d, _ = tree.query((P - cP) @ R.T + cQ)
    return d.max() < TOL

def find_rotation(i, j):
    """Rotation R with R (solid i - com_i) + com_j == solid j, or None."""
    P, Q = V_(i), V_(j)
    if len(P) != len(Q): return None
    cP, cQ = np.array(rows[i]["com"]), np.array(rows[j]["com"])
    tree = cKDTree(Q)
    if len(P) == 0: return None
    wi, Ei = np.linalg.eigh(np.array(rows[i]["inertia"])); wj, Ej = np.linalg.eigh(np.array(rows[j]["inertia"]))
    scale = max(abs(wi).max(), 1e-9)
    if np.all(np.diff(wi) > 1e-4 * scale):
        for sx in (1, -1):
            for sy in (1, -1):
                for sz in (1, -1):
                    R = Ej @ np.diag([sx, sy, sz]) @ Ei.T
                    if np.linalg.det(R) > 0 and check(R, P, Q, cP, cQ, tree): return R
    # symmetric or degenerate: match two anchor vertices by distance from the centre and their angle
    p = P - cP; q = Q - cQ
    rp, rq = np.linalg.norm(p, axis=1), np.linalg.norm(q, axis=1)
    a = int(np.argmax(rp))
    cross = np.linalg.norm(np.cross(p, p[a]), axis=1)
    b = int(np.argmax(cross))
    if cross[b] < 1e-6: return None
    A = np.where(np.abs(rq - rp[a]) < TOL)[0]; B = np.where(np.abs(rq - rp[b]) < TOL)[0]
    dot = p[a] @ p[b]
    def frame(u, v):
        e1 = u / np.linalg.norm(u); e3 = np.cross(u, v); e3 /= np.linalg.norm(e3); return np.stack([e1, np.cross(e3, e1), e3], 1)
    Fp = frame(p[a], p[b]); tries = 0
    for ia in A[:400]:
        for ib in B[:400]:
            if abs(q[ia] @ q[ib] - dot) > TOL * (rp[a] + rp[b]): continue
            if np.linalg.norm(np.cross(q[ia], q[ib])) < 1e-6: continue
            R = frame(q[ia], q[ib]) @ Fp.T
            tries += 1
            if check(R, P, Q, cP, cQ, tree): return R
            if tries > 2000: return None
    return None

# ---- names and subassemblies ----
# A name prefix "Group: part" shared by 2+ solids makes a subassembly; "(proof of fit)" hardware gets its own; optional
# keyword groups come from argv[3], a JSON object {"Transfer": "\\btransfer\\b"} (regex, case-insensitive) or a file with one.
GENERIC = re.compile(r"^(Open CASCADE STEP translator.*|SOLID|)$")
def raw_name(r):
    return r["path"][-1] if GENERIC.match(r["name"]) and r["path"] else r["name"]
prefixes = collections.Counter(m.group(1) for m in (re.match(r"^([^:]{3,60}):\s", raw_name(r)) for r in rows) if m and m.group(1).count("(") == m.group(1).count(")"))
KEYWORDS = {}
if len(sys.argv) > 3:
    arg = sys.argv[3]
    KEYWORDS = json.load(open(arg)) if not arg.lstrip().startswith("{") else json.loads(arg)
def split(r):
    name = raw_name(r); group = None
    m = re.match(r"^(.+?) \(proof of fit\): (.*)$", name)
    if m: group, name = "Proof-of-fit fasteners", m.group(1)
    else:
        group = next((g for g, rx in KEYWORDS.items() if re.search(rx, name, re.I)), None)   # keyword groups win
        m = re.match(r"^([^:]{3,60}):\s*(.*)$", name)
        if m and prefixes[m.group(1)] >= 2:
            group = group or m.group(1)
            name = m.group(2)   # "Side B front drive pod:" alone is no part name
    name = re.sub(r":\d+$", "", name).replace("Â®", "®").strip()
    if GENERIC.match(name): name = ""
    return group, name

info = [split(r) for r in rows]

# ---- find identical parts ----
order = sorted(range(len(rows)), key=lambda i: rows[i]["vol"])
classes = []   # {rep, members: [(idx, R)]}
by_key = collections.defaultdict(list)
def key(i):
    r = rows[i]; return (round(np.log10(max(r["vol"], 1e-12)), 4), round(np.log10(max(r["area"], 1e-12)), 4))
for n, i in enumerate(order):
    k = key(i); hit = None
    cands = [c for kk in [(k[0] + dx, k[1] + dy) for dx in (-1e-4, 0, 1e-4) for dy in (-1e-4, 0, 1e-4)] for c in by_key.get((round(kk[0], 4), round(kk[1], 4)), [])]
    for c in cands:
        R = find_rotation(c["rep"], i)
        if R is not None: hit = (c, R); break
    if hit: hit[0]["members"].append((i, hit[1]))
    else:
        c = {"rep": i, "members": [(i, np.eye(3))]}; classes.append(c); by_key[k].append(c)
    if n % 100 == 0: print(f"  {n}/{len(order)} solids, {len(classes)} unique, {time.time()-t0:.0f}s", flush=True)
print(f"{len(classes)} unique parts from {len(rows)} solids {time.time()-t0:.0f}s", flush=True)

# ---- part names: most common real name among the copies; unnamed get a number ----
names_used = collections.Counter(); unnamed = 0
for c in sorted(classes, key=lambda c: c["rep"]):
    cnt = collections.Counter(info[i][1] for i, _ in c["members"] if info[i][1])
    nm = cnt.most_common(1)[0][0] if cnt else None
    if len(cnt) > 1:   # copies named after where they sit: name the part after what they share
        parens = [set(re.findall(r"\(([^()]*)\)", x)) for x in cnt]
        common = set.intersection(*parens)
        if common: nm = max(common, key=len)
        else:
            pre = re.sub(r"[\s(:-]+\S*$", "", __import__("os").path.commonprefix(list(cnt))).strip()
            if len(pre) >= 4: nm = pre
    if not nm:
        unnamed += 1
        gs = {info[i][0] for i, _ in c["members"] if info[i][0]}
        nm = f"{gs.pop() if len(gs) == 1 else 'Robot'} part {unnamed}"
    names_used[nm] += 1
    c["name"] = nm if names_used[nm] == 1 else f"{nm} ({names_used[nm]})"
    cols = collections.Counter(rows[i]["colour"] for i, _ in c["members"] if rows[i]["colour"])
    c["colour"] = cols.most_common(1)[0][0] if cols else None

# ---- XCAF document ----
doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()); ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
def setname(lab, s): TDataStd_Name.Set_s(lab, TCollection_ExtendedString(s))
def colour(hexc):
    h = hexc.lstrip("#"); return Quantity_Color(int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255, Quantity_TypeOfColor.Quantity_TOC_sRGB)
def trsf(R, t):
    U, _, Vt = np.linalg.svd(R); R = U @ Vt   # exact rotation (no float drift)
    v = [float(x) for x in (*R[0], t[0], *R[1], t[1], *R[2], t[2])]
    T = gp_Trsf(); T.SetValues(*v); return T

root = st.NewShape(); setname(root, "Robot")
groups = {}
def group_label(g):
    if g is None: return root
    if g not in groups:
        lab = st.NewShape(); setname(lab, g); groups[g] = lab
    return groups[g]

for c in classes:
    rep = c["rep"]; com = np.array(rows[rep]["com"])
    # part geometry centred on its centre of mass, so each Part Studio has it at the origin
    T0 = gp_Trsf(); T0.SetTranslation(gp_Vec(*(-com)))
    # bake every placement into the geometry: a shape that still carries a location (bodies that came from a nested
    # assembly) is written as a nested product that Onshape places differently from OpenCascade
    base = solids[rep]; T0.Multiply(base.Location().Transformation())
    shape = BRepBuilderAPI_Transform(base.Located(TopLoc_Location()), T0, True).Shape()
    assert shape.Location().IsIdentity()
    c["label"] = st.AddShape(shape, False)
    setname(c["label"], c["name"])
    if c["colour"]: ct.SetColor(c["label"], colour(c["colour"]), XCAFDoc_ColorType.XCAFDoc_ColorSurf)

per_group = collections.Counter()
for c in classes:
    for i, R in c["members"]:
        g = info[i][0]
        lab = group_label(g)
        loc = TopLoc_Location(trsf(R, np.array(rows[i]["com"])))
        comp_lab = st.AddComponent(lab, c["label"], loc)
        setname(comp_lab, info[i][1] or c["name"])
        per_group[g] += 1
for g, lab in groups.items():
    st.AddComponent(root, lab, TopLoc_Location())
st.UpdateAssemblies()
print("groups:", dict(per_group), flush=True)

Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
Interface_Static.SetCVal_s("write.step.product.name", "Robot")
w = STEPCAFControl_Writer(); w.SetNameMode(True); w.SetColorMode(True)
w.Transfer(doc, STEPControl_AsIs)
w.Write(OUT)
json.dump([{"part": c["name"], "solid": i, "name": info[i][1], "group": info[i][0], "rotation": [[float(v) for v in row] for row in R], "position": rows[i]["com"]}
           for c in classes for i, R in c["members"]], open(f"{D}/placements.json", "w"))   # where every copy goes (for fixing placements later)
json.dump([{"name": c["name"], "count": len(c["members"]), "colour": c["colour"], "vol": rows[c["rep"]]["vol"],
            "groups": sorted({str(info[i][0]) for i, _ in c["members"]})} for c in classes], open(f"{D}/parts.json", "w"), indent=1)
print(f"wrote {OUT} {time.time()-t0:.0f}s", flush=True)

# The writer leaves some products (parts only used inside a subassembly) with its default "Open CASCADE STEP translator"
# name; rename each one after the instances that use it, so Onshape shows real part names.
import re as _re
txt = open(OUT, encoding="latin-1").read()
ents = {int(m.group(1)): m.start(2) for m in _re.finditer(r"#(\d+)\s*=\s*(PRODUCT|PRODUCT_DEFINITION_FORMATION|PRODUCT_DEFINITION|NEXT_ASSEMBLY_USAGE_OCCURRENCE)\(", txt)}
def body(k):
    s = ents[k]; return txt[s:txt.index(";", s)]
pdf_of = {}; pd_of = {}; uses = collections.defaultdict(list)
for k in ents:
    b = body(k)
    if b.startswith("PRODUCT_DEFINITION_FORMATION("): pdf_of[int(_re.findall(r"#(\d+)", b)[-1])] = k
    elif b.startswith("PRODUCT_DEFINITION("): pd_of[int(_re.findall(r"#(\d+)", b)[0])] = k
    elif b.startswith("NEXT_ASSEMBLY_USAGE_OCCURRENCE("):
        strs = _re.findall(r"'((?:[^']|'')*)'", b); refs = _re.findall(r"#(\d+)", b)
        uses[int(refs[1])].append(strs[1])
fixes = {}
for k in ents:
    b = body(k)
    if b.startswith("PRODUCT('Open CASCADE STEP translator"):
        names = uses.get(pd_of.get(pdf_of.get(k)), [])
        if names: fixes[k] = collections.Counter(names).most_common(1)[0][0]
out = []; last = 0
for k in sorted(fixes, key=lambda k: ents[k]):
    s = ents[k]; e = txt.index(";", s)
    out.append(txt[last:s]); out.append(_re.sub(r"^PRODUCT\('[^']*',\s*'[^']*'", lambda m: "PRODUCT('" + fixes[k] + "','" + fixes[k] + "'", txt[s:e], flags=_re.S)); last = e
out.append(txt[last:])
open(OUT, "w", encoding="latin-1").write("".join(out))
print(f"renamed {len(fixes)} default-named products", flush=True)
