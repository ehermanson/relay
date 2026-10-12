import "../test/test-env.js";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopUpdater } from "./updater.mjs";

function setup(overrides = {}) {
  const adapter = new EventEmitter();
  let downloads = 0;
  let installs = 0;
  let scheduled;
  adapter.checkForUpdates = async () => {
    adapter.emit("update-available", { version: "3.1.0" });
    return { updateInfo: { version: "3.1.0" } };
  };
  adapter.downloadUpdate = async () => {
    downloads++;
    adapter.emit("download-progress", { percent: 42.8 });
    adapter.emit("update-downloaded", { version: "3.1.0" });
  };
  adapter.quitAndInstall = () => {
    installs++;
  };
  const snapshots = [];
  const updater = createDesktopUpdater({
    adapter,
    currentVersion: "3.0.0",
    onSnapshot: (value) => snapshots.push(value),
    prepareInstall: async () => true,
    schedule: (callback) => {
      scheduled = callback;
      return 1;
    },
    cancel: () => {
      scheduled = undefined;
    },
    ...overrides,
  });
  return {
    adapter,
    updater,
    snapshots,
    downloads: () => downloads,
    installs: () => installs,
    finish: async () => {
      scheduled();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("release check never downloads; explicit install responds before quiescence and restart", async () => {
  const calls = [];
  const state = setup({
    prepareInstall: async () => {
      calls.push("quiesce");
      return true;
    },
  });
  assert.equal(state.adapter.autoDownload, false);
  assert.equal(state.adapter.autoInstallOnAppQuit, false);
  assert.equal((await state.updater.checkForUpdates()).latestVersion, "3.1.0");
  assert.equal(state.downloads(), 0);
  assert.deepEqual(await state.updater.installUpdate(), { ok: true, action: "restart" });
  assert.equal(state.installs(), 0);
  assert.deepEqual(calls, []);
  assert.equal(state.updater.getSnapshot().stage, "waiting");
  await state.finish();
  assert.deepEqual(calls, ["quiesce"]);
  assert.equal(state.installs(), 1);
  assert.equal(state.updater.getSnapshot().status, "restart_pending");
  assert.ok(state.snapshots.some((value) => value.downloadPercent === 42));
  state.updater.dispose();
});

test("Chat becoming busy during download defers installation and preserves downloaded artifact", async () => {
  let busy = true;
  const state = setup({
    prepareInstall: async () => (busy ? { ok: false, error: "Chat is active" } : true),
  });
  await state.updater.installUpdate();
  await state.finish();
  assert.equal(state.installs(), 0);
  assert.equal(state.updater.getSnapshot().status, "available");
  assert.equal(state.updater.getSnapshot().error, "Chat is active");
  busy = false;
  await state.updater.installUpdate();
  await state.finish();
  assert.equal(state.downloads(), 1);
  assert.equal(state.installs(), 1);
  state.updater.dispose();
});

test("failed signature or download cannot invoke installation", async () => {
  const state = setup();
  state.adapter.downloadUpdate = async () => {
    throw new Error("Signature invalid");
  };
  const result = await state.updater.installUpdate();
  assert.equal(result.ok, false);
  assert.equal(result.error, "Signature invalid");
  assert.equal(state.installs(), 0);
  assert.equal(state.updater.getSnapshot().status, "error");
  state.updater.dispose();
});

test("concurrent install requests download once and schedule one restart", async () => {
  const state = setup();
  await state.updater.checkForUpdates();
  const results = await Promise.all([state.updater.installUpdate(), state.updater.installUpdate()]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(state.downloads(), 1);
  await state.finish();
  assert.equal(state.installs(), 1);
  state.updater.dispose();
});

test("unavailable install and failed backend preparation never quit", async () => {
  const unavailable = setup({ enabled: false });
  assert.equal((await unavailable.updater.installUpdate()).ok, false);
  assert.equal(unavailable.downloads(), 0);
  unavailable.updater.dispose();
  const state = setup({
    prepareInstall: async () => {
      throw new Error("Backend unavailable");
    },
  });
  await state.updater.installUpdate();
  await state.finish();
  assert.equal(state.installs(), 0);
  assert.equal(state.updater.getSnapshot().error, "Backend unavailable");
  state.updater.dispose();
});

test("asynchronous native installer failure restores the quiesced backend once", async () => {
  let recovered = 0;
  const state = setup({
    onInstallError: async () => {
      recovered++;
    },
  });
  await state.updater.installUpdate();
  await state.finish();
  state.adapter.emit("error", new Error("Squirrel signature rejected"));
  state.adapter.emit("error", new Error("Squirrel stopped"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recovered, 1);
  assert.equal(state.updater.getSnapshot().status, "error");
  state.updater.dispose();
});
