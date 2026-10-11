// Dev-only UI test harness: CADSLOP_TEST=<script.mjs> electron .
// The script exports default async ({ eval, shot, wait, invoke }) => void. Screenshots go to CADSLOP_SHOTS.
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export default async function driver({ app, win, openProject, handlers, osClient }) {
  const outDir = process.env.CADSLOP_SHOTS ?? process.cwd();
  fs.mkdirSync(outDir, { recursive: true });
  win.webContents.on("console-message", (e) => console.log(`[renderer:${e.level}] ${e.message}`));
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
  const api = {
    eval: (code) => win.webContents.executeJavaScript(code, true),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    shot: async (name) => {
      // a window the test never focused isn't repainted, so bring it forward and redraw first
      win.show(); win.focus(); win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 300));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
      console.log(`[shot] ${name}.png`);
    },
    invoke: (name, ...args) => handlers[name]({}, ...args),
    openProject, osClient,
    send: (ev) => win.webContents.sendInputEvent(ev),
    click: (x, y) => { for (const type of ["mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 }); },
  };
  try {
    const mod = await import(pathToFileURL(path.resolve(process.env.CADSLOP_TEST)).toString());
    await mod.default(api);
  } catch (e) { console.log("[test error]", e); }
  app.quit();
}
