import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  dialog,
  ipcMain,
  Notification,
  shell,
  utilityProcess,
  nativeTheme,
  screen,
  powerMonitor,
  globalShortcut,
  clipboard,
} from "electron";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  isLocalURL,
  externalURL,
  chatPath,
  applicationPath,
  allowedPermission,
} from "./security.mjs";
import {
  DEFAULT_PREFERENCES,
  validatePreferences,
  restoreBounds,
  deepLinkPath,
  authorizedPath,
  safeOpenPath,
} from "./native.mjs";
import { createBackendSupervisor, attachedServerURL } from "./runtime.mjs";
import { createDesktopUpdater } from "./updater.mjs";
import { sourceRelaunchExecutable } from "./source-relaunch.mjs";

const manifest = JSON.parse(await readFile(join(import.meta.dirname, "../package.json"), "utf8"));
const signedTest = manifest.desktopSignedUpdateTest;
if (signedTest) {
  if (
    !app.isPackaged ||
    typeof signedTest.root !== "string" ||
    !(await realpath(signedTest.root)).startsWith(
      join(await realpath(tmpdir()), "relay-signed-update-"),
    ) ||
    !(await realpath(app.getAppPath())).startsWith(
      (await realpath(join(signedTest.root, "current", "Relay.app"))) + "/",
    ) ||
    !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(signedTest.url) ||
    signedTest.home !== join(signedTest.root, "home") ||
    signedTest.resultPath !== join(signedTest.root, "result.json")
  )
    throw new Error("Invalid signed upgrade test configuration");
  process.env.RELAY_DESKTOP_HOME = signedTest.home;
  process.env.RELAY_DESKTOP_SMOKE = "1";
  process.env.RELAY_DESKTOP_BENCHMARK = "1";
}
app.setName("Relay");
app.setAppUserModelId("com.relay.desktop");
const home = process.env.RELAY_DESKTOP_HOME || join(homedir(), ".relay-desktop");
app.setPath("userData", join(home, "electron"));
const bootAt = performance.now();
const windows = new Set();
const notifications = new Set();
let window, supervisor, tray, origin, session, updater, authCookie;
let updateRecoveryCount = 0;
let updateAdapter;
let updateSmoke = false;
let requestedExitCode = 0;
let installing = false;
const notificationKeys = new Map();
let quitting = false,
  stopped = false,
  installAfterQuit,
  startupMs,
  backendMetrics;
