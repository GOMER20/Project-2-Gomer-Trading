// Runs in the sandboxed renderer before the page. Exposes the few things the
// web UI needs from the desktop shell; nothing else from Node or Electron is
// reachable from page scripts.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gomerDesktop', {
  signIn: (account) => ipcRenderer.invoke('gomer:sign-in', account),
  openMarketData: () => ipcRenderer.send('gomer:open-market-data'),
  hosting: () => ipcRenderer.invoke('gomer:hosting'),
  openHosting: () => ipcRenderer.send('gomer:open-hosting'),
  openWindow: (name) => ipcRenderer.send('gomer:open-window', name),
  notify: (title, body) => ipcRenderer.send('gomer:notify', String(title ?? ''), String(body ?? '')),
});
