#!/usr/bin/env node
// Pre-commit check (scripts/hooks/pre-commit): refuse to commit API keys. Blocks key files by name, the exact key
// values saved in apikeys.json or set in ONSHAPE_* variables, and anything shaped like a key assignment.
// Prints file:line only, never the key itself.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).toString();

const KEY_FILES = /(^|\/)(apikeys\.json|onshape\.json|[^/]*\.keys\.json|onshape-keys\.bin|ai-keys\.bin|\.env(\.[^/]*)?)$/;
const KEY_LIKE = /(secret[_-]?key|access[_-]?key|api[_-]?key|secret|token)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{20,}["']/i;

const known = new Set();
const collect = (v) => { if (typeof v === "string" && v.length >= 12) known.add(v); else if (v && typeof v === "object") Object.values(v).forEach(collect); };
try { collect(JSON.parse(fs.readFileSync(path.join(ROOT, "apikeys.json"), "utf8"))); } catch { /* no local keys */ }
collect(process.env.ONSHAPE_ACCESS_KEY); collect(process.env.ONSHAPE_SECRET_KEY);
known.delete("https://cad.onshape.com");

const problems = [];
const staged = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0").filter(Boolean);
for (const f of staged) if (KEY_FILES.test(f) && !f.endsWith(".example")) problems.push(`${f}: key file`);

let file = "", line = 0;
for (const l of git("diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR").split("\n")) {
  if (l.startsWith("+++ ")) { file = l.replace(/^\+\+\+ b\//, ""); continue; }
  const h = /^@@ -\S+ \+(\d+)/.exec(l);
  if (h) { line = Number(h[1]); continue; }
  if (!l.startsWith("+")) continue;
  const text = l.slice(1);
  if ([...known].some((k) => text.includes(k))) problems.push(`${file}:${line}: one of your saved API keys`);
  else if (KEY_LIKE.test(text)) problems.push(`${file}:${line}: looks like an API key`);
  line++;
}

if (problems.length) {
  console.error(`cadForMe: commit blocked, it would include API keys:\n  ${problems.join("\n  ")}\n` +
    "Remove them (keys belong in apikeys.json, which is gitignored), or if this is a false alarm commit with --no-verify.");
  process.exit(1);
}
