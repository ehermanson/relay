/** Native releases share the web updater's HTTP snapshot contract. Electron and
 * its updater are injected so this state machine can be tested without a GUI. */
export function createDesktopUpdater({
  adapter,
  currentVersion,
  enabled = true,
  unavailableReason = "Native updates require an installed application.",
  onSnapshot = () => {},
  prepareInstall,
  onInstallError = async () => {},
  install = () => adapter.quitAndInstall(false, true),
  schedule = (callback) => setTimeout(callback, 500),
  cancel = clearTimeout,
  now = Date.now,
}) {
  let snapshot = {
    enabled,
    distribution: "desktop",
    installAction: "restart",
    status: enabled ? "idle" : "unavailable",
    stage: null,
    currentVersion,
    latestVersion: null,
    downloadPercent: null,
    currentCommit: null,
    latestCommit: null,
    incomingCommits: [],
    incomingCommitCount: 0,
    updateAvailable: false,
    checkedAt: null,
    error: enabled ? null : unavailableReason,
  };
  let checking;
  let installing;
  let downloaded = false;
  let pendingInstall;
  let disposed = false;
  let prepared = false;
  let recoveryStarted = false;
  const listeners = [];
  const getSnapshot = () => ({ ...snapshot, incomingCommits: [] });
  const update = (patch) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    onSnapshot(getSnapshot());
  };
  const fail = (error) => {
    update({
      status: "error",
      stage: null,
      error: error instanceof Error ? error.message : String(error),
    });
    if (prepared && !recoveryStarted) {
      prepared = false;
      recoveryStarted = true;
      pendingInstall = undefined;
      // On macOS Squirrel verifies the code signature asynchronously during
      // quitAndInstall, after quiescence. Restore the backend if that fails.
      void Promise.resolve()
        .then(() => onInstallError(error))
        .catch((recoveryError) => {
          update({ error: `Update failed; Relay could not recover: ${recoveryError.message}` });
        });
    }
  };
  const listen = (event, callback) => {
    adapter.on(event, callback);
    listeners.push([event, callback]);
  };
  // Never install merely because the user quit while Chats are running.
  adapter.autoDownload = false;
  adapter.autoInstallOnAppQuit = false;
  adapter.allowPrerelease = false;
  adapter.allowDowngrade = false;
  listen("update-available", (info) =>
    update({
      status: "available",
      stage: null,
      updateAvailable: true,
      latestVersion: info.version,
      checkedAt: now(),
      error: null,
    }),
  );
  listen("update-not-available", (info) =>
    update({
      status: "up_to_date",
      stage: null,
      updateAvailable: false,
      latestVersion: info.version,
      checkedAt: now(),
      error: null,
    }),
  );
  listen("download-progress", (progress) => {
    const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
    if (Number.isFinite(percent) && snapshot.downloadPercent !== percent)
      update({ status: "updating", stage: "downloading", downloadPercent: percent });
  });
  listen("update-downloaded", (info) => {
    downloaded = true;
    update({ latestVersion: info.version, downloadPercent: 100 });
  });
  listen("error", fail);

  async function checkForUpdates(options = {}, fromInstall = false) {
    if (!enabled || disposed || (installing && !fromInstall) || pendingInstall)
      return getSnapshot();
    if (checking) return checking;
    if (!options.force && snapshot.checkedAt && now() - snapshot.checkedAt < 300_000)
      return getSnapshot();
    if (downloaded) return getSnapshot();
    update({ status: "checking", stage: null, error: null });
    checking = (async () => {
      try {
        const result = await adapter.checkForUpdates();
        if (!result) throw new Error("This application cannot check native updates.");
        if (snapshot.status === "checking")
          update({ status: "up_to_date", checkedAt: now(), error: null });
      } catch (error) {
        fail(error);
        update({ checkedAt: now() });
      }
      return getSnapshot();
    })();
    try {
      return await checking;
    } finally {
      checking = undefined;
    }
  }

  async function finishInstall() {
    // Keep the pending marker set until shutdown begins: repeated clicks cannot
    // race a second installation against the first quiescence check.
    try {
      const result = await prepareInstall();
      if (result === false || result?.ok === false) {
        pendingInstall = undefined;
        update({
          status: "available",
          stage: "waiting",
          error: result?.error || "Finish active Chats and terminals before restarting Relay.",
        });
        return;
      }
      if (disposed) return;
      prepared = true;
      recoveryStarted = false;
      update({ status: "restart_pending", stage: "restarting", error: null });
      await install();
    } catch (error) {
      pendingInstall = undefined;
      fail(error);
    }
  }

  async function installUpdate() {
    if (!enabled || disposed) return { ok: false, action: "restart", error: unavailableReason };
    if (pendingInstall) return { ok: true, action: "restart" };
    if (installing) return installing;
    installing = (async () => {
      try {
        if (checking) await checking;
        if (!snapshot.updateAvailable) await checkForUpdates({ force: true }, true);
        if (!snapshot.updateAvailable)
          return {
            ok: false,
            action: "restart",
            error: snapshot.error || "Relay is already up to date.",
          };
        if (!downloaded) {
          update({ status: "updating", stage: "downloading", downloadPercent: 0, error: null });
          await adapter.downloadUpdate();
          // A rejected download never reaches here. Integrity hashes are checked
          // here; macOS additionally verifies signing during quitAndInstall.
          downloaded = true;
        }
        if (disposed) return { ok: false, action: "restart", error: "Updater stopped." };
        update({ status: "updating", stage: "waiting", downloadPercent: 100, error: null });
        pendingInstall = schedule(() => void finishInstall());
        return { ok: true, action: "restart" };
      } catch (error) {
        fail(error);
        return { ok: false, action: "restart", error: snapshot.error };
      }
    })();
    try {
      return await installing;
    } finally {
      installing = undefined;
    }
  }

  return {
    getSnapshot,
    checkForUpdates,
    installUpdate,
    dispose() {
      disposed = true;
      if (pendingInstall) cancel(pendingInstall);
      for (const [event, callback] of listeners) adapter.removeListener(event, callback);
    },
  };
}
