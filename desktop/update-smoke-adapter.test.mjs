import "../test/test-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopUpdater } from "./updater.mjs";
import { createUpdateSmokeAdapter } from "./update-smoke-adapter.mjs";

test("synthetic installer exercises deferred failure after backend quiescence and restores runtime", async () => {
  const adapter = createUpdateSmokeAdapter({ failureDelayMs: 1 });
  let backendRunning = true;
  let recoveries = 0;
  let triggerInstall;
  const updater = createDesktopUpdater({
    adapter,
    currentVersion: "3.0.0",
    prepareInstall: async () => {
      backendRunning = false;
      return { ok: true };
    },
    install: () => {
      assert.equal(backendRunning, false);
      adapter.quitAndInstall(false, true);
    },
    onInstallError: async (error) => {
      assert.equal(error.code, "RELAY_SMOKE_INSTALL_REJECTED");
      recoveries++;
      backendRunning = true;
    },
    schedule: (callback) => {
      triggerInstall = callback;
      return 1;
    },
    cancel: () => {},
  });
  await updater.checkForUpdates();
  assert.equal((await updater.installUpdate()).ok, true);
  assert.equal(backendRunning, true, "HTTP result is available before quiescence");
  triggerInstall();
  await adapter.waitForFailure();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backendRunning, true);
  assert.equal(recoveries, 1);
  assert.equal(updater.getSnapshot().status, "error");
  assert.deepEqual(adapter.getSmokeState(), {
    checks: 1,
    downloads: 1,
    installs: 1,
    failure: "RELAY_SMOKE_INSTALL_REJECTED",
    events: ["check", "download", "install", "installer-error"],
  });
  updater.dispose();
  adapter.dispose();
});

test("smoke observer fails clearly if native install never happens and disposal releases waiters", async () => {
  const adapter = createUpdateSmokeAdapter();
  await assert.rejects(adapter.waitForFailure(1), /not attempted/);
  const pending = adapter.waitForFailure();
  adapter.dispose();
  await assert.rejects(pending, /disposed/);
  assert.throws(() => adapter.quitAndInstall(), /without a downloaded update/);
});
