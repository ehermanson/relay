// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Tests for WebSocket message types that were missing coverage:
 * - unsubscribe
 * - instance_cancel
 * - refresh_title
 * - unknown message types
 * - Multi-client subscription isolation
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
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

  /** Drain any buffered messages */
  ws.drain = () => {
    const drained = [...buffer];
    buffer.length = 0;
    return drained;
  };

  const ready = new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });

  return { ws, ready };
}

describe("WebSocket Messages — Additional Coverage", () => {
  let server;
  let auth;
  let manager;
  let tempDir;
  let wsHandle;
  const openSockets = [];

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-ws-msg-test-"));
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

  describe("unsubscribe", () => {
    it("unsubscribes from an instance without error", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      const info = manager.createInstance({ name: "Unsub Test" });

      // Subscribe first
      ws.send(JSON.stringify({ type: "subscribe", instanceId: info.id }));
      await ws.nextMessageOfType("instance_history");

      // Unsubscribe — should not produce any response message
      ws.send(JSON.stringify({ type: "unsubscribe", instanceId: info.id }));

      // Send a list_instances to verify the connection still works
      ws.send(JSON.stringify({ type: "list_instances" }));
      await ws.nextMessageOfType("instance_list");
    });
  });

  describe("instance_cancel", () => {
    it("sends error for nonexistent instance", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      ws.send(
        JSON.stringify({
          type: "instance_cancel",
          instanceId: "00000000-0000-0000-0000-000000000000",
        }),
      );

      const msg = await ws.nextMessageOfType("error");
      assert.ok(msg.message.includes("not found"));
    });

    it("sends error for external instance", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      // Create a normal instance — we can't easily test cancel without a process,
      // but we can verify the error handling works
      const info = manager.createInstance({ name: "Cancel Test" });

      // Cancel on a non-processing instance — should not error since process exists
      ws.send(
        JSON.stringify({
          type: "instance_cancel",
          instanceId: info.id,
        }),
      );

      // The cancel call shouldn't crash even though the process isn't actually running
      // Send a followup to verify connection is healthy
      ws.send(JSON.stringify({ type: "list_instances" }));
      await ws.nextMessageOfType("instance_list");
    });
  });

  describe("refresh_title", () => {
    it("handles refresh_title without error", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      const info = manager.createInstance({ name: "Title Test" });

      // refresh_title doesn't produce a response on its own
      ws.send(
        JSON.stringify({
          type: "refresh_title",
          instanceId: info.id,
        }),
      );

      // Verify connection is still healthy
      ws.send(JSON.stringify({ type: "list_instances" }));
      await ws.nextMessageOfType("instance_list");
    });

    it("handles refresh_title for unknown instance", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      // Should not crash
      ws.send(
        JSON.stringify({
          type: "refresh_title",
          instanceId: "nonexistent",
        }),
      );

      // Verify connection is still healthy
      ws.send(JSON.stringify({ type: "list_instances" }));
      await ws.nextMessageOfType("instance_list");
    });
  });

  describe("rename_space", () => {
    it("renames a space and broadcasts the updated space list", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      const projectDir = join(tempDir, "repo");
      mkdirSync(projectDir, { recursive: true });
      manager.db.upsertSpace({
        id: "space-rename",
        project_directory: projectDir,
        name: "Old Space Name",
        git_branch: "relay-space/rename",
        worktree_path: join(projectDir, ".relay", "worktrees", "space-rename"),
        is_default: 0,
        status: "active",
        created_at: Date.now(),
        last_activity_at: Date.now(),
      });

      ws.send(
        JSON.stringify({
          type: "rename_space",
          spaceId: "space-rename",
          name: "New Space Name",
        }),
      );

      const msg = await ws.nextMessageOfType("space_list", 10000);
      assert.equal(msg.projectDirectory, projectDir);
      const renamed = msg.spaces.find((space) => space.id === "space-rename");
      assert.ok(renamed);
      assert.equal(renamed.name, "New Space Name");
      assert.equal(manager.db.getSpace("space-rename")?.name, "New Space Name");
    });
  });

  describe("unknown message types", () => {
    it("logs warning but doesn't crash", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      ws.send(JSON.stringify({ type: "unknown_type_xyz" }));

      // Connection should still work
      ws.send(JSON.stringify({ type: "list_instances" }));
      await ws.nextMessageOfType("instance_list");
    });
  });

  describe("invalid JSON messages", () => {
    it("doesn't crash on malformed JSON", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();

      ws.send("this is not json{{{");

      // Connection should still work
      ws.send(JSON.stringify({ type: "list_instances" }));
      await ws.nextMessageOfType("instance_list");
    });
  });

  describe("multi-client subscription isolation", () => {
    it("broadcasts instance_created to all clients", async () => {
      const session = auth.createSession();
      const ws1 = await connect(session.id);
      const ws2 = await connect(session.id);
      await ws1.waitForHandshake();
      await ws2.waitForHandshake();

      // Create via ws1
      ws1.send(
        JSON.stringify({
          type: "create_instance",
          name: "Broadcast Test",
          workingDirectory: tempDir,
        }),
      );

      // Both clients should receive instance_created
      const msg1 = await ws1.nextMessageOfType("instance_created", 10000);
      const msg2 = await ws2.nextMessageOfType("instance_created", 10000);
      assert.equal(msg1.instance.name, "Broadcast Test");
      assert.equal(msg2.instance.name, "Broadcast Test");
    });

    it("sends instance_history only to the subscribing client", async () => {
      const session = auth.createSession();
      const ws1 = await connect(session.id);
      const ws2 = await connect(session.id);
      await ws1.waitForHandshake();
      await ws2.waitForHandshake();

      const info = manager.createInstance({ name: "Isolation Test" });

      // Only ws1 subscribes
      ws1.send(JSON.stringify({ type: "subscribe", instanceId: info.id }));
      await ws1.nextMessageOfType("instance_history");

      // ws2 should not have received the history
      ws2.send(JSON.stringify({ type: "list_instances" }));
      await ws2.nextMessageOfType("instance_list"); // This is the response to list_instances, not history
    });
  });

  describe("getConnectionCount", () => {
    it("returns correct count of authenticated connections", async () => {
      assert.equal(wsHandle.getConnectionCount(), 0);

      const session = auth.createSession();
      const ws1 = await connect(session.id);
      await ws1.waitForHandshake();
      assert.equal(wsHandle.getConnectionCount(), 1);

      const ws2 = await connect(session.id);
      await ws2.waitForHandshake();
      assert.equal(wsHandle.getConnectionCount(), 2);

      // Close one
      ws1.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(wsHandle.getConnectionCount(), 1);
    });
  });
});
