// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { UpdateManager } from "../dist/server/update-manager.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const ENV_KEYS = [
  "DEV",
  "RELAY_UPDATE_REMOTE",
  "RELAY_UPDATE_BRANCH",
  "RELAY_UPDATE_FORCE_AVAILABLE",
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createManager() {
  return new UpdateManager({
    installDir: "/tmp/relay-update-test",
    currentVersion: "3.0.0",
    logger: noopLogger,
    requestRestart() {},
  });
}

afterEach(() => {
  restoreEnv();
});

describe("UpdateManager", () => {
  it("disables updates in dev mode", async () => {
    process.env.DEV = "1";

    const manager = createManager();
    await manager.init();

    assert.deepEqual(manager.getSnapshot(), {
      enabled: false,
      installAction: "restart",
      status: "unavailable",
      stage: null,
      currentVersion: "3.0.0",
      currentCommit: null,
      latestCommit: null,
      incomingCommits: [],
      incomingCommitCount: 0,
      updateAvailable: false,
      checkedAt: null,
      error: "Updates are only available in production installs.",
    });
  });

  it("disables updates when restart is not supported", async () => {
    const manager = new UpdateManager({
      installDir: "/tmp/relay-update-test",
      currentVersion: "3.0.0",
      logger: noopLogger,
      requestRestart() {},
      restartSupported: false,
    });

    await manager.init();

    assert.deepEqual(manager.getSnapshot(), {
      enabled: false,
      installAction: "restart",
      status: "unavailable",
      stage: null,
      currentVersion: "3.0.0",
      currentCommit: null,
      latestCommit: null,
      incomingCommits: [],
      incomingCommitCount: 0,
      updateAvailable: false,
      checkedAt: null,
      error: "Updates are only available when Relay is launched via the CLI.",
    });
  });

  it("marks an update available only when local is behind remote", async () => {
    const manager = createManager();
    manager.resolveGitTarget = async () => ({
      pullSource: "origin",
      checkSource: "origin",
      branch: "main",
    });
    manager.resolveCurrentCommit = async () => "1111111";
    manager.resolveRemoteCommit = async () => "2222222";
    manager.isCommitAncestor = async () => true;

    await manager.init();
    const snapshot = await manager.checkForUpdates({ force: true });

    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.updateAvailable, true);
    assert.equal(snapshot.currentCommit, "1111111");
    assert.equal(snapshot.latestCommit, "2222222");
  });

  it("lists the commits an update would pull in", async () => {
    const manager = createManager();
    manager.resolveGitTarget = async () => ({
      pullSource: "origin",
      checkSource: "origin",
      branch: "main",
    });
    manager.resolveCurrentCommit = async () => "1111111";
    manager.resolveRemoteCommit = async () => "3333333";
    manager.isCommitAncestor = async () => true;
    manager.execGit = async (args) => {
      if (args[0] === "rev-list") return "2";
      if (args[0] === "log") return "3333333\x1fNewest change\n2222222\x1fOlder change";
      return "";
    };

    await manager.init();
    const snapshot = await manager.checkForUpdates({ force: true });

    assert.equal(snapshot.incomingCommitCount, 2);
    assert.deepEqual(snapshot.incomingCommits, [
      { commit: "3333333", subject: "Newest change" },
      { commit: "2222222", subject: "Older change" },
    ]);
  });

  it("reports up_to_date when local matches remote", async () => {
    const manager = createManager();
    manager.resolveGitTarget = async () => ({
      pullSource: "origin",
      checkSource: "origin",
      branch: "main",
    });
    manager.resolveCurrentCommit = async () => "1111111";
    manager.resolveRemoteCommit = async () => "1111111";

    await manager.init();
    const snapshot = await manager.checkForUpdates({ force: true });

    assert.equal(snapshot.status, "up_to_date");
    assert.equal(snapshot.updateAvailable, false);
  });

  it("does not report an update when local is ahead or diverged", async () => {
    const manager = createManager();
    manager.resolveGitTarget = async () => ({
      pullSource: "origin",
      checkSource: "origin",
      branch: "main",
    });
    manager.resolveCurrentCommit = async () => "3333333";
    manager.resolveRemoteCommit = async () => "2222222";
    manager.isCommitAncestor = async () => false;

    await manager.init();
    const snapshot = await manager.checkForUpdates({ force: true });

    assert.equal(snapshot.status, "up_to_date");
    assert.equal(snapshot.updateAvailable, false);
  });

  it("accepts remote and branch overrides", async () => {
    process.env.RELAY_UPDATE_REMOTE = "origin";
    process.env.RELAY_UPDATE_BRANCH = "test-branch";

    const manager = createManager();
    manager.resolveCurrentCommit = async () => "1111111";
    manager.resolveRemoteCommit = async () => "1111111";

    await manager.init();

    assert.equal(manager.getSnapshot().enabled, true);
    assert.deepEqual(manager.gitTarget, {
      pullSource: "origin",
      checkSource: "origin",
      branch: "test-branch",
    });
  });

  it("can force update availability for restart-flow testing", async () => {
    process.env.RELAY_UPDATE_FORCE_AVAILABLE = "1";

    const manager = createManager();
    manager.resolveGitTarget = async () => ({
      pullSource: "origin",
      checkSource: "origin",
      branch: "main",
    });
    manager.resolveCurrentCommit = async () => "3333333";
    manager.resolveRemoteCommit = async () => "2222222";
    manager.isCommitAncestor = async () => false;

    await manager.init();
    const snapshot = await manager.checkForUpdates({ force: true });

    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.updateAvailable, true);
  });
});
