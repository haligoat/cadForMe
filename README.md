# cadForMe

CAD you drive with words and pictures. Open it from a terminal, look at the model in 3D, and change it by typing what you
want, pointing at photos or sketches in `image-references/`. Every part you make gets a design check (DRC), and parts go to
Onshape as real sketches and extrudes you can double-click and edit there. Built on cadSlop (parametric CAD with git-style
version control).

## Start
```
npm install
ln -s "$PWD/bin/cadforme.mjs" ~/.local/bin/cadforme   # once: the `cadforme` command (or `npm link` if your npm prefix is writable)
cadforme            # opens the window on designs/ (this repo's project)
```
`cadforme open <part>` opens a part, `cadforme --project <folder>` another project. `npm test` runs the tests.

## Change things with text and images
- The **AI** tab: type the change ("make the wall 6 mm and add two M4 holes 20 mm apart"). Claude Code (or a Claude, Gemini or
  OpenAI key) edits the part file and the window rebuilds it.
- **Image references**: drop pictures into `image-references/` (or a project's own `image-references/`). They appear as
  thumbnails; click one or type `@name` to use it. "The reference image" uses all of them. The AI sees the actual pictures.
- The AI models the way you would in Onshape: dimensioned sketches + extrudes, cuts for holes, shapes on the same plane in one
  sketch, and **at most 3-5 variables** per part (only sizes you'd really change). Everything else is a sketch dimension.

## Design check (DRC)
The **DRC** button (top bar), the palette ("Design check"), and every AI edit run it. Per part it checks: build errors, loose
pieces, thin spots (< 1.2 mm), screw holes too tight for M2-M8, printer bed fit (256 mm), variable count, and what can't go to
Onshape natively; assemblies check interference between their parts. The popup shows progress, a time estimate (learned from
earlier runs) and stats (volume, mass, size, surface, features, build time).

Each part's result is saved with a fingerprint of the part, every file it pulls in, and the rules
(`<project>/.cadforme/drc.json`), so **only parts that changed are checked again**. An assembly checks just how its parts fit,
not each part again.

## Onshape
Push sends a part to its linked Part Studio as native features. Boxes and cylinders are turned into a sketch + extrude first
(same geometry; the part file is rewritten to match), a cutter that's subtracted right away becomes a cut, cuts on the same plane
share one sketch, and a sketch offset becomes the extrude's start offset, so there's no construction plane per part. Booleans,
moves/copies, mirrors and body deletes go over as Onshape features too, picking bodies by the features that made them. Edit a
dimension in Onshape and pull to bring it back.

## Imported parts get proper names
Imports are named `<Vendor> <part number> <description>` from the file name and the STEP file's product names:
`gobilda-2106-4008-1040-rex-shaft-104mm.step` -> "goBILDA 2106-4008-1040 REX shaft 104mm". An import someone already named for
its job keeps that: "Transfer shaft 1 - goBILDA 2106-4008-1040 REX shaft 104mm". `cadforme names <part> [--write] [--all]`.

## From the terminal and from Claude
```
cadforme parts | refs
cadforme drc [part...] [--force] [--json]
cadforme names <part> [--write] [--all]
cadforme push <part> [--preview] | pull <part>
cadforme mcp
```
`cadforme mcp` is an MCP server with tools to list/read/write parts, see the image references, run the design check, name
imports, open the window and push/pull Onshape. Claude Code picks it up from `.mcp.json` in this repo; for the Claude desktop
app add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{ "mcpServers": { "cadforme": { "command": "/usr/local/bin/node", "args": ["<repo>/bin/cadforme.mjs", "mcp"] } } }
```
Push and pull use the Onshape keys saved in the app (Onshape button -> Connect), so connect once in the window first.

## Reference (cadSlop)

Parametric CAD for Mac with version control built in (commit, branch, push, pull, merge),
so a team can work on the same designs and an AI can edit them as plain text.

## Run
```
npm install
npm start          # build + launch
npm test           # geometry, merge, and sync tests
npm run package    # release/cadForMe-darwin-*/cadForMe.app
```

## cadForMe folder, File menu, menu-bar app
- Projects live in `~/cadForMe`. The File menu has New Project, Open… (folder or part file), Open Recent and the cadForMe Folder list.
- `cadForMe Menu` is a native Swift menu-bar app (`menubar/CadSlopMenu.swift`, build with `scripts/build-menubar.sh` →
  `release/cadForMe Menu.app`): the cube icon in the Mac menu bar lists every project in `~/cadForMe` and its parts, recent
  projects, Open File or Folder…, and New Project…, and opens them in cadForMe.

## How it works
- **Geometry**: OpenCascade (via replicad, WebAssembly) in a worker. A part is `parts/<name>.part.json`:
  `variables` (numbers/expressions) + an ordered `features` list (sketch, extrude, revolve, fillet,
  chamfer, shell, hole, patterns, mirror, primitives, booleans, transform).
- **Version control** (`src/vcs`): a git-like, content-addressed store in `.cadslop/`. Commits, branches,
  fast-forward and 3-way merge. Part files merge **per variable / feature / field**, so two people editing
  different features never conflict; same-field conflicts open a pick-mine/theirs screen.
- **Team sync**: a GitHub repo (via a token kept in the macOS Keychain) or a shared folder is the remote.
  Push uses compare-and-swap, so you can't overwrite a teammate's push: pull first.
- **AI**: because parts are readable JSON (one feature per line), tell any AI to edit the file; the app reloads live.

## Onshape + AI ("vibe CAD")
- **AI providers**: pick Claude Code (installed CLI), a Claude API key (default model `claude-opus-5-5`), a Google Gemini key,
  or an OpenAI key in the AI tab; the model name is editable. Keys are stored per person in the macOS Keychain and are never
  written into the project or pushed, so every teammate uses their own. API providers return the updated part file, which is
  validated before it's written (Onshape link fields are protected). The Version control tab has an **✨ AI** button that writes
  the commit message from the CAD diff.
- **AI tab**: type an instruction ("make the base 10 mm thicker, add a 6 mm hole in the centre"). cadForMe runs your
  Claude Code CLI (Read/Edit/Write/Glob/Grep only, no shell or web) on the open part file, rebuilds, and if the model has
  errors asks the AI to fix them (up to 2 tries). Then it can commit and send the result to Onshape. ⌘Z undoes the AI edit.
  Needs Claude Code installed and signed in (`claude` once in a terminal).
- **Onshape button**: connect API keys (stored in the macOS Keychain), import a Part Studio into a part file, send a part to a
  new Onshape document (or an empty Part Studio), pull and push.
- Onshape acts like a remote: the last-synced state is stored in `onshape/<part>.base.json` in the repo. Pull is a CAD-aware
  3-way merge (conflicts open the Mine/Theirs screen); push is refused if Onshape changed since your last sync ("pull first").
- Mapped both ways: variables (as Onshape length/angle variables), offset construction planes, constrained sketches on the
  Top/Front/Right planes or on construction planes (geometry, constraints, dimensions; X/Y position dimensions become Fix),
  extrudes (holes stay holes), fillets, chamfers and shells. Sketch angle dimensions stay in cadForMe (Onshape's API rejects
  them; the geometry is sent at that angle). Other Onshape features are imported as read-only placeholders and never modified;
  cadForMe-only features (hole, patterns...) stay local for now.
- After a push, each Onshape part is named after the cadForMe feature that made it (unless someone renamed it in Onshape).
- **Build Onshape assembly** (Onshape dialog): puts every part of the linked Part Studio into an Assembly tab where it sits in the
  Part Studio, so the assembly and its BOM always match the design. Re-running refreshes the same tab.
- **Add STEP to assembly…** (Onshape dialog): uploads a STEP file (a teammate's robot, vendor CAD) into the linked document, Onshape
  translates it keeping sub-assemblies, and it's inserted into the assembly 700 mm to the side of the design.
- Sketch editing: the model goes see-through while you sketch, and dimension labels that would overlap are hidden (zoom in, or edit them in the list).
- Onshape's document units can't be set through its API: set Document → Workspace units → Millimeter once in Onshape.

## Feature list
- **Sketch**: start by clicking a plane or a part face (Onshape-style). Lines, corner/centre rectangles, circles, 3-point and centre
  arcs, ellipses, polygons, slots, points, construction geometry; trim, sketch fillet, mirror (symmetric constraints), offset;
  constraints (coincident, horizontal, vertical, parallel, perpendicular, equal, tangent, midpoint, concentric, fix, symmetric) and
  smart dimensions driven by variables; DXF import/export.
- **Part features**: extrude (draft, twist, regions, through all), revolve, sweep, loft, fillet, chamfer, shell, hole (simple /
  counterbore / countersink, standard metric sizes), split, construction planes (offset, 3-point, point+normal, midplane, angle),
  linear (1D/2D) and circular patterns, mirror, box/cylinder/sphere, spur gear, coil/spring, boolean, move/rotate/scale, delete body,
  STEP import, Insert part (assemblies with per-instance variable overrides).
- **Part studio tools**: variables + configurations, materials with mass and centre of mass, measure, section view, part colours,
  show/hide, rollback, suppress, duplicate, right-click menus, view cube, drawings (SVG: front/top/right/iso with dimensions),
  STL/STEP export, standard parts library (ISO screws, nuts, washers, bearings, gears).

## Onshape-style workflow
Sketch starts by picking a plane or any flat face (or a row under Origin & planes). Finished sketches stay visible with shaded
regions; Extrude/Revolve can use all regions or just the ones you click. Parts list with show/hide, a view cube, Import (STEP files are
copied into `imports/` and versioned with the project).

## Sketching (Onshape style)
Points, lines, circles and arcs with a real constraint solver (FreeCAD's PlaneGCS). Tools: line, corner/centre
rectangle, circle, 3-point and centre arc, polygon, slot, point, construction toggle. Constraints: coincident,
horizontal, vertical, parallel, perpendicular, equal, tangent, midpoint, concentric, fix. Smart dimensions (length,
distance, horizontal/vertical, radius, diameter, angle) accept variables and expressions. Drag shapes with the
solver live; the sketch shows "N DOF left" / "Fully defined" / "Over-constrained". Shortcuts: L R C A P D X S, H V E T.
Sketches are stored as `geom` + `cons`; older shape-based sketches (`entities`) still work.

Not in v1: assemblies, drawings, sheet metal, sketch trim/offset/fillet/mirror, regions that split where shapes cross, countersink holes.
