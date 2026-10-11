# cadSlop part format (.part.json)

A part is one JSON file in `parts/`. cadSlop watches it and rebuilds the 3D model live, so editing this file
(by hand or with an AI) is the way to change a design. Keep one feature per line (cadSlop writes it that way).

```json
{
  "name": "Bracket",
  "variables": { "width": 60, "thickness": 6 },
  "features": [ { "id": "sk1", "type": "sketch", ... }, { "id": "ex1", "type": "extrude", "sketch": "sk1", "distance": "thickness" } ]
}
```

## Modelling style (keeps parts short and easy to edit, here and in Onshape)
- Build solids from fully dimensioned sketches + `extrude` / `revolve`. Holes and pockets are extrudes with `"mode": "cut"`.
  Avoid `box`, `cylinder`, `boolean` and `transform` where a sketch can do it.
- Few variables: at most 3-5 per part, only for sizes someone would actually change (wall thickness, hole size, length).
  Every other size goes straight into a sketch dimension.
- Shapes that share a plane and depth go in one sketch (one cut for four holes, not four).
- From reference images: match the shape and proportions, use dimensions written on them, and say which sizes you assumed.

## Values and units
Any numeric field accepts a number or an expression string: `"width/2 + 3"`, `"0.25 in"`, `"sin(30)*r"`, `"2 * (a + 1)"`.
Lengths are **millimetres**, angles **degrees**. Variables may reference each other (no cycles).
Operators `+ - * / % ^`, functions `sin cos tan asin acos atan atan2 sqrt abs min max pow floor ceil round log exp`,
constants `PI`. Unit suffixes after a number: `mm cm m in ft deg rad`.

## Rules
- Every feature has a unique `id` (letters/digits) and a `type`. Optional: `name`, `suppressed: true`.
- Features run top to bottom. A sketch must come **before** the feature that uses it.
- If a feature is invalid its error appears in the app and later features still run. Never invent feature types.
- Keep ids stable when editing; add new features with new unique ids. Do not touch `osId` fields or the `onshape` key
  (they link the part to an Onshape document).

## Sketch (constraint based)
```json
{ "id": "sk1", "type": "sketch", "plane": "XY", "offset": 0, "geom": [ ... ], "cons": [ ... ] }
```
`plane`: `"XY"` (top, normal +Z), `"XZ"` (front, normal -Y), `"YZ"` (right, normal +X); or a custom frame
`{ "origin": [x,y,z], "normal": [x,y,z], "xDir": [x,y,z] }` (used for sketching on a face). `offset` moves it along its normal.
Sketch coordinates are 2D (x, y) in that plane, in mm.

**geom** items (ids must be unique across geom and cons):
- `{ "id": "p1", "t": "point", "x": 0, "y": 0 }`
- `{ "id": "l1", "t": "line", "a": "p1", "b": "p2" }`  (a, b are point ids; shared point id = joined corner)
- `{ "id": "c1", "t": "circle", "c": "p5", "r": 10 }`  (c = centre point id)
- `{ "id": "a1", "t": "arc", "c": "p6", "s": "p7", "e": "p8" }`  (counter-clockwise from point s to point e around c)
- `{ "id": "e1", "t": "ellipse", "c": "p1", "f": "p2", "r": 8 }` (c = centre point, f = a focus point on the long axis, r = short radius)
- add `"construction": true` to a line/circle/arc to make it a reference (not part of the profile).

A **closed loop** of lines/arcs sharing points, or a circle, becomes a face. A loop inside another loop is a hole.
Positions are solved from the constraints when the part is built; give approximate positions and add constraints/dimensions.

**cons** items: `{ "id": "k1", "t": TYPE, "a": id, "b": id }`
- `horizontal` / `vertical`: a = line (or a,b = two points)
- `parallel`, `perpendicular`: a, b = lines;  `equal`: a, b = two lines, or two circles/arcs (equal radius)
- `tangent`: a, b = line/circle/arc pair;  `concentric`: a, b = circles/arcs
- `midpoint`: a = point, b = line;  `on`: a = point lying on b (line/circle/arc);  `fix`: a = point (locks it)
- `coincident`: a, b = two points;  `symmetric`: a, b = two points mirrored across line `l`
- Dimensions: `{ "id": "d1", "t": "dim", "k": KIND, "a": id, "b": id, "v": value-or-expression }`
  - `length` (a = line), `dist` (a, b = points), `hdist` / `vdist` (a, b = points, b is right of / above a),
    `pdist` (a = point, b = line), `radius` / `diameter` (a = circle/arc), `angle` (a, b = lines, degrees),
    `x` / `y` (a = point, coordinate from the sketch origin).
  Use variables in `v` (e.g. `"v": "width"`) to make a design parametric.

