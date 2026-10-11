// Where the Onshape API keys live: apikeys.json at the root of this repo (owner-only, listed in .gitignore, and the
// pre-commit check in scripts/hooks refuses to commit it or any key in it). ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY
// override the file. Shared by the terminal, the MCP server and the window, so connecting once covers everything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_URL = "https://cad.onshape.com";
export const keysFile = () => process.env.CADFORME_KEYS_FILE ?? path.join(ROOT, "apikeys.json");
// where earlier versions kept them; read once, moved into apikeys.json, then deleted
const legacyFile = () => path.join(os.homedir(), ".config", "cadforme", "onshape.json");

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const valid = (k) => (k?.accessKey && k?.secretKey ? { accessKey: k.accessKey, secretKey: k.secretKey, baseUrl: k.baseUrl || DEFAULT_URL } : null);

/** Refuse to write keys into a file git would track. */
function assertIgnored(f) {
  const dir = path.dirname(f);
  let inRepo = false;
  try { inRepo = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true"; } catch { /* not a repo, or no git */ }
  if (!inRepo) return;
  try { execFileSync("git", ["check-ignore", "-q", f], { cwd: dir, stdio: "ignore" }); }
  catch { throw new Error(`${f} is not in .gitignore, so the keys could be committed. Add it to .gitignore first`); }
}

function writeFile(data) {
  const f = keysFile();
  if (!Object.keys(data).length) { fs.rmSync(f, { force: true }); return; }
  assertIgnored(f);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(f, 0o600);   // the mode above only applies when the file is new
}

export function loadOnshapeKeys() {
  if (process.env.ONSHAPE_ACCESS_KEY && process.env.ONSHAPE_SECRET_KEY) return { accessKey: process.env.ONSHAPE_ACCESS_KEY, secretKey: process.env.ONSHAPE_SECRET_KEY, baseUrl: process.env.ONSHAPE_URL || DEFAULT_URL };
  const k = valid(readJson(keysFile())?.onshape);
  if (k) return k;
  const old = !process.env.CADFORME_KEYS_FILE && valid(readJson(legacyFile()));
  if (old) { try { saveOnshapeKeys(old); } catch { return old; } }
  return old || null;
}

export function saveOnshapeKeys(keys) {
  const k = valid(keys);
  if (!k) throw new Error("Both the access key and the secret key are needed");
  writeFile({ ...(readJson(keysFile()) ?? {}), onshape: k });
  if (!process.env.CADFORME_KEYS_FILE) fs.rmSync(legacyFile(), { force: true });
  return keysFile();
}

/** Forget the keys everywhere this app has kept them. */
export function clearOnshapeKeys() {
  const { onshape: _gone, ...rest } = readJson(keysFile()) ?? {};
  writeFile(rest);
  if (!process.env.CADFORME_KEYS_FILE) fs.rmSync(legacyFile(), { force: true });
}
