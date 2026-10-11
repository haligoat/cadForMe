import { test } from "node:test";
import assert from "node:assert/strict";
import { render, cleanPath } from "../src/cli/tui.js";
import { doctorChecks, doctorReport } from "../src/cli/doctor.js";

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const base = { status: ["project robot (3 parts)", "Onshape connected"], title: "What do you want to do?", footer: "q quit" };

test("the menu fills the screen exactly, marks the selection and shows shortcuts and hints", () => {
  const out = plain(render({ ...base, items: [{ label: "Parts", key: "a", hint: "open, check" }, { label: "Projects", key: "p" }], sel: 1 }, { cols: 60, rows: 12 }));
  const rows = out.split("\n");
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r) => r.length <= 60), "no row wider than the terminal");
  assert.match(out, /project robot \(3 parts\)/);
  assert.match(rows.find((r) => r.includes("Projects")), /^❯ p Projects/);
  assert.match(rows.find((r) => r.includes("Parts")), /^  a Parts {2}open, check/);
  assert.match(rows.at(-1), /q quit/);
});

test("long menus scroll to keep the selection visible; long output wraps instead of being cut", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ label: `part ${i}` }));
  const out = plain(render({ ...base, items, sel: 40 }, { cols: 60, rows: 14 }));
  assert.match(out, /❯ {3}part 40/); assert.doesNotMatch(out, /part 0\b/);
  const long = "#".repeat(130);
  const wrapped = plain(render({ ...base, lines: [long] }, { cols: 60, rows: 14 }));
  assert.equal((wrapped.match(/#/g) ?? []).length, 130, "every character shown");
});

test("secret input is masked", () => {
  const out = plain(render({ ...base, lines: [], input: { label: "Secret key:", value: "abc123", secret: true } }, { cols: 60, rows: 12 }));
  assert.match(out, /Secret key: •••••• /); assert.doesNotMatch(out, /abc123/);
});

test("dragged-in paths are cleaned", () => {
  assert.equal(cleanPath("'/Users/me/My Robot.step' "), "/Users/me/My Robot.step");
  assert.equal(cleanPath("/Users/me/My\\ Robot.step"), "/Users/me/My Robot.step");
  assert.equal(cleanPath("~/r.step"), `${process.env.HOME}/r.step`);
});

test("doctor lists each check with a fix for the ones that fail", () => {
  const checks = doctorChecks();
  assert.ok(checks.find((c) => c.name === "Node.js").ok);
  for (const c of checks) if (!c.ok) assert.ok(c.fix, `${c.name} says how to fix it`);
  const r = doctorReport([{ name: "A", ok: true, detail: "fine" }, { name: "B", ok: false, detail: "missing", fix: "do X" }, { name: "C", ok: false, detail: "off", fix: "do Y", optional: true }]);
  assert.match(r, /✓ A/); assert.match(r, /✗ B[\s\S]*fix: do X/); assert.match(r, /○ C/); assert.match(r, /1 problem\(s\) to fix/);
});
