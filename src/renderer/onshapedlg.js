// Onshape integration UI: connect keys, import a Part Studio, pull / push / preview, send to a new document.
import { h, icon, modal, toast } from "./ui.js";
import { S, emit, setProject, reloadAfterVcsChange, saveNow, loadPart, refreshParts, modelStepBytes } from "./state.js";
import { resolveConflicts, promptText, confirmBox } from "./dialogs.js";

const call = (ch, ...a) => window.cad.invoke(`onshape:${ch}`, ...a);
export const onshapeStatus = () => call("status");
export const onshapeInfo = (rel) => call("info", rel);

/** Pull Onshape's changes into the part (merging; asks about conflicts). Returns the result. */
export async function pullOnshape(rel) {
  await saveNow();
  let res = await call("pull", rel, undefined);
  while (res.status === "conflicts") {
    const choice = await resolveConflicts(res.conflicts, "Onshape's");
    if (!choice) { toast("Pull cancelled. Nothing was changed"); return { status: "cancelled" }; }
    res = await call("pull", rel, choice);
  }
  if (res.status === "merged") { await reloadAfterVcsChange(); toast(`Pulled changes from Onshape${res.warnings?.length ? ` (${res.warnings.length} features kept as-is)` : ""}`, "ok"); }
  else if (res.status === "up-to-date") toast("Already up to date with Onshape");
  return res;
}

