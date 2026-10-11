import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initKernel } from "./helpers.mjs";
import { initSolver } from "../src/kernel/sketch2.js";
import { buildPart } from "../src/kernel/geometry.js";
import { runDrc } from "../src/kernel/drc.js";
import { importName, conventionalName } from "../src/kernel/stepnames.js";
import { designCheck } from "../src/cli/core.js";
import { formatPart } from "../src/kernel/format.js";

before(async () => { await initKernel(); await initSolver(fs.readFileSync(new URL("../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url))); });

const plate = (extra = [], variables = { t: 5 }) => ({ name: "Plate", variables, features: [
  { id: "a", type: "box", name: "Plate", position: [0, 0, 0], w: 60, d: 40, h: "t" },
  ...extra,
] });
const check = (part) => runDrc(part, buildPart(part));
const byLabel = (r, l) => r.checks.find((c) => c.label === l);

test("a clean part passes every check and reports its stats", () => {
  const r = check(plate([{ id: "h", type: "cylinder", name: "M4 hole", position: [10, 0, -1], r: 2.25, h: 7, mode: "cut" }]));
  assert.equal(r.status, "pass", JSON.stringify(r.checks.filter((c) => c.status !== "pass")));
  assert.equal(r.stats.bodies, 1); assert.deepEqual(r.stats.size.map(Math.round), [60, 40, 5]);
  assert.ok(Math.abs(r.stats.volume - (60 * 40 * 5 - Math.PI * 2.25 ** 2 * 5)) < 1);
});

test("loose pieces, thin spots, tight screw holes, oversize parts and too many variables are flagged", () => {
  const r = check({ name: "Bad", variables: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, features: [
    { id: "a", type: "box", position: [0, 0, 0], w: 300, d: 40, h: 5 },
    { id: "b", type: "box", position: [0, 100, 0], w: 10, d: 10, h: 0.8, mode: "new" },
    { id: "h", type: "cylinder", name: "Screw hole", position: [10, 0, -1], r: 2, h: 7, mode: "cut" },
  ] });
  assert.equal(byLabel(r, "Pieces").status, "warn");
  assert.equal(byLabel(r, "Thin spots").status, "warn");
  assert.match(byLabel(r, "Holes").items[0], /tight for M4/);
  assert.equal(byLabel(r, "Printer bed").status, "warn");
  assert.equal(byLabel(r, "Variables").status, "warn");
});

test("pieces that only touched before a cut separated them count as separate", () => {
  const r = check({ variables: {}, features: [
    { id: "a", type: "box", position: [0, 0, 0], w: 10, d: 10, h: 10 },
    { id: "b", type: "box", position: [0, 0, 10], w: 10, d: 10, h: 10 },
    { id: "u", type: "boolean", a: 0, b: 1, op: "union" },
    { id: "c", type: "box", position: [0, 0, 9], w: 20, d: 20, h: 2, mode: "cut" },
  ] });
  assert.equal(byLabel(r, "Pieces").status, "warn");
});

test("the design check reuses results for unchanged parts and redoes only the edited one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadforme-drc-"));
  fs.mkdirSync(path.join(dir, "parts"));
  fs.writeFileSync(path.join(dir, "parts/a.part.json"), formatPart(plate()));
  fs.writeFileSync(path.join(dir, "parts/b.part.json"), formatPart({ ...plate(), name: "B" }));
  const events = [];
  let r = await designCheck(dir, ["parts/a.part.json", "parts/b.part.json"], { onEvent: (e) => events.push(e) });
  assert.deepEqual(r.map((x) => x.skipped), [false, false]);
  assert.ok(events.some((e) => e.type === "plan" && e.estimate > 0) && events.some((e) => e.type === "step"));
  fs.writeFileSync(path.join(dir, "parts/b.part.json"), formatPart({ ...plate([], { t: 6 }), name: "B" }));
  r = await designCheck(dir, ["parts/a.part.json", "parts/b.part.json"]);
  assert.deepEqual(r.map((x) => x.skipped), [true, false]);
  assert.equal(r[1].stats.size[2], 6);
});

test("imports get vendor + part number + description names, keeping a role someone gave them", () => {
  assert.equal(importName("imports/gobilda-2106-4008-1040-rex-shaft-104mm.step"), "goBILDA 2106-4008-1040 REX shaft 104mm");
  assert.equal(importName("imports/Swyft_Servo_SR-Servo-01.step"), "Swyft SR-Servo-01 servo");
  assert.equal(importName("imports/thing.step", "PRODUCT('Configuration 4','SR-CHANNEL-L48-17 v1','',(#1));"), "Swyft SR-CHANNEL-L48-17 thing");
  const std = importName("imports/gobilda-2106-4008-1040-rex-shaft-104mm.step");
  assert.equal(conventionalName({ id: "i1", file: "imports/gobilda-2106-4008-1040-rex-shaft-104mm.step", name: "Transfer shaft 1 (goBILDA 2106-4008-1040)" }, std), `Transfer shaft 1 - ${std}`);
  assert.equal(conventionalName({ id: "i1", file: "imports/x.step", name: "x.step" }, std), std);
});
