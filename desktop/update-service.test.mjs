import "../test/test-env.js";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { createBackendUpdateService } from "./update-service.mjs";

function port() {
  const parent = new EventEmitter();
  parent.sent = [];
  parent.postMessage = (value) => parent.sent.push(value);
  parent.receive = (value) => parent.emit("message", { data: value });
  return parent;
}

test("native updates use correlated IPC while snapshots remain synchronously available to HTTP", async () => {
  const parent = port();
  const service = await createBackendUpdateService({
    parent,
    startMessage: { packaged: true, updateSnapshot: { status: "idle" } },
  });
  const check = service.checkForUpdates({ force: true });
  const install = service.installUpdate();
  assert.equal(parent.sent[0].operation, "check");
  assert.equal(parent.sent[0].force, true);
  assert.notEqual(parent.sent[0].id, parent.sent[1].id);
  parent.receive({ type: "update-snapshot", snapshot: { status: "available" } });
  assert.equal(service.getSnapshot().status, "available");
  parent.receive({ type: "update-result", id: parent.sent[1].id, result: { ok: true } });
  parent.receive({ type: "update-result", id: parent.sent[0].id, result: { status: "available" } });
  assert.deepEqual(await install, { ok: true });
  assert.deepEqual(await check, { status: "available" });
});

async function source({ status = "", branch = "main", busy = false } = {}) {
  const parent = port();
  let installations = 0;
  const service = await createBackendUpdateService({
    parent,
    startMessage: { packaged: false, currentVersion: "3.0.0" },
    installDir: "/isolated",
    getRuntimeStatus: () => ({ activeCount: busy ? 1 : 0, pendingCount: 0, terminalCount: 0 }),
    runCommand: async (_command, args) => ({ stdout: args[0] === "status" ? status : branch }),
    createSourceManager: async () => ({
      init: async () => {},
      getSnapshot: () => ({ enabled: true, status: "available" }),
      checkForUpdates: async () => {},
      installUpdate: async () => {
        installations++;
        return { ok: true, action: "restart" };
      },
    }),
  });
  return { service, installations: () => installations };
}

test("a deferred source restart reports waiting and a retry re-requests the relaunch", async () => {
  const parent = port();
  let requestRestart;
  const service = await createBackendUpdateService({
    parent,
    startMessage: { packaged: false, currentVersion: "3.0.0" },
    installDir: "/isolated",
    getRuntimeStatus: () => ({ activeCount: 0, pendingCount: 0, terminalCount: 0 }),
    runCommand: async () => ({ stdout: "" }),
    createSourceManager: async (options) => {
      requestRestart = options.requestRestart;
      return {
        init: async () => {},
        getSnapshot: () => ({ enabled: true, status: "idle" }),
        checkForUpdates: async () => {},
        installUpdate: async () => ({ ok: true, action: "restart" }),
      };
    },
  });
  const restarts = () => parent.sent.filter((m) => m.type === "source-update-restart").length;
  requestRestart();
  assert.equal(restarts(), 1);
  parent.receive({ type: "source-update-deferred", error: "Chats are still running" });
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.stage, "waiting");
  assert.equal(snapshot.updateAvailable, true);
  assert.equal(snapshot.error, "Chats are still running");
  assert.deepEqual(await service.installUpdate(), { ok: true, action: "restart" });
  assert.equal(service.getSnapshot().status, "idle");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(restarts(), 2);
});

test("source updates refuse busy Chats, dirty working trees and feature branches", async () => {
  for (const options of [
    { busy: true },
    { status: " M desktop/main.mjs" },
    { branch: "feature/native" },
  ]) {
    const state = await source(options);
    assert.equal((await state.service.installUpdate()).ok, false);
    assert.equal(state.installations(), 0);
  }
  const state = await source();
  assert.equal((await state.service.installUpdate()).ok, true);
  assert.equal(state.installations(), 1);
  assert.equal(state.service.getSnapshot().distribution, "source");
});