/** Push the part to Onshape. If it isn't linked yet, asks where to send it. If Onshape moved on, pulls first. */
export async function sendToOnshape(rel, { askLink = true } = {}) {
  await saveNow();
  const info = await onshapeInfo(rel);
  let linkArgs = {};
  if (!info.linked) {
    if (!askLink) throw new Error("This part isn't linked to Onshape yet");
    const target = await chooseTarget();
    if (!target) return { status: "cancelled" };
    linkArgs = target;
  }
  let res;
  try { res = await call("send", { rel, ...linkArgs }); }
  catch (e) {
    if (!/Pull first/.test(e.message)) throw e;
    const p = await pullOnshape(rel);
    if (p.status === "cancelled") return p;
    res = await call("send", { rel, ...linkArgs });
  }
  await reloadAfterVcsChange();
  if (res.status === "up-to-date") toast("Onshape already has this version");
  else if (res.status === "nothing-sent") {
    // The features can't be sent, but the finished model can: offer to upload it as a STEP file into the document you linked.
    const ok = await confirmBox("Send the 3D model instead?", `${res.skipped} feature${res.skipped === 1 ? "" : "s"} here (imported STEP models, cut channels, boxes…) can't be sent to Onshape as editable features. cadForMe can send the 3D model of what you added as a STEP file instead (the big imported model stays out; Onshape already has it). Onshape adds it as a new Part Studio tab in the document you linked and touches nothing else. It can't be edited as features there, and cadForMe won't sync it back.`, "Send as STEP");
    if (!ok) { toast("Nothing was sent", "err"); return { ...res, status: "cancelled" }; }
    const asm = await confirmBox("Also make an Assembly?", "Besides the Part Studio tab, cadForMe can add an Assembly tab to the same document with all of those parts in it, each fixed where it sits (so the Assembly and its BOM match the model). Onshape adds new tabs only; nothing existing is changed.", "Add an Assembly too");
    toast("Exporting the model and uploading it. This can take a few minutes…");
    const m = await modelStepBytes();
    const up = await call("uploadModel", { rel, bytes: m.bytes, name: `${S.part?.name ?? "part"} (${m.count} added parts)`, assembly: !!asm });
    toast(`Uploaded ${m.count} parts to Onshape: ${up.tabs.join(", ") || "done"}`, "ok");
    return { ...res, status: "uploaded", uploaded: up };
  }
  else toast(`Sent to Onshape (${res.applied} change${res.applied === 1 ? "" : "s"})${res.skipped ? `. ${res.skipped} other feature${res.skipped === 1 ? " stayed" : "s stayed"} in cadForMe (can't be sent yet)` : ""}`, "ok");
  return res;
}

function chooseTarget() {
  const url = h("input", { class: "in", placeholder: "https://cad.onshape.com/documents/…/w/…/e/…" });
  return modal({
    title: "Send to Onshape",
    body: h("div", {}, h("div", { class: "note", style: { marginBottom: "10px" } }, "Paste the link of an empty Part Studio tab in your Onshape document. cadForMe only writes into that tab; it never creates documents."),
      h("div", { class: "field full" }, h("label", {}, "Part Studio link"), url)),
    actions: [{ label: "Cancel" }, { label: "Send", primary: true, run: () => { if (!url.value.trim()) { toast("Paste the Part Studio link first", "err"); return false; } return { url: url.value.trim() }; } }],
  });
}

export async function openOnshapeDialog() {
  let status = await onshapeStatus();
  let info = S.partPath ? await onshapeInfo(S.partPath) : { linked: false };
  const body = h("div");
  const log = h("div", { class: "diffitems", style: { margin: "10px 0 0", maxHeight: "170px", overflow: "auto" } });
  let closeFn = null;
  const draft = { ak: "", sk: "", bu: "" }; // keep what was typed if connecting fails
  const say = (lines) => log.replaceChildren(...[].concat(lines).map((l) => h("div", {}, l)));
  const run = async (label, fn) => { say(`${label}…`); try { await fn(); } catch (e) { const m = String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); say(`Error: ${m}`); toast(m, "err"); } info = S.partPath ? await onshapeInfo(S.partPath) : { linked: false }; draw(); };

  function draw() {
    const kids = [];
    if (!status.hasKeys) {
      const keep = (k) => (e) => { draft[k] = e.target.value; };
      const ak = h("input", { class: "in", placeholder: "Access key", value: draft.ak, oninput: keep("ak"), onkeydown: (e) => e.stopPropagation() }), sk = h("input", { class: "in", type: "password", placeholder: "Secret key (shown once when you create the key)", value: draft.sk, oninput: keep("sk"), onkeydown: (e) => e.stopPropagation() }), bu = h("input", { class: "in", placeholder: "https://cad.onshape.com", value: draft.bu, oninput: keep("bu"), onkeydown: (e) => e.stopPropagation() });
      kids.push(h("div", { class: "note", style: { marginBottom: "10px" } }, "Create API keys at ", h("b", {}, "dev-portal.onshape.com → API keys"), " (allow read and write). They're stored in your Mac's Keychain."),
        h("div", { class: "field full" }, h("label", {}, "Access key"), ak), h("div", { class: "field full" }, h("label", {}, "Secret key"), sk), h("div", { class: "field full" }, h("label", {}, "Onshape address (enterprise only)"), bu),
        h("button", { class: "btn primary", onclick: () => run("Checking keys", async () => { const r = await call("setKeys", { accessKey: ak.value, secretKey: sk.value, baseUrl: bu.value }); status = await onshapeStatus(); say(`Connected${r.user ? ` as ${r.user}` : ""}`); }) }, icon("cloud"), "Connect"));
    } else {
      if (S.partPath) {
        kids.push(h("div", { class: "section", style: { margin: "0 -20px" } }, h("header", {}, `This Part Studio · ${S.part?.name ?? S.partPath.replace("parts/", "").replace(".part.json", "")}`),
          h("div", { class: "body", style: { padding: "0 20px 12px" } },
            info.linked ? h("div", {}, h("div", { class: "note", style: { marginBottom: "8px" } }, "Linked to Onshape. ", h("a", { href: "#", style: { color: "var(--accent)" }, onclick: (e) => { e.preventDefault(); call("open", info.url); } }, "Open in Onshape")),
              h("div", { class: "syncbar" },
                h("button", { class: "btn", onclick: () => run("Previewing", async () => { const r = await call("preview", S.partPath); say(r.ops.length ? [...(r.converted ?? []), ...r.ops.map((o) => `${o.skipped ? "(skipped) " : ""}${o.label}`), ...r.warnings] : ["Nothing to send: Onshape matches this part"]); }) }, "Preview push"),
                h("button", { class: "btn primary", onclick: () => run("Pushing", async () => { const r = await sendToOnshape(S.partPath); say(r.status === "uploaded" ? [`Uploaded the 3D model as a STEP file: ${r.uploaded.tabs.join(", ")}`] : r.status === "nothing-sent" ? [`Nothing was sent: ${r.skipped} feature(s) can't go to Onshape yet.`, ...(r.warnings ?? [])] : r.status === "cancelled" ? "Cancelled" : r.status === "pushed" ? [`Pushed ${r.applied} change(s)`, ...(r.errors ?? []), ...(r.warnings ?? [])] : "Up to date"); }) }, icon("push"), "Push to Onshape"),
                h("button", { class: "btn", onclick: () => run("Pulling", async () => { const r = await pullOnshape(S.partPath); say(r.status === "merged" ? `Merged. ${(r.warnings ?? []).join(" ")}` : r.status); }) }, icon("pull"), "Pull from Onshape"),
                h("button", { class: "btn", title: "Put every part of the linked Part Studio into an Onshape Assembly tab (fixed where it is), so it gets a BOM", onclick: () => run("Building assembly", async () => { const r = await call("assembly", S.partPath); say(`Assembly "${r.name}" has ${r.instances} part(s)`); }) }, icon("cloud"), "Build Onshape assembly"),
                h("button", { class: "btn", title: "Upload a STEP file (e.g. a teammate's robot or a vendor part) into this Onshape document and put it in the assembly, beside the design", onclick: () => run("Adding STEP (Onshape translates it; big files take a minute)", async () => { const r = await call("addStep", S.partPath); if (r.status === "added") say([`Added ${r.name}: ${r.instances} instance(s) in the assembly`, `New tabs: ${r.tabs.join(", ")}`]); }) }, icon("download"), "Add STEP to assembly…")))
              : h("div", {}, h("div", { class: "note", style: { marginBottom: "8px" } }, "Not linked to Onshape yet."), h("button", { class: "btn primary", onclick: () => run("Sending", async () => { const r = await sendToOnshape(S.partPath); if (r.status === "pushed") say([`Sent ${r.applied} change(s)`, ...(r.errors ?? []), ...(r.warnings ?? [])]); }) }, icon("push"), "Send to Onshape…")))));
      }
      const url = h("input", { class: "in", placeholder: "https://cad.onshape.com/documents/…/w/…/e/…" });
      kids.push(h("div", { class: "section", style: { margin: "0 -20px" } }, h("header", {}, "Import from Onshape"),
        h("div", { class: "body", style: { padding: "0 20px 12px" } }, h("div", { class: "note", style: { marginBottom: "6px" } }, "Paste the address of an Onshape tab: a Part Studio comes in editable, an Assembly comes in as a 3D model."), h("div", { class: "field full" }, url),
          h("button", { class: "btn", onclick: () => run("Importing", async () => {
            const name = await promptText("Name the part", "Part name", "onshape-part", "Import"); if (!name) return;
            const r = await call("import", { url: url.value.trim(), name });
            await refreshParts(); await loadPart(r.rel); say([`Imported into ${r.rel.replace("parts/", "").replace(".part.json", "")}`, ...r.warnings]);
          }) }, icon("download"), "Import into this project"))));
      kids.push(h("button", { class: "btn sm ghost danger", onclick: () => run("Disconnecting", async () => { await call("setKeys", null); status = await onshapeStatus(); say("Keys removed"); }) }, "Disconnect Onshape keys"));
    }
    kids.push(log);
    body.replaceChildren(...kids);
  }
  draw();
  modal({ title: "Onshape", wide: true, body, actions: [{ label: "Close" }] });
}
