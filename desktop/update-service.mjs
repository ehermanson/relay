import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

/** Backend-side adapter keeps the existing authenticated HTTP routes unchanged. */
export async function createBackendUpdateService({
  parent,
  startMessage,
  installDir,
  getRuntimeStatus,
  runCommand = execute,
  createSourceManager = async (options) => {
    const { UpdateManager } = await import("../dist/server/update-manager.js");
    return new UpdateManager(options);
  },
}) {
  const pending = new Map();
  let serial = 0;
  let snapshot = startMessage.updateSnapshot;
  let sourceRestartPending = false;
  let sourceError = null;
  const request = (operation, options = {}) =>
    new Promise((resolve, reject) => {
      const id = `update-${++serial}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Desktop update operation timed out."));
      }, 30 * 60_000);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ type: "update-request", id, operation, force: !!options.force });
    });
  parent.on("message", ({ data: message }) => {
    if (message?.type === "update-snapshot") snapshot = message.snapshot;
    if (message?.type === "source-update-deferred")
      sourceError = message.error || "Finish active Chats and terminals before restarting Relay.";
    if (message?.type !== "update-result") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  if (startMessage.packaged) {
    if (!snapshot) throw new Error("Desktop update snapshot missing from startup.");
    return {
      getSnapshot: () => ({ ...snapshot }),
      checkForUpdates: (options) => request("check", options),
      installUpdate: () => request("install"),
    };
  }

  const manager = await createSourceManager({
    installDir,
    currentVersion: startMessage.currentVersion || "0.0.0",
    logger: console,
    requestRestart: () => {
      sourceRestartPending = true;
      parent.postMessage({ type: "source-update-restart" });
    },
  });
  await manager.init();
  const getSnapshot = () => {
    const result = { ...manager.getSnapshot(), distribution: "source" };
    if (sourceRestartPending && sourceError)
      return {
        ...result,
        status: "available",
        stage: "waiting",
        updateAvailable: true,
        error: sourceError,
      };
    return result;
  };
  return {
    getSnapshot,
    checkForUpdates: async (options) => {
      await manager.checkForUpdates(options);
      return getSnapshot();
    },
    async installUpdate() {
      const state = getRuntimeStatus();
      if (state.activeCount || state.pendingCount || state.terminalCount)
        return {
          ok: false,
          action: "restart",
          error: "Finish active Chats and terminals before updating Relay.",
        };
      if (sourceRestartPending) {
        sourceError = null;
        setTimeout(() => parent.postMessage({ type: "source-update-restart" }), 500);
        return { ok: true, action: "restart" };
      }
      // A source shell may be launched from a checkout where agents are
      // editing. Never auto-stash their changes or fast-forward a feature branch.
      const [{ stdout: status }, { stdout: branch }] = await Promise.all([
        runCommand("git", ["status", "--porcelain"], { cwd: installDir, timeout: 10_000 }),
        runCommand("git", ["branch", "--show-current"], { cwd: installDir, timeout: 10_000 }),
      ]);
      const expected = process.env.RELAY_UPDATE_BRANCH?.trim() || "main";
      if (status.trim() || branch.trim() !== expected)
        return {
          ok: false,
          action: "restart",
          error: `Source updates require a clean ${expected} checkout. Commit your work and update the main Relay installation.`,
        };
      return manager.installUpdate();
    },
  };
}
