# Onshape API calls: where they go and how to spend fewer

The Onshape account has a hard limit of about 2,500 API calls (check with Onshape whether that is per month or per year).
Every rule here exists to keep work far below it. Agents follow "Rules" today; "Planned" is work not built yet.

## Where the calls go today
Native push of one part (`src/onshape/sync.js`, `pushToOnshape`):

| Step | Calls |
|---|---|
| Preview (`onshape_push` with `preview: true`) | 1 feature read |
| Real push: fresh read to catch Onshape edits | 1 |
| Each added, changed or deleted feature or variable | 1 each |
| Naming new parts (`nameOnshapeParts`) | 1 FeatureScript + 1 read per new solid + 1 write per renamed solid |
| Final read to save `onshape/<part>.base.json` | 1 |
| New Part Studio (create + link) | +2 |

A new part with 15 features and 3 solids costs about 25 calls. Other costs:
- `pushAssembly`: element list, up to 3 probes for an empty assembly tab, reads before and after, 1 delete per old instance, insert, fix.
- STEP upload: 1 upload + translation polling (back-off 2 s to 15 s, about 5-10 calls) + element list. Cheapest per part, but no feature history.
- Retries: a failed read can be sent up to 9 times (3 in `counted()` around 3 in `rawReq()`); every attempt is a call.

## What the counter can't be trusted for
`.cadforme/api-usage.json` is a single per-day total, so:
- It **undercounts** when several processes (parallel subagents) run at once: each reads, adds 1 and writes back, so increments get lost.
- It **misses** every direct `mcp__onshape__*` tool call (extrude, measure, shaded view...). Those bypass cadForMe, and that server re-reads the feature list after each feature write, so each costs at least 2 calls.
- It **counts retries** as calls (which Onshape probably does too) but can't show them separately.
- It resets each day and has no breakdown by operation. Use Onshape's own usage figure as the truth when the two disagree.

## Rules (now)
1. **Only `cad-onshape` talks to Onshape, and only through cadForMe tools** (`onshape_push`, `onshape_pull`, `onshape_import`, `release`, `onshape_upload_step`, or the CLI). Never use the `mcp__onshape__*` tools for building or checking geometry: they are uncounted and cost double. The one exception is `onshape_create_version` before restructuring a document.
2. **Iterate locally, push once.** The 3D window, `design_check` and the checking scripts cost nothing. Push a part only when it is finished and the user wants it in Onshape.
3. **Estimate offline, tell the user, wait for the go-ahead** (table above; `planPush` against the saved base gives the operation count). Report the counter before and after.
4. **One part at a time, stop at the first error.** Diagnose with at most 2 calls per part (see `.claude/agents/cad-onshape.md`). Save raw responses before parsing them.
5. **Pick the cheapest route for the job:**
   - Geometry nobody edits in Onshape (vendor parts, finished plates for fab, a whole robot for a viewer): STEP upload, about 10 calls for everything.
   - Parts teammates edit in Onshape: native push, but with fewer, richer features (one sketch per plane and depth, one pattern or mirror instead of copies).
6. **Don't retry** a 402, or a 429 with a long Retry-After. Stop and tell the user.
7. **Don't re-read** what a previous call already returned, and don't poll.

## Planned (in this order; steps 1-2 need no Onshape calls to build or test)
1. **Accurate log.** Replace the counter with one appended line per real request: time, method, kind of call, project/part, status, whether it was a retry. Appending loses nothing under parallel runs and gives the per-operation breakdown. Cap retries at one per request.
2. **Hard budget in code.** Every push prints its estimate; past a daily cap (e.g. 300) Onshape writes are refused unless `CADFORME_BUDGET_OVERRIDE=1`.
3. **Offline preview.** Plan the push from `onshape/<part>.base.json` with no read.
4. **No read after a push.** Build the new base from the write responses (each returns the stored feature and the microversion).
5. **No read before a push.** Send the base microversion with the first write so Onshape refuses it if the document changed since (`rejectMicroversionSkew`; field name to verify). A refusal means "pull first".
6. **Part names in one call.** The FeatureScript that finds the new solids also returns their current names, so only the renames are writes.
7. **Code push (biggest saving, needs a test with the user's OK, about 5-10 calls).** Push each part as one custom FeatureScript feature, with all parts' code in one shared Feature Studio tab. A changed part costs about 2 calls (update the Feature Studio, add or update the feature) instead of about 25. Part variables become the feature's parameters, so sizes stay editable in Onshape without the API; the feature names its own parts. Trade-off: in Onshape the part has one feature, not editable sketches. Native push stays for parts that need Onshape history.
8. **Assembly tabs:** probe for an empty tab only the first time; afterwards use the remembered `onshape.asm`.
