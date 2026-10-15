import { EventEmitter } from "node:events";

/** Network-free updater double for a real Electron lifecycle smoke. It reaches
 * the native install boundary, then fails asynchronously as Squirrel can after
 * signature verification. It never downloads, replaces files, or quits. */
export function createUpdateSmokeAdapter({ failureDelayMs = 50 } = {}) {
  const adapter = new EventEmitter();
  const info = { version: "9999.0.0" };
  let checks = 0;
  let downloads = 0;
  let installs = 0;
  let downloaded = false;
  let failure;
  let timer;
  let disposed = false;
  const observers = new Set();
  const events = [];
  const mark = (event) => events.push(event);

  adapter.checkForUpdates = async () => {
    if (disposed) throw new Error("Smoke updater disposed");
    checks++;
    mark("check");
    adapter.emit("update-available", info);
    return { updateInfo: info };
  };
  adapter.downloadUpdate = async () => {
    if (disposed) throw new Error("Smoke updater disposed");
    downloads++;
    mark("download");
    adapter.emit("download-progress", { percent: 25 });
    // Keep the asynchronous boundary that real network downloads introduce.
    await new Promise((resolve) => setImmediate(resolve));
    if (disposed) throw new Error("Smoke updater disposed");
    downloaded = true;
    adapter.emit("download-progress", { percent: 100 });
    adapter.emit("update-downloaded", info);
    return [];
  };
  adapter.quitAndInstall = () => {
    if (disposed || !downloaded)
      throw new Error("Smoke install called without a downloaded update");
    if (timer) throw new Error("Smoke install already pending");
    installs++;
    mark("install");
    timer = setTimeout(() => {
      timer = undefined;
      failure = new Error("Synthetic installer signature rejection; no application files changed.");
      failure.code = "RELAY_SMOKE_INSTALL_REJECTED";
      mark("installer-error");
      adapter.emit("error", failure);
      for (const observer of observers) observer.resolve(failure);
      observers.clear();
    }, failureDelayMs);
  };
  adapter.getSmokeState = () => ({
    checks,
    downloads,
    installs,
    failure: failure?.code ?? null,
    events: [...events],
  });
  adapter.waitForFailure = (timeoutMs = 10000) => {
    if (failure) return Promise.resolve(failure);
    if (disposed) return Promise.reject(new Error("Smoke updater disposed"));
    return new Promise((resolve, reject) => {
      const observer = {
        resolve: (value) => {
          clearTimeout(deadline);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      };
      const deadline = setTimeout(() => {
        observers.delete(observer);
        reject(new Error("Synthetic native install was not attempted"));
      }, timeoutMs);
      observers.add(observer);
    });
  };
  adapter.dispose = () => {
    disposed = true;
    clearTimeout(timer);
    for (const observer of observers) observer.reject(new Error("Smoke updater disposed"));
    observers.clear();
  };
  return adapter;
}
