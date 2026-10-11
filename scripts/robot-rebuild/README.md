# Robot: from one STEP import to sketch-based Part Studios

The robot in the team's Onshape document first came in as one STEP import: every part inside one Part Studio, no sketches.
These scripts rebuild the parts we designed as real, editable Part Studios (dimensioned sketches + extrudes/cuts) and swap
them into the Robot assembly at exactly the same place.

1. **Extract** (`extract-parts.mjs <cadSlop part.json> <out folder>`): lifts each designed part's feature chain out of the
   cadSlop robot (`~/cadSlop/test/parts/onshape-part.part.json`) into its own cadForMe part: bodies renumbered, legacy shapes
   turned into dimensioned sketches on a standard plane, "make a tool, subtract it" turned into direct Extrude-cut features.
2. **Plates from geometry** (`plate2part.py <scratch dir> "<part name>" <out.part.json>`, run with the OpenCascade Python from
   `scripts/step-assembly`): for plate-like parts that have no source features (Side plates, shooter mount plate, intake
   motor mount), reads the exact outline and holes from the STEP and writes sketches + extrudes.
3. **Check**: `cadforme drc --project robot` (build + design check), and every part is compared with the original
   solid (volume, centre of mass, inertia within 0.01%).
4. **Push** (`push-parts.mjs robot parts/<file>...`): one native Part Studio per part in the document named in
   `projects/robot/onshape-target.json`. Waits out short rate limits; stops and says so on a long one.
5. **Swap** (`swap-parts.mjs robot projects/robot/.cadforme/source <part file>...`): in the Robot assembly (and its
   subassemblies) replaces each STEP copy with the native part, only when the native part's world bounding box matches the
   original's, then deletes the old instance.

Onshape limits how many Part Studio feature calls an account can make per day. When it runs out, the API answers 429 with
`Retry-After` (about 21 hours): push the rest after that. The swap and every other kind of call keep working meanwhile.
