// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { createRequestHandler } from "../dist/server/http.js";
import { createWebSocketServer } from "../dist/server/websocket.js";
import { AuthManager } from "../dist/server/auth.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import { addWSHelpers } from "./helpers.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Create a connected WebSocket with message buffering.
 * Starts buffering messages immediately so none are lost between
 * the connection opening and test code reading them.
 */
function createClient(server, sessionId) {
  const port = server.address().port;
  const headers = sessionId ? { Cookie: `session=${sessionId}` } : {};
  const ws = new WebSocket(`ws://localhost:${port}`, { headers });

  const buffer = [];
  const waiters = [];

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (waiters.length > 0) {
      waiters.shift()(msg);
    } else {
      buffer.push(msg);
    }
  });

  /** Wait for and return the next message (from buffer or future). */
  ws.nextMessage = (timeoutMs = 5000) => {
    if (buffer.length > 0) {
      return Promise.resolve(buffer.shift());
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for message")),
        timeoutMs,
      );
      waiters.push((msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });
    });
  };

  addWSHelpers(ws);

  const ready = new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });

  return { ws, ready };
}

describe("WebSocket Server", () => {
  let server;
  let auth;
  let manager;
  let tempDir;
  let wsHandle;
  const openSockets = [];

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-ws-test-"));
    const config = resolveConfig({
      password: "testpass",
      logger: noopLogger,
      maxProcesses: 5,
      serveUI: false,
      rateLimitMax: 10,
      rateLimitWindow: 60_000,
      sessionFile: join(tempDir, "sessions.json"),
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: join(tempDir, ".claude"),
        codex: join(tempDir, ".codex"),
      },
    });
    auth = new AuthManager(config);
    manager = new InstanceManager(config);
    manager.projectManager.addProject(process.cwd());
    const handler = createRequestHandler(config, auth, manager);
    server = http.createServer(handler);
    wsHandle = createWebSocketServer(server, manager, auth, config);
    server.listen(0, done);
  });

  afterEach((_, done) => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets.length = 0;
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
    wsHandle.wss.close(() => {
      server.close(done);
    });
  });

  function connect(sessionId) {
    const { ws, ready } = createClient(server, sessionId);
    openSockets.push(ws);
    return ready;
  }

  describe("Authentication", () => {
    it("rejects connection without auth cookie (close code 4001)", async () => {
      const port = server.address().port;
      const ws = new WebSocket(`ws://localhost:${port}`);
      openSockets.push(ws);

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for close")), 5000);
        ws.on("close", (code) => {
          clearTimeout(timeout);
          assert.equal(code, 4001);
          resolve();
        });
        ws.on("error", () => {});
      });
    });

    it("accepts connection with valid auth and sends connected + instance_list", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      const messages = await ws.waitForHandshake();
      assert.equal(messages[0].type, "connected");
      assert.equal(messages[1].type, "instance_list");
      assert.ok(Array.isArray(messages[1].instances));
      assert.ok(messages.some((msg) => msg.type === "projects_changed"));
    });
  });

  describe("create_instance", () => {
    it("creates an instance and broadcasts instance_created", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      ws.send(
        JSON.stringify({
          type: "create_instance",
          name: "WS Test",
          workingDirectory: tempDir,
        }),
      );

      const msg = await ws.nextMessageOfType("instance_created", 10000);
      assert.equal(msg.instance.name, "WS Test");
      assert.ok(msg.instance.id);
    });

    it("forwards provider selection from the websocket payload", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      ws.send(
        JSON.stringify({
          type: "create_instance",
          name: "Codex Test",
          provider: "codex",
          workingDirectory: tempDir,
        }),
      );

      const msg = await ws.nextMessageOfType("instance_created", 10000);
      assert.equal(msg.instance.name, "Codex Test");
      assert.equal(msg.instance.provider, "codex");
    });

    it("returns a structured max_processes error when the cap is reached", async () => {
      // Tighten the cap to 1 and fill it, so the WS create hits the limit.
      manager.sessionDb.updateGlobalSettings({ max_processes: 1 });
      manager.createInstance({ name: "Filler" });

      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      ws.send(
        JSON.stringify({
          type: "create_instance",
          name: "Over Cap",
          workingDirectory: tempDir,
        }),
      );

      const msg = await ws.nextMessageOfType("error", 10000);
      assert.equal(msg.code, "max_processes");
      assert.equal(msg.limit, 1);
      // The failed request is echoed so the client can retry after freeing a slot.
      assert.equal(msg.createRequest.workingDirectory, tempDir);
      assert.equal(msg.createRequest.name, "Over Cap");
    });
  });

  describe("subscribe", () => {
    it("subscribes to an instance and receives instance_history", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      // Create instance directly (no broadcast emitted for managed instances)
      const info = manager.createInstance({ name: "Sub Test" });

      ws.send(JSON.stringify({ type: "subscribe", instanceId: info.id }));

      const msg = await ws.nextMessageOfType("instance_history");
      assert.equal(msg.instanceId, info.id);
      assert.ok(Array.isArray(msg.history));
      assert.equal(msg.replayMode, "full");
    });

    it("replays only missed instance events when subscribing with a cursor", async () => {
      const session = auth.createSession();
      const ws1 = await connect(session.id);
      await ws1.waitForHandshake();

      const info = manager.createInstance({ name: "Replay Test" });

      ws1.send(JSON.stringify({ type: "subscribe", instanceId: info.id }));
      const firstHistory = await ws1.nextMessageOfType("instance_history");

      manager.emit("instance:output", info.id, {
        type: "output",
        text: "first chunk",
        isWaiting: false,
      });
      const first = await ws1.nextMessageOfType("output");
      assert.equal(first.eventSequence, 1);

      ws1.close();

      manager.emit("instance:output", info.id, {
        type: "output",
        text: "second chunk",
        isWaiting: false,
      });

      const ws2 = await connect(session.id);
      await ws2.waitForHandshake();
      ws2.send(
        JSON.stringify({
          type: "subscribe",
          instanceId: info.id,
          lastSeenSequence: first.eventSequence,
          replayEpoch: firstHistory.replayEpoch,
        }),
      );

      const replayAck = await ws2.nextMessageOfType("instance_history");
      assert.equal(replayAck.replayMode, "delta");
      assert.equal(replayAck.latestSequence, 2);
      assert.equal(replayAck.replayEpoch, firstHistory.replayEpoch);
      assert.deepEqual(replayAck.history, []);

      const replayed = await ws2.nextMessageOfType("output");
      assert.equal(replayed.text, "second chunk");
      assert.equal(replayed.eventSequence, 2);
    });

    it("falls back to full replay when the replay epoch is stale", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      const info = manager.createInstance({ name: "Stale Epoch Test" });

      ws.send(
        JSON.stringify({
          type: "subscribe",
          instanceId: info.id,
          lastSeenSequence: 5,
          replayEpoch: 123,
        }),
      );

      const msg = await ws.nextMessageOfType("instance_history");
      assert.equal(msg.replayMode, "full");
      assert.ok(Array.isArray(msg.history));
      assert.notEqual(msg.replayEpoch, 123);
    });
  });

  describe("list_instances", () => {
    it("returns instance_list on request", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      // Create instances directly (no broadcasts for managed instances)
      manager.createInstance({ name: "A" });
      manager.createInstance({ name: "B" });

      ws.send(JSON.stringify({ type: "list_instances" }));

      const msg = await ws.nextMessageOfType("instance_list");
      assert.equal(msg.instances.length, 2);
    });
  });

  describe("remove_instance", () => {
    it("removes an instance and broadcasts instance_removed", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      // Create instance directly
      const info = manager.createInstance({ name: "ToRemove" });

      ws.send(JSON.stringify({ type: "remove_instance", instanceId: info.id }));

      const msg = await ws.nextMessageOfType("instance_removed");
      assert.equal(msg.instanceId, info.id);
      assert.equal(manager.listInstances().length, 0);
    });

    it("sends error for non-existent instance", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      ws.send(
        JSON.stringify({
          type: "remove_instance",
          instanceId: "00000000-0000-0000-0000-000000000000",
        }),
      );

      const msg = await ws.nextMessage();
      assert.equal(msg.type, "error");
      assert.ok(msg.message.includes("not found"));
    });

    it("purges an instance and broadcasts instance_removed", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      const info = manager.createInstance({ name: "ToPurge" });

      ws.send(JSON.stringify({ type: "purge_instance", instanceId: info.id }));

      const msg = await ws.nextMessageOfType("instance_removed");
      assert.equal(msg.instanceId, info.id);
      assert.equal(manager.listInstances().length, 0);
    });
  });
});
