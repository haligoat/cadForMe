const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cad", {
  // Electron prefixes errors with "Error invoking remote method 'cad:x': Error: "; show people just the message.
  invoke: (ch, ...args) => ipcRenderer.invoke(`cad:${ch}`, ...args).catch((e) => { throw new Error(String(e?.message ?? e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "")); }),
  onMenu: (cb) => { const f = (_e, cmd, arg) => cb(cmd, arg); ipcRenderer.on("cad:menu", f); return () => ipcRenderer.off("cad:menu", f); },
  onAiEvent: (cb) => { const f = (_e, ev) => cb(ev); ipcRenderer.on("cad:ai-event", f); return () => ipcRenderer.off("cad:ai-event", f); },
  onRefsChanged: (cb) => { const f = () => cb(); ipcRenderer.on("cad:refs-changed", f); return () => ipcRenderer.off("cad:refs-changed", f); },
  onFilesChanged: (cb) => { const f = (_e, rel) => cb(rel); ipcRenderer.on("cad:files-changed", f); return () => ipcRenderer.off("cad:files-changed", f); },
});
