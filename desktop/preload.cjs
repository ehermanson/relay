const { contextBridge, ipcRenderer } = require("electron");
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
const attached = process.argv.includes("--relay-attached=true");
contextBridge.exposeInMainWorld("relayDesktop", {
  platform: process.platform,
  capabilities: {
    launchAtLogin: process.argv.includes("--relay-login-supported=true"),
    multipleWindows: true,
    attachedServer: attached,
    sharing: attached,
    localFiles: !attached,
  },
  fullscreen: false,
  onNavigate: (callback) => subscribe("desktop:navigate", callback),
  onCommand: (callback) => subscribe("desktop:command", callback),
  onFullscreen: (callback) => subscribe("desktop:fullscreen", callback),
  chooseDirectory: () => ipcRenderer.invoke("desktop:choose-directory"),
  setBadge: (count) => ipcRenderer.invoke("desktop:badge", count),
  notify: (notification) => ipcRenderer.invoke("desktop:notify", notification),
  setTheme: (theme) => ipcRenderer.invoke("desktop:theme", theme),
  setActivity: (state) => ipcRenderer.invoke("desktop:activity", state),
  getPreferences: () => ipcRenderer.invoke("desktop:preferences"),
  setPreferences: (preferences) => ipcRenderer.invoke("desktop:set-preferences", preferences),
  getConnection: () => ipcRenderer.invoke("desktop:connection"),
  setConnection: (connection) => ipcRenderer.invoke("desktop:set-connection", connection),
  revealPath: (path) => ipcRenderer.invoke("desktop:reveal", path),
  openPath: (path) => ipcRenderer.invoke("desktop:open", path),
  newWindow: (path) => ipcRenderer.invoke("desktop:new-window", path),
});
