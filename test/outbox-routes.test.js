import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequestHandler } from "../dist/server/http.js";
import { AuthManager } from "../dist/server/auth.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const id = (last) => `00000000-0000-4000-8000-${String(last).padStart(12, "0")}`;

async function request(server, method, path, cookie, body) {
  const url = `http://127.0.0.1:${server.address().port}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

describe("outbox HTTP delivery", () => {
  const resources = [];
  afterEach(async () => {
    for (const { server, manager, dir } of resources.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
      manager.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches each ID once and distinguishes busy, uncertain, invalid, and unauthenticated sends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-outbox-route-"));
    const config = resolveConfig({
      password: "testpass",
      logger,
      serveUI: false,
      sessionFile: join(dir, "auth.json"),
      dbPath: join(dir, "sessions.db"),
      providerDirs: { claude: join(dir, ".claude"), codex: join(dir, ".codex") },
    });
    const auth = new AuthManager(config);
    const manager = new InstanceManager(config);
    const instance = {
      id: "chat-1",
      provider: "codex",
      status: "idle",
      name: "Test",
      workingDirectory: dir,
    };
    manager.getInstance = () => instance;
    const dispatches = [];
    manager.sendMessage = async (...args) => {
      dispatches.push(args);
    };
    const server = http.createServer(createRequestHandler(config, auth, manager));
    await new Promise((resolve) => server.listen(0, resolve));
    resources.push({ server, manager, dir });
    const cookie = `session=${auth.createSession().id}`;
    const body = { instanceId: "chat-1", text: "hello" };

    assert.equal((await request(server, "POST", `/api/outbox/${id(1)}`, null, body)).status, 401);
    assert.equal(
      (
        await request(server, "POST", `/api/outbox/${id(1)}`, cookie, {
          instanceId: "chat-1",
          text: "",
        })
      ).status,
      400,
    );
    assert.deepEqual((await request(server, "POST", `/api/outbox/${id(1)}`, cookie, body)).body, {
      state: "accepted",
    });
    assert.deepEqual((await request(server, "POST", `/api/outbox/${id(1)}`, cookie, body)).body, {
      state: "accepted",
    });
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0][5], false, "outbox must not enter the in-memory mid-turn queue");
    assert.equal(
      (await request(server, "GET", `/api/outbox/${id(1)}`, cookie)).body.state,
      "accepted",
    );

    manager.sessionDb.reserveOutboxReceipt(id(2), "chat-1");
    assert.deepEqual(await request(server, "POST", `/api/outbox/${id(2)}`, cookie, body), {
      status: 409,
      body: { state: "uncertain" },
    });
    assert.equal(dispatches.length, 1);

    manager.sendMessage = async () => {
      throw new Error("Chat is busy; try again when the current turn finishes");
    };
    assert.deepEqual(await request(server, "POST", `/api/outbox/${id(3)}`, cookie, body), {
      status: 409,
      body: { state: "busy" },
    });
    assert.equal(manager.sessionDb.getOutboxReceipt(id(3)), null);

    manager.sendMessage = async () => {
      throw new Error("Chat needs input before sending another message");
    };
    assert.deepEqual(await request(server, "POST", `/api/outbox/${id(4)}`, cookie, body), {
      status: 409,
      body: { state: "busy" },
    });
    assert.equal(manager.sessionDb.getOutboxReceipt(id(4)), null);
  });
});