Example, a fully dimensioned 40 x 20 rectangle:
```
{"id":"sk1","type":"sketch","plane":"XY","geom":[{"id":"p1","t":"point","x":0,"y":0},{"id":"p2","t":"point","x":40,"y":0},{"id":"p3","t":"point","x":40,"y":20},{"id":"p4","t":"point","x":0,"y":20},{"id":"l1","t":"line","a":"p1","b":"p2"},{"id":"l2","t":"line","a":"p2","b":"p3"},{"id":"l3","t":"line","a":"p3","b":"p4"},{"id":"l4","t":"line","a":"p4","b":"p1"}],"cons":[{"id":"k1","t":"horizontal","a":"l1"},{"id":"k2","t":"vertical","a":"l2"},{"id":"k3","t":"horizontal","a":"l3"},{"id":"k4","t":"vertical","a":"l4"},{"id":"k5","t":"fix","a":"p1"},{"id":"d1","t":"dim","k":"length","a":"l1","v":"width"},{"id":"d2","t":"dim","k":"length","a":"l2","v":20}]}
```
(Sketches may also hold `"entities"`: shapes `rect, circle, ellipse, polygon, slot, polyline`, and `spline` = a smooth closed curve through `points` [[x,y],...] for organic profiles.)

## Planes, configurations, material
- `plane` feature (construction plane): `mode` `offset` (`from`, `distance`), `threePoint` (`pts`: three [x,y,z]), `pointNormal` (`origin`, `normal`),
  `midplane` (`a`, `b`), `angle` (`from`, `axis`, `point`, `angle`). A sketch's `plane` may be a plane feature's id (placed before the sketch).
- Part-level `configs`: `{ "Large": { "width": 80 } }` override variables when `config` is `"Large"`. `material`: `{ "name": "Steel", "density": 7.85 }` (g/cm³).

## 3D features
Common: `mode` is `"new"` (new body), `"add"` (merge), `"cut"` (remove), `"intersect"`. Body numbers are 0-based; `"all"` = every body.
- `extrude`: `sketch` (id), `distance`, `mode`, optional `flip`, `symmetric`, `through` (all the way through), `draft` (taper degrees, single outline only), `twist` (degrees), `regions` (list of [x,y] sketch points to pick regions)
- `loft`: `sketches` (ids in order), `ruled`, `mode`;  `sweep`: `profile` (sketch id), `path` (sketch id, one open or closed chain of lines/arcs), `mode`
- `split`: `body`, `origin`, `normal`, `keep` (`both`|`above`|`below`)
- `revolve`: `sketch`, `axis` (`"X"` or `"Y"` of the sketch), `angle` (default 360), `mode`
- `fillet` / `chamfer`: `radius`, `edges`: `[{"p":[x,y,z]}]`, each p a point lying exactly on an edge (use the edge midpoint)
- `shell`: `thickness`, `faces`: `[{"p":[x,y,z],"n":[nx,ny,nz]}]` faces to remove (point on face + outward normal)
- `hole`: `position` [x,y,z] on the surface, `normal` outward direction, `diameter`, `through` or `depth`,
  optional `style: "counterbore"` with `cboreDiameter`, `cboreDepth`, or `"countersink"` with `csinkDiameter`, `csinkAngle`
- `linearPattern`: `body`, `direction` [x,y,z], `distance`, `count`, optional second direction (`direction2`, `distance2`, `count2` rows), `merge` (default true)
- `circularPattern`: `body`, `axis` [x,y,z], `origin` [x,y,z], `count`, `angle` (360), `merge`
- `mirror`: `body`, `normal` [x,y,z], `origin` [x,y,z], `merge`
- `gear`: `module`, `teeth` (≥6), `thickness`, `bore`, `pressure` (20), `position`, `mode` (spur gear with involute teeth, centred on the Z axis);  `coil`: `radius`, `pitch`, `height`, `wire` (diameter), `position`, `mode`
- `box`: `position` (centre of base), `w` (x), `d` (y), `h` (z), `mode`;  `cylinder`: `position`, `direction`, `r`, `h`, `mode`;  `sphere`: `position`, `r`, `mode`
- `transform`: `body`, `translate` [x,y,z], `rotate` (deg), `scale`, `axis`, `origin`, `copy`
- `boolean`: `a`, `b` (body numbers), `op`: `union | subtract | intersect` (the result replaces body `a`; body `b` is used up);  `deleteBody`: `body`
- `insert`: put another part of the project into this one (assemblies): `part` (path like `parts/wheel.part.json`), `vars` (variable overrides for this copy, e.g. {"radius": 40}), `position`, `rotate`, `axis`, `origin`, `scale`, `mode` (default new). Repeat the feature (or use patterns) for several copies.
- `import`: `file` (path of a STEP file inside the project, e.g. `imports/part.step`), `scale`, `position` [x,y,z], `mode`; `anchor` [x,y,z] (the point of the file that lands on `position`) and `orient` [x,y,z] degrees (about X, then Y, then Z, about the anchor) place a part exactly; `split: true` makes one body per solid in the file (so single parts of an imported assembly can be cut, mirrored, coloured)
- `onshape`: a feature that exists only in Onshape; keep it exactly as is.

Sketches, construction planes, extrudes, fillets, chamfers, shells and variables are mirrored to Onshape when the part is linked
(keep edge/face picks, the `p` points, accurate). Booleans, transforms (moves and copies), mirrors and body deletes are sent too;
boxes and cylinders are turned into sketch + extrude when a part is pushed.
