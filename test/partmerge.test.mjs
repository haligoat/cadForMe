import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeParts, diffPart } from "../src/vcs/partmerge.js";
import { formatPart, parsePart } from "../src/kernel/format.js";

const base = { variables: { w: 40, t: 5 }, features: [
  { id: "a", type: "extrude", distance: 10 }, { id: "b", type: "fillet", radius: 2 },
] };
const clone = (x) => JSON.parse(JSON.stringify(x));

test("different features merge cleanly", () => {
  const ours = clone(base); ours.features[0].distance = 20;
  const theirs = clone(base); theirs.features[1].radius = 3; theirs.variables.w = 50;
  const { merged, conflicts } = mergeParts(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.features[0].distance, 20);
  assert.equal(merged.features[1].radius, 3);
  assert.equal(merged.variables.w, 50);
});

test("different fields of one feature merge", () => {
  const ours = clone(base); ours.features[0].distance = 20;
  const theirs = clone(base); theirs.features[0].symmetric = true;
  const { merged, conflicts } = mergeParts(base, ours, theirs);
  assert.equal(conflicts.length, 0);
  assert.deepEqual([merged.features[0].distance, merged.features[0].symmetric], [20, true]);
});

test("same field edited differently conflicts and resolves", () => {
  const ours = clone(base); ours.variables.w = 60;
  const theirs = clone(base); theirs.variables.w = 70;
  const r = mergeParts(base, ours, theirs);
  assert.equal(r.conflicts[0].key, "variable:w");
  assert.equal(mergeParts(base, ours, theirs, { "variable:w": "theirs" }).merged.variables.w, 70);
  assert.equal(mergeParts(base, ours, theirs, { "variable:w": "ours" }).merged.variables.w, 60);
});

test("adds on both sides, delete vs edit", () => {
  const ours = clone(base); ours.features.push({ id: "c", type: "hole" });
  const theirs = clone(base); theirs.features.push({ id: "d", type: "shell" });
  const r = mergeParts(base, ours, theirs);
  assert.deepEqual(r.merged.features.map((f) => f.id), ["a", "b", "c", "d"]);
  const o2 = clone(base); o2.features.splice(1, 1);
  const t2 = clone(base); t2.features[1].radius = 9;
  assert.equal(mergeParts(base, o2, t2).conflicts[0].key, "feature:b");
  const t3 = clone(base); t3.features.splice(1, 1);
  const r3 = mergeParts(base, clone(base), t3);
  assert.deepEqual(r3.merged.features.map((f) => f.id), ["a"]);
});

test("diff and format round trip", () => {
  const b = clone(base); b.variables.w = 41; b.features[0].distance = 12; b.features.pop();
  const d = diffPart(base, b).map((x) => x.text);
  assert.ok(d.some((x) => x.includes("w: 40 → 41")));
  assert.ok(d.some((x) => x.includes("distance 10 → 12")));
  assert.ok(d.some((x) => x.startsWith("Removed")));
  assert.deepEqual(parsePart(formatPart(base)), base);
});
