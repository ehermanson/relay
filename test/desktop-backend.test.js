import "./test-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import { createRelay, resolveConfig } from "../dist/server/index.js";

test("desktop listener uses loopback, discovers its assigned port, and requires authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-desktop-test-"));
  const relay = createRelay({
    host: "127.0.0.1",
    port: 0,
    password: "desktop-test-secret",
    sessionFile: join(directory, "auth.json"),
    dbPath: join(directory, "sessions.db"),
    providerDirs: { claude: join(directory, "claude"), codex: join(directory, "codex") },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  // This integration checks transport/auth; provider initialization must not
  // launch a user's installed CLIs or scan their transcripts.
  relay.instanceManager.initSdkProvider = async () => {};
  relay.instanceManager.initCodexProvider = () => {};
  relay.instanceManager.scanInBackground = async () => {};
  relay.instanceManager.startDiscovery = () => {};
  try {
    assert.equal(relay.address, null);
    await relay.start();
    assert.equal(relay.address.address, "127.0.0.1");
    assert.ok(relay.address.port > 0);
    assert.equal(relay.config.port, relay.address.port);
    const url = `http://127.0.0.1:${relay.address.port}`;
    assert.equal((await fetch(`${url}/api/stats`)).status, 401);
    const login = await fetch(`${url}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "desktop-test-secret" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${url}/api/stats`, { headers: { cookie } })).status, 200);
    const managed = { info: { id: "update-probe", status: "processing" } };
    relay.instanceManager.instances.set("update-probe", managed);
    assert.equal(relay.getRuntimeStatus().activeCount, 1);
    assert.equal(relay.quiesceForUpdate(), false, "running managed work blocks updates");
    managed.info.status = "idle";
    managed.info.pendingPermission = { requestId: "permission" };
    assert.equal(relay.getRuntimeStatus().pendingCount, 1);
    assert.equal(relay.quiesceForUpdate(), false, "pending input blocks updates");
    relay.instanceManager.instances.delete("update-probe");
    assert.equal(relay.quiesceForUpdate(), true);
    const quiescedStatus = await new Promise((resolve, reject) => {
      http
        .get(`${url}/api/stats`, { headers: { cookie }, agent: false }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on("error", reject);
    });
    assert.equal(
      quiescedStatus,
      503,
      "quiescing prevents new HTTP work before the update acknowledgement",
    );
    assert.throws(() => relay.instanceManager.createInstance(), /restarting/);
    await assert.rejects(relay.instanceManager.sendMessage("any", "new work"), /restarting/);
  } finally {
    if (relay.address) await relay.stop();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(relay.address, null);
});

test("ordinary server options preserve the existing bind behavior", () => {
  assert.equal(resolveConfig({}).host, undefined);
  assert.equal(resolveConfig({ host: "127.0.0.1", port: 0 }).port, 0);
});

test("deferred history work cannot start discovery after desktop shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-desktop-scan-test-"));
  const relay = createRelay({
    host: "127.0.0.1",
    port: 0,
    backgroundStartupDelayMs: 25,
    sessionFile: join(directory, "auth.json"),
    dbPath: join(directory, "sessions.db"),
    providerDirs: { claude: join(directory, "claude"), codex: join(directory, "codex") },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  let scans = 0;
  let discoveries = 0;
  relay.instanceManager.initSdkProvider = async () => {};
  relay.instanceManager.initCodexProvider = () => {};
  relay.instanceManager.scanInBackground = async () => {
    scans++;
  };
  relay.instanceManager.startDiscovery = () => {
    discoveries++;
  };
  try {
    await relay.start();
    await relay.stop();
    await delay(50);
    assert.equal(scans, 0);
    assert.equal(discoveries, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
