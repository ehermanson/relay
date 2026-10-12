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

test("source updates refuse busy Chats, dirty working trees and feature Spaces", async () => {
  for (const options of [
    { busy: true },
    { status: " M desktop/main.mjs" },
    { branch: "space/native" },
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