let preferences = { ...DEFAULT_PREFERENCES };
let bounds = { width: 1280, height: 860 };
let connection = { mode: "local", url: null };
let lastPath = "/";
let switchingConnection = false;
let pendingPath = process.argv.map(deepLinkPath).find(Boolean);
let saveQueue = Promise.resolve();
const html = await readFile(join(import.meta.dirname, "../app/dist/index.html"), "utf8");
const inlineHashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .filter((match) => match[1].trim())
  .map((match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`)
  .join(" ");
const owned = () => connection.mode === "local";
const liveWindows = () => [...windows].filter((item) => !item.isDestroyed());
const focusedWindow = () => BrowserWindow.getFocusedWindow() || window;
function saveState() {
  const state = JSON.stringify({ preferences, bounds, connection, lastPath });
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      const temporary = join(home, "desktop.json.tmp");
      await writeFile(temporary, state, { mode: 0o600 });
      await rename(temporary, join(home, "desktop.json"));
    });
  return saveQueue;
}
function show(path, target = window) {
  if (!target || target.isDestroyed()) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  if (path) target.webContents.send("desktop:navigate", applicationPath(path) || "/");
}
function command(value) {
  show(undefined, focusedWindow());
  focusedWindow()?.webContents.send("desktop:command", value);
}
function trusted(event) {
  const owner = liveWindows().find((item) => event.sender === item.webContents);
  if (
    !owner ||
    event.senderFrame !== owner.webContents.mainFrame ||
    !isLocalURL(event.senderFrame.url, origin)
  )
    throw new Error("Untrusted desktop request");
  return owner;
}
function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => callback(trusted(event), ...args));
}
async function prepareInstall() {
  if (!owned()) return { ok: true };
  const child = supervisor?.child;
  if (!child || !supervisor.ready) throw new Error("Relay backend is unavailable");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("message", listener);
      reject(new Error("Update preparation timed out"));
    }, 10000);
    function listener(message) {
      if (message.type !== "prepare-update-result" || message.id !== id) return;
      clearTimeout(timer);
      child.removeListener("message", listener);
      resolve(message);
    }
    child.on("message", listener);
    child.postMessage({ type: "prepare-update", id });
  });
}
function requestExit(install) {
  installAfterQuit = install;
  app.quit();
}
function shortcut() {
  globalShortcut.unregister("CommandOrControl+Shift+Space");
  if (
    preferences.globalShortcut &&
    !globalShortcut.register("CommandOrControl+Shift+Space", () => show())
  )
    throw new Error("The global shortcut is already in use");
}
async function projectRoots() {
  if (!owned()) throw new Error("Local file actions are available when Relay runs locally");
  const response = await session.fetch(`${origin}/api/projects`);
  if (!response.ok) throw new Error("Project files are unavailable");
  const data = await response.json();
  const spaces = await Promise.all(
    data.projects.map(async (project) => {
      const response = await session.fetch(
        `${origin}/api/projects/${encodeURIComponent(project.id)}/spaces`,
      );
      return response.ok ? await response.json() : [];
    }),
  );
  return [
    ...data.projects.map((project) => project.directory),
    ...spaces
      .flat()
      .map((space) => space.worktreePath)
      .filter(Boolean),
    join(home, "uploads"),
  ];
}
async function reveal(path) {
  shell.showItemInFolder(await authorizedPath(path, await projectRoots()));
}
async function open(path) {
  const error = await shell.openPath(await safeOpenPath(path, await projectRoots()));
  if (error) throw new Error(error);
}
function trayMenu(state) {
  if (!tray) return;
  const count = state?.activeCount || 0;
  tray.setToolTip(count ? `Relay · ${count} running Chat${count === 1 ? "" : "s"}` : "Relay");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(state
        ? [
            {
              label: `${count} running · ${state.pendingCount || 0} need input · ${state.failedCount || 0} failed`,
              enabled: false,
            },
            { type: "separator" },
          ]
        : []),
      { label: "Show Relay", click: () => show() },
      { label: "Search Chats…", click: () => command("search") },
      { label: "New Chat…", click: () => command("new-chat") },
      { label: "New Window", click: () => void createWindow("/") },
      { type: "separator" },
      { label: "Quit Relay", click: () => app.quit() },
    ]),
  );
}
async function diagnostics() {
  const backend = owned() ? await supervisor.request("metrics").catch(() => null) : null;
  return {
    startupMs,
    backendStartup: backendMetrics,
    backend,
    processes: app.getAppMetrics(),
    platform: process.platform,
    version: app.isPackaged ? app.getVersion() : manifest.version,
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      chromium: process.versions.chrome,
    },
    connectionMode: connection.mode,
  };
}
function menus() {
  const checkUpdate = async () => {
    try {
      const response = await session.fetch(`${origin}/api/system/update/check?force=1`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Update check failed");
      command("settings");
    } catch (error) {
      dialog.showErrorBox("Update check failed", error.message);
    }
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: "Relay",
              submenu: [
                { role: "about", label: "About Relay" },
                {
                  label: "Settings…",
                  accelerator: "CmdOrCtrl+,",
                  click: () => command("settings"),
                },
                { label: "Check for Updates…", click: checkUpdate },
                { type: "separator" },
                { role: "hide", label: "Hide Relay" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit", label: "Quit Relay" },
              ],
            },
          ]
        : []),
      {
        label: "File",
        submenu: [
          { label: "New Chat…", accelerator: "CmdOrCtrl+N", click: () => command("new-chat") },
          {
            label: "Add Project…",
            accelerator: "CmdOrCtrl+Shift+O",
            click: () => command("new-project"),
          },
          {
            label: "New Window",
            accelerator: "CmdOrCtrl+Shift+N",
            click: () => void createWindow("/"),
          },
          { type: "separator" },
          {
            label: "Settings…",
            accelerator: process.platform === "darwin" ? undefined : "Ctrl+,",
            click: () => command("settings"),
          },
          { role: "close" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Search Chats…", accelerator: "CmdOrCtrl+K", click: () => command("search") },
          {
            label: "Toggle Sidebar",
            accelerator: "CmdOrCtrl+B",
            click: () => command("toggle-sidebar"),
          },
          { type: "separator" },
          ...(!app.isPackaged
            ? [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }]
            : []),
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        label: "Help",
        submenu: [
          { label: "Check for Updates…", click: checkUpdate },
          ...(!owned()
            ? [
                {
                  label: "Update Desktop Shell…",
                  click: async () => {
                    const snapshot = await updater.checkForUpdates({ force: true });
                    const answer = await dialog.showMessageBox(focusedWindow(), {
                      message: snapshot.updateAvailable
                        ? `Relay Desktop ${snapshot.latestVersion} is available`
                        : snapshot.error || "Relay Desktop is up to date",
                      buttons: snapshot.updateAvailable
                        ? ["Download and Install", "Later"]
                        : ["OK"],
                    });
                    if (snapshot.updateAvailable && answer.response === 0)
                      await updater.installUpdate();
                  },
                },
              ]
            : []),
          {
            label: "Reveal Desktop Data",
            click: () => shell.showItemInFolder(join(home, "desktop.json")),
          },
          {
            label: "Performance Diagnostics",
            click: async () => {
              await dialog.showMessageBox(focusedWindow(), {
                title: "Relay performance",
                message: "Process metrics",
                detail: JSON.stringify(await diagnostics(), null, 2),
              });
            },
          },
          {
            label: "Export Diagnostics…",
            click: async () => {
              const choice = await dialog.showSaveDialog(focusedWindow(), {
                defaultPath: "relay-diagnostics.json",
                filters: [{ name: "JSON", extensions: ["json"] }],
              });
              if (!choice.canceled)
                await writeFile(choice.filePath, JSON.stringify(await diagnostics(), null, 2), {
                  mode: 0o600,
                });
            },
          },
        ],
      },
    ]),
  );
}
function secureSession() {
  session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowedPermission(permission, details.requestingUrl || contents?.getURL(), origin)),
  );
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    allowedPermission(permission, requestingOrigin || contents?.getURL(), origin),
  );
  session.webRequest.onHeadersReceived((details, callback) =>
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; script-src 'self' ${inlineHashes}; style-src 'self' 'unsafe-inline' ${owned() ? "" : "https://fonts.googleapis.com"}; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self' data: ${owned() ? "" : "https://fonts.gstatic.com"}; connect-src 'self' ${origin.replace(/^http/, "ws")}; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
        ],
      },
    }),
  );
  session.on("will-download", (_event, item) => {
    try {
      const source = new URL(item.getURL());
      item.setSaveDialogOptions({
        defaultPath: join(
          app.getPath("downloads"),
          basename(source.searchParams.get("path") || item.getFilename()),
        ),
      });
    } catch {
      /* Keep native default for malformed URLs. */
    }
  });
}
function contextMenu(target, params) {
  const template = [];
  for (const suggestion of params.dictionarySuggestions || [])
    template.push({
      label: suggestion,
      click: () => target.webContents.replaceMisspelling(suggestion),
    });
  if (params.misspelledWord)
    template.push(
      {
        label: "Add to Dictionary",
        click: () => session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
      { type: "separator" },
    );
  if (params.isEditable)
    template.push(
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    );
  else if (params.selectionText) template.push({ role: "copy" });
  if (params.linkURL) {
    if (template.length) template.push({ type: "separator" });
    template.push({ label: "Copy Link", click: () => clipboard.writeText(params.linkURL) });
    if (isLocalURL(params.linkURL, origin)) {
      const link = new URL(params.linkURL);
      const path = link.searchParams.get("path");
      if (path && owned())
        template.push({
          label: "Reveal in " + (process.platform === "darwin" ? "Finder" : "File Manager"),
          click: () =>
            void reveal(path).catch((error) =>
              dialog.showErrorBox("Could not reveal file", error.message),
            ),
        });
      if (link.pathname.startsWith("/projects/"))
        template.push({
          label: "Open in New Window",
          click: () => void createWindow(link.pathname + link.search),
        });
      if (link.pathname.startsWith("/api/file"))
        template.push({
          label: "Save File…",
          click: () => target.webContents.downloadURL(params.linkURL),
        });
    } else {
      const safe = externalURL(params.linkURL);
      if (safe)
        template.push({ label: "Open in Browser", click: () => void shell.openExternal(safe) });
    }
  }
  if (template.length) Menu.buildFromTemplate(template).popup({ window: target });
}
async function createWindow(path = "/") {
  path = applicationPath(path);
  if (!path) throw new Error("Only Relay screens can open in a native window");
  const target = new BrowserWindow({
    ...restoreBounds(bounds, screen.getAllDisplays()),
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "Relay",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 16 } }
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: nativeTheme.shouldUseDarkColors ? "#1d1e20" : "#ffffff",
            symbolColor: nativeTheme.shouldUseDarkColors ? "#fafafa" : "#111111",
            height: 48,
          },
          autoHideMenuBar: true,
        }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1e20" : "#ffffff",
    webPreferences: {
      session,
      preload: join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      additionalArguments: [
        `--relay-login-supported=${app.isPackaged && ["darwin", "win32"].includes(process.platform)}`,
        `--relay-attached=${!owned()}`,
      ],
    },
  });
  const rememberPath = () => {
    if (switchingConnection) return;
    const current = target.webContents.getURL();
    if (isLocalURL(current, origin)) lastPath = applicationPath(new URL(current).pathname) || "/";
  };
  target.webContents.on("did-navigate", rememberPath);
  target.webContents.on("did-navigate-in-page", rememberPath);
  target.on("focus", rememberPath);
  windows.add(target);
  if (!window || window.isDestroyed()) window = target;
  target.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error("Renderer:", details.message);
  });
  target.webContents.on("context-menu", (_event, params) => contextMenu(target, params));
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalURL(url, origin)) {
      const local = new URL(url);
      if (local.pathname.startsWith("/api/")) target.webContents.downloadURL(url);
      else void createWindow(local.pathname + local.search);
      return { action: "deny" };
    }
    const safe = externalURL(url);
    if (safe) void shell.openExternal(safe);
    return { action: "deny" };
  });
  target.webContents.on("will-navigate", (event, url) => {
    if (isLocalURL(url, origin) && new URL(url).pathname.startsWith("/api/")) {
      event.preventDefault();
      target.webContents.downloadURL(url);
    } else if (!isLocalURL(url, origin)) {
      event.preventDefault();
      const safe = externalURL(url);
      if (safe) void shell.openExternal(safe);
    }
  });
  target.webContents.on("will-redirect", (event, url) => {
    if (!isLocalURL(url, origin)) event.preventDefault();
  });
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());
  target.webContents.on("render-process-gone", async (_event, details) => {
    if (quitting) return;
    const result = await dialog.showMessageBox(target, {
      type: "error",
      message: "Relay’s display stopped",
      detail: `${details.reason}. Your backend remains running.`,
      buttons: ["Reload Window", "Close Window"],
    });
    if (result.response === 0 && !target.isDestroyed())
      void target.loadURL(origin + chatPath(path));
    else target.destroy();
  });
  target.on("enter-full-screen", () => target.webContents.send("desktop:fullscreen", true));
  target.on("leave-full-screen", () => target.webContents.send("desktop:fullscreen", false));
  let geometryTimer;
  const saveGeometry = () => {
    clearTimeout(geometryTimer);
    geometryTimer = setTimeout(() => {
      if (!target.isDestroyed() && !target.isFullScreen() && !target.isMinimized()) {
        bounds = target.getNormalBounds();
        void saveState();
      }
    }, 300);
  };
  target.on("resize", saveGeometry);
  target.on("move", saveGeometry);
  target.on("close", (event) => {
    if (quitting || installing) return;
    if (preferences.closeToTray && liveWindows().length === 1) {
      event.preventDefault();
      bounds = target.getNormalBounds();
      void saveState();
      target.hide();
    }
  });
  target.on("closed", () => {
    clearTimeout(geometryTimer);
    windows.delete(target);
    if (window === target) window = liveWindows()[0];
    if (!quitting && !installing && !windows.size && !preferences.closeToTray) app.quit();
  });
  target.once("ready-to-show", () => {
    target.show();
    if (!startupMs) {
      startupMs = Math.round(performance.now() - bootAt);
      console.info(`Desktop ready in ${startupMs}ms`);
    }
    target.webContents.send("desktop:fullscreen", target.isFullScreen());
  });
  await target.loadURL(origin + chatPath(path));
  return target;
}
async function recoverBackend(ready) {
  origin = new URL(ready.url).origin;
  backendMetrics = ready.metrics;
  authCookie = ready.cookie.split(";")[0];
  if (session) {
    const separator = authCookie.indexOf("=");
    await session.cookies.set({
      url: origin,
      name: authCookie.slice(0, separator),
      value: authCookie.slice(separator + 1),
      httpOnly: true,
      sameSite: "strict",
    });
    for (const target of liveWindows()) {
      const current = target.webContents.getURL();
      const url = isLocalURL(current, origin) ? current : origin;
      await target.loadURL(url);
    }
  }
}
function spawnBackend() {
  const child = utilityProcess.fork(join(import.meta.dirname, "backend.mjs"), [], {
    serviceName: "Relay backend",
    stdio: "pipe",
  });
  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => process.stderr.write(data));
  child.on("message", async (message) => {
    if (message.type === "update-request") {
      try {
        const result =
          message.operation === "check"
            ? await updater.checkForUpdates({ force: message.force })
            : message.operation === "install"
              ? await updater.installUpdate()
              : undefined;
        if (!result) throw new Error("Unknown update operation");
        child.postMessage({ type: "update-result", id: message.id, result });
      } catch (error) {
        child.postMessage({ type: "update-result", id: message.id, error: error.message });
      }
    } else if (message.type === "source-update-restart") {
      try {
        const ready = await prepareInstall();
        if (!ready.ok) {
          child.postMessage({ type: "source-update-deferred", error: ready.error });
          return;
        }
        const executable = await sourceRelaunchExecutable(join(import.meta.dirname, ".."));
        requestExit(() => {
          app.relaunch({ execPath: executable });
          app.exit(0);
        });
      } catch (error) {
        child.postMessage({ type: "source-update-deferred", error: error.message });
      }
    }
  });
  return child;
}
function registerIPC() {
  handle("desktop:choose-directory", async (target) => {
    if (!owned()) throw new Error("Choose folders through the connected Relay server");
    const result = await dialog.showOpenDialog(target, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("desktop:badge", (_target, count) => {
    if (!Number.isInteger(count) || count < 0 || count > 9999) throw new Error("Invalid badge");
    app.setBadgeCount(count);
    if (owned())
      void supervisor
        .request("status")
        .then(trayMenu)
        .catch(() => {});
  });
  handle("desktop:theme", (target, theme) => {
    if (!["dark", "light"].includes(theme)) throw new Error("Invalid theme");
    if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
    target.setBackgroundColor(theme === "dark" ? "#1d1e20" : "#ffffff");
    if (process.platform !== "darwin")
      target.setTitleBarOverlay({
        color: theme === "dark" ? "#1d1e20" : "#ffffff",
        symbolColor: theme === "dark" ? "#fafafa" : "#111111",
        height: 48,
      });
  });
  handle("desktop:activity", (_target, state) => {
    if (
      !state ||
      !["running", "needsInput", "failed"].every(
        (key) => Number.isInteger(state[key]) && state[key] >= 0 && state[key] <= 9999,
      )
    )
      throw new Error("Invalid activity counts");
    trayMenu({
      activeCount: state.running,
      pendingCount: state.needsInput,
      failedCount: state.failed,
    });
  });
  handle("desktop:preferences", () => ({ ...preferences }));
  handle("desktop:set-preferences", async (_target, value) => {
    validatePreferences(value);
    if ("launchAtLogin" in value) {
      if (!app.isPackaged || !["darwin", "win32"].includes(process.platform))
        throw new Error("Launch at login requires an installed macOS or Windows app");
      app.setLoginItemSettings({ openAtLogin: value.launchAtLogin });
    }
    const previous = preferences;
    preferences = { ...preferences, ...value };
    try {
      shortcut();
      await saveState();
    } catch (error) {
      preferences = previous;
      shortcut();
      throw error;
    }
    return { ...preferences };
  });
  handle("desktop:connection", () => ({ ...connection }));
  handle("desktop:set-connection", async (_target, value) => {
    if (!value || !["local", "existing"].includes(value.mode))
      throw new Error("Choose a server mode");
    const next = {
      mode: value.mode,
      url: value.mode === "existing" ? attachedServerURL(value.url) : null,
    };
    if (owned()) {
      const ready = await prepareInstall();
      if (!ready.ok) throw new Error(ready.error);
    }
    switchingConnection = true;
    lastPath = "/";
    connection = next;
    await saveState();
    setTimeout(
      () =>
        requestExit(() => {
          app.relaunch();
          app.exit(0);
        }),
      200,
    );
  });
  handle("desktop:reveal", (_target, path) => reveal(path));
  handle("desktop:open", (_target, path) => open(path));
  handle("desktop:new-window", (_target, path) => createWindow(chatPath(path)).then(() => {}));
  handle("desktop:notify", (_target, value) => {
    if (
      !preferences.notifications ||
      liveWindows().some((item) => item.isFocused()) ||
      !Notification.isSupported()
    )
      return;
    if (
      !value ||
      typeof value.title !== "string" ||
      typeof value.body !== "string" ||
      value.title.length > 200 ||
      value.body.length > 1000 ||
      notifications.size >= 10
    )
      return;
    const key = JSON.stringify([value.path, value.title, value.body]);
    const now = Date.now();
    for (const [entry, time] of notificationKeys)
      if (now - time > 3000) notificationKeys.delete(entry);
    if (notificationKeys.has(key)) return;
    notificationKeys.set(key, now);
    const notice = new Notification({ title: value.title, body: value.body });
    notifications.add(notice);
    notice.once("close", () => notifications.delete(notice));
    notice.once("click", () => {
      notifications.delete(notice);
      show(chatPath(value.path));
    });
    notice.show();
  });
}
async function smoke() {
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const target = window;
  const report = await target.webContents.executeJavaScript(
    `(async()=>{const outfit=await document.fonts.load('400 16px Outfit');const mono=await document.fonts.load('400 14px "JetBrains Mono"');const prior=localStorage.getItem('relay:desktop-smoke');localStorage.setItem('relay:desktop-smoke','persisted');return{title:document.title,bridge:!!window.relayDesktop,body:document.body.innerText.slice(0,150),outfit:outfit.length>0&&outfit.every(face=>face.status==='loaded'),mono:mono.length>0&&mono.every(face=>face.status==='loaded'),prior,identity:await fetch('/api/outbox/identity').then(r=>r.json()),preferences:await window.relayDesktop.getPreferences(),updates:await fetch('/api/system/update').then(r=>r.json())}})()`,
  );
  if (!report.bridge || !report.body.trim() || !report.outfit || !report.mono)
    throw new Error("Desktop renderer/font smoke failed");
  if (signedTest) {
    const version = app.getVersion();
    const identity = report.identity.identity;
    if (version === signedTest.fromVersion) {
      await writeFile(
        join(signedTest.root, "before.json"),
        JSON.stringify({ version, origin, identity, storage: "persisted", pid: process.pid }),
      );
      await updater.checkForUpdates({ force: true });
      const result = await updater.installUpdate();
      if (!result.ok) throw new Error(result.error || "Signed upgrade failed");
      return;
    }
    const before = JSON.parse(await readFile(join(signedTest.root, "before.json"), "utf8"));
    if (
      version !== signedTest.toVersion ||
      before.origin !== origin ||
      before.identity !== identity ||
      report.prior !== "persisted"
    )
      throw new Error("Signed upgrade did not preserve application state");
    await writeFile(
      signedTest.resultPath,
      JSON.stringify({
        ok: true,
        version,
        origin,
        identity,
        prior: report.prior,
        oldVersion: before.version,
        pid: process.pid,
      }),
    );
  }
  const metrics = await diagnostics();
  console.info("DESKTOP_SMOKE", JSON.stringify(report));
  console.info("DESKTOP_METRICS", JSON.stringify(metrics));
  if (process.env.RELAY_DESKTOP_BENCHMARK === "1")
    console.info(
      "DESKTOP_BENCHMARK",
      JSON.stringify({
        backend: backendMetrics,
        startupMs,
        processes: app.getAppMetrics(),
        memory: process.memoryUsage(),
        rendererMemory: await target.webContents.executeJavaScript(
          "performance.memory ? {usedJSHeapSize:performance.memory.usedJSHeapSize} : null",
        ),
        origin,
        prior: report.prior,
        identity: report.identity,
      }),
    );
  if (Number(process.env.RELAY_DESKTOP_BENCHMARK_MESSAGES) > 0) {
    const { profileSyntheticChat } = await import("./renderer-benchmark.mjs");
    console.info(
      "DESKTOP_RENDERER_BENCHMARK",
      JSON.stringify(
        await profileSyntheticChat(target, Number(process.env.RELAY_DESKTOP_BENCHMARK_MESSAGES)),
      ),
    );
  }
  if (
    process.env.RELAY_DESKTOP_MEMORY_BENCHMARK === "1" &&
    process.env.RELAY_DESKTOP_BENCHMARK === "1"
  ) {
    const { profileMemory } = await import("./memory-benchmark.mjs");
    console.info(
      "DESKTOP_MEMORY_BENCHMARK",
      JSON.stringify(
        await profileMemory({
          window: target,
          request: (type, payload) => supervisor.request(type, payload),
          processMetrics: () => app.getAppMetrics(),
        }),
      ),
    );
  }
  if (updateSmoke) {
    const previous = supervisor.child;
    await updater.checkForUpdates({ force: true });
    const installed = await updater.installUpdate();
    if (!installed.ok) throw new Error("Update smoke could not stage install");
    const deadline = Date.now() + 20000;
    while (!updateRecoveryCount || !supervisor.ready || supervisor.child === previous) {
      if (Date.now() > deadline) throw new Error("Failed installer did not recover Relay");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const response = await session.fetch(`${origin}/api/outbox/identity`);
    const owner = await response.json();
    if (!response.ok || owner.identity !== report.identity.identity)
      throw new Error("Update recovery lost authentication or outbox ownership");
    const preserved = await window.webContents.executeJavaScript(
      "localStorage.getItem('relay:desktop-smoke')",
    );
    const attempts = updateAdapter.getSmokeState();
    if (preserved !== "persisted" || attempts.downloads !== 1 || attempts.installs !== 1)
      throw new Error("Update recovery smoke did not preserve storage or install exactly once");
    console.info(
      "DESKTOP_UPDATE_SMOKE",
      JSON.stringify({
        recovered: true,
        sameOwner: true,
        status: updater.getSnapshot().status,
        storage: preserved,
        attempts,
      }),
    );
  }
  if (process.env.RELAY_DESKTOP_RECOVERY_SMOKE === "1") {
    const previous = supervisor.child;
    previous.kill();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Backend recovery failed")), 20000);
      const poll = setInterval(() => {
        if (supervisor.ready && supervisor.child !== previous) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 100);
    });
    const status = await supervisor.request("status");
    console.info("DESKTOP_RECOVERY", JSON.stringify(status));
  }
  setTimeout(() => app.quit(), 1000);
}
function bootstrapMessage() {
  return {
    home,
    password: randomBytes(32).toString("hex"),
    packaged: app.isPackaged || updateSmoke,
    currentVersion: app.isPackaged ? app.getVersion() : manifest.version,
    updateSnapshot: updater.getSnapshot(),
  };
}
function makeSupervisor() {
  return createBackendSupervisor({
    spawn: spawnBackend,
    onReady: async (ready) => {
      await recoverBackend(ready);
      supervisor.child?.postMessage({ type: "update-snapshot", snapshot: updater.getSnapshot() });
    },
    onFailure: (error) => {
      if (!quitting) {
        if (process.env.RELAY_DESKTOP_SMOKE === "1") {
          console.error("DESKTOP_SMOKE_FAILED", error.message);
          requestedExitCode = 1;
          app.quit();
        } else dialog.showErrorBox("Relay backend could not recover", error.message);
      }
    },
    onExit: () => {
      if (!quitting) tray?.setToolTip("Relay · Recovering backend");
    },
  });
}

async function start() {
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    const state = JSON.parse(await readFile(join(home, "desktop.json"), "utf8"));
    preferences = { ...DEFAULT_PREFERENCES, ...validatePreferences(state.preferences) };
    bounds = restoreBounds(state.bounds, screen.getAllDisplays());
    lastPath = applicationPath(state.lastPath) || "/";
    if (state.connection?.mode === "existing")
      connection = { mode: "existing", url: attachedServerURL(state.connection.url) };
  } catch (error) {
    if (error.code !== "ENOENT")
      console.warn("Desktop preferences could not be restored; using safe defaults");
  }
  if (process.env.RELAY_DESKTOP_BENCHMARK === "1") lastPath = "/";
  if (process.env.RELAY_DESKTOP_SERVER_URL)
    connection = { mode: "existing", url: attachedServerURL(process.env.RELAY_DESKTOP_SERVER_URL) };
  if (!signedTest && app.isPackaged && ["darwin", "win32"].includes(process.platform))
    preferences.launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const { default: electronUpdater } = await import("electron-updater");
  updateSmoke =
    process.env.RELAY_DESKTOP_UPDATE_SMOKE === "1" && process.env.RELAY_DESKTOP_SMOKE === "1";
  const adapter = updateSmoke
    ? (await import("./update-smoke-adapter.mjs")).createUpdateSmokeAdapter()
    : electronUpdater.autoUpdater;
  if (signedTest) {
    adapter.setFeedURL({ provider: "generic", url: signedTest.url });
    adapter.disableDifferentialDownload = true;
  }
  updateAdapter = adapter;
  updater = createDesktopUpdater({
    adapter,
    currentVersion: app.isPackaged ? app.getVersion() : manifest.version,
    enabled: !!signedTest || updateSmoke || (app.isPackaged && manifest.desktopRelease === true),
    unavailableReason: "Automatic updates are available in installed release builds.",
    prepareInstall: async () => {
      const ready = await prepareInstall();
      if (ready.ok) await supervisor?.stop();
      return ready;
    },
    onInstallError: async (error) => {
      console.error("Native installer failed:", error.message);
      installing = false;
      quitting = false;
      stopped = false;
      installAfterQuit = undefined;
      if (owned()) {
        supervisor = makeSupervisor();
        await supervisor.start(bootstrapMessage());
      }
      if (!liveWindows().length) await createWindow("/");
      updateRecoveryCount++;
      if (process.env.RELAY_DESKTOP_SMOKE !== "1")
        dialog.showErrorBox(
          "Relay update could not install",
          "The current version has been restored. " + error.message,
        );
      else console.info("DESKTOP_UPDATE_RECOVERY_READY", updateRecoveryCount);
    },
    onSnapshot: (snapshot) => supervisor?.child?.postMessage({ type: "update-snapshot", snapshot }),
    install: () => {
      installing = true;
      adapter.quitAndInstall(false, true);
    },
  });
  if (owned()) {
    supervisor = makeSupervisor();
    await supervisor.start(bootstrapMessage());
  } else origin = connection.url;
  const { session: electronSession } = await import("electron");
  session = owned()
    ? electronSession.defaultSession
    : electronSession.fromPartition(
        `persist:relay-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`,
      );
  if (authCookie) {
    const separator = authCookie.indexOf("=");
    await session.cookies.set({
      url: origin,
      name: authCookie.slice(0, separator),
      value: authCookie.slice(separator + 1),
      httpOnly: true,
      sameSite: "strict",
    });
  }
  secureSession();
  registerIPC();
  menus();
  const image = nativeImage
    .createFromPath(join(import.meta.dirname, "../app/public/icon-192.png"))
    .resize({ width: 18, height: 18 });
  if (image.isEmpty()) throw new Error("Relay tray icon is unavailable");
  tray = new Tray(image);
  trayMenu();
  tray.on("click", () => show());
  try {
    shortcut();
  } catch {
    preferences.globalShortcut = false;
    await saveState();
  }
  await createWindow(pendingPath || lastPath);
  pendingPath = null;
  powerMonitor.on("resume", () => {
    if (owned())
      void supervisor
        .request("reconcile")
        .then(trayMenu)
        .catch(() => {});
    for (const target of liveWindows()) target.webContents.send("desktop:resume");
  });
  powerMonitor.on("shutdown", () => app.quit());
  app.on("browser-window-focus", () => {
    if (owned())
      void supervisor
        .request("status")
        .then(trayMenu)
        .catch(() => {});
  });
  if (process.env.RELAY_DESKTOP_SMOKE === "1") await smoke();
}
function deepLink(value) {
  const path = deepLinkPath(value);
  if (!path) return;
  if (window) show(path);
  else pendingPath = path;
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  deepLink(url);
});
if (app.isPackaged && !signedTest && process.env.RELAY_DESKTOP_SMOKE !== "1")
  app.setAsDefaultProtocolClient("relay");
else if (process.env.RELAY_REGISTER_PROTOCOL === "1")
  app.setAsDefaultProtocolClient("relay", process.execPath, [
    join(import.meta.dirname, "main.mjs"),
  ]);
process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    argv.forEach(deepLink);
    show();
  });
  app.on("activate", () => {
    if (window) show();
    else if (origin) void createWindow("/");
  });
  app.on("window-all-closed", () => {
    if (!installing && !preferences.closeToTray) app.quit();
  });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    if (window && !window.isDestroyed()) bounds = window.getNormalBounds();
    globalShortcut.unregisterAll();
    void (async () => {
      try {
        await saveState();
        await supervisor?.stop();
      } finally {
        stopped = true;
        updater?.dispose();
        tray?.destroy();
        if (installAfterQuit) installAfterQuit();
        else if (requestedExitCode) app.exit(requestedExitCode);
        else app.quit();
      }
    })();
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error("Desktop startup failed:", error.message);
      if (process.env.RELAY_DESKTOP_SMOKE === "1") {
        requestedExitCode = 1;
        console.error("DESKTOP_SMOKE_FAILED", error.message);
      } else dialog.showErrorBox("Relay could not start", error.message);
      app.quit();
    });
}
