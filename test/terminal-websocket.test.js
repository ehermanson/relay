// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * WebSocket integration tests for terminal messages.
 *
 * Spins up a real HTTP + WS server with a TerminalManager backed by a
 * mock PTY factory, so no actual shells are spawned.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { createRequestHandler } from "../dist/server/http.js";
import { createWebSocketServer } from "../dist/server/websocket.js";
import { AuthManager } from "../dist/server/auth.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { TerminalManager } from "../dist/server/core/terminal-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import { addWSHelpers } from "./helpers.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

// ── Mock PTY ──────────────────────────────────────────────────────────

class MockPty extends EventEmitter {
  pid = 999;
  written = [];
  killed = false;

  write(data) {
    this.written.push(data);
  }
  resize() {}
  kill() {
    this.killed = true;
  }
}

function createMockFactory() {
  const ptys = [];
  const factory = (_opts) => {
    const pty = new MockPty();
    ptys.push(pty);
    return pty;
  };
  return { factory, ptys };
}

// ── Client helper (same pattern as websocket-messages.test.js) ──────

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

// ── Test suite ────────────────────────────────────────────────────────

describe("Terminal WebSocket Messages", () => {
  let server;
  let auth;
  let manager;
  let terminalManager;
  let tempDir;
  let wsHandle;
  let mockPtys;
  const openSockets = [];

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-terminal-ws-test-"));
    const config = resolveConfig({
      password: "testpass",
      logger: noopLogger,
      maxProcesses: 5,
      serveUI: false,
      rateLimitMax: 100,
      rateLimitWindow: 60_000,
      sessionFile: join(tempDir, "sessions.json"),
      dbPath: join(tempDir, "sessions.db"),
      claudeDir: join(tempDir, ".claude"),
      codexDir: join(tempDir, ".codex"),
    });
    auth = new AuthManager(config);
    manager = new InstanceManager(config);

    const mock = createMockFactory();
    mockPtys = mock.ptys;
    terminalManager = new TerminalManager(mock.factory, noopLogger);

    const handler = createRequestHandler(config, auth, manager);
    server = http.createServer(handler);
    wsHandle = createWebSocketServer(server, manager, auth, config, () => terminalManager);
    server.listen(0, done);
  });

  afterEach((_, done) => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets.length = 0;
    terminalManager.closeAll();
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

  /** Helper: connect, handshake, subscribe to an instance, return ws */
  async function connectAndSubscribe() {
    const session = auth.createSession();
    const info = manager.createInstance({ name: "Terminal Test" });
    const ws = await connect(session.id);
    await ws.waitForHandshake();
    ws.send(JSON.stringify({ type: "subscribe", instanceId: info.id }));
    await ws.nextMessageOfType("instance_history");
    return { ws, instance: info, session };
  }

  // ── terminal_create ────────────────────────────────────────────────

  describe("terminal_create", () => {
    it("creates a terminal and broadcasts terminal_created", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      const msg = await ws.nextMessageOfType("terminal_created");

      assert.equal(msg.terminal.scope.type, "instance");
      assert.equal(msg.terminal.scope.instanceId, instance.id);
      assert.equal(msg.terminal.exited, false);
      assert.ok(msg.terminal.id);
    });

    it("rejects creation for nonexistent instance scope", async () => {
      const { ws } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: "nonexistent" };

      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      const msg = await ws.nextMessageOfType("error");

      assert.ok(msg.message.includes("Unauthorized") || msg.message.includes("not found"));
    });

    it("respects ifEmpty — skips when terminal already exists", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      // Create first terminal normally
      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      await ws.nextMessageOfType("terminal_created");

      // Try with ifEmpty — should not create a second
      ws.send(JSON.stringify({ type: "terminal_create", scope, ifEmpty: true }));

      // Verify only 1 terminal exists by listing
      ws.send(JSON.stringify({ type: "terminal_list", scope }));
      const list = await ws.nextMessageOfType("terminal_list_response");
      assert.equal(list.terminals.length, 1);
    });

    it("ifEmpty creates when scope is empty", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_create", scope, ifEmpty: true }));
      const msg = await ws.nextMessageOfType("terminal_created");
      assert.ok(msg.terminal.id);
    });
  });

  // ── terminal_list ──────────────────────────────────────────────────

  describe("terminal_list", () => {
    it("returns terminals filtered by scope and echoes scope", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      await ws.nextMessageOfType("terminal_created");

      ws.send(JSON.stringify({ type: "terminal_list", scope }));
      const msg = await ws.nextMessageOfType("terminal_list_response");

      assert.equal(msg.scope.type, "instance");
      assert.equal(msg.scope.instanceId, instance.id);
      assert.equal(msg.terminals.length, 1);
    });

    it("returns empty array when no terminals exist", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_list", scope }));
      const msg = await ws.nextMessageOfType("terminal_list_response");

      assert.equal(msg.terminals.length, 0);
      assert.deepEqual(msg.scope, scope);
    });
  });

  // ── terminal_input ─────────────────────────────────────────────────

  describe("terminal_input", () => {
    it("writes data to the PTY", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      const created = await ws.nextMessageOfType("terminal_created");

      ws.send(
        JSON.stringify({
          type: "terminal_input",
          terminalId: created.terminal.id,
          data: "ls -la\n",
        }),
      );

      // Give it a tick to process
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(mockPtys[0].written.includes("ls -la\n"));
    });
  });

  // ── terminal_subscribe + scrollback ────────────────────────────────

  describe("terminal_subscribe", () => {
    it("sends scrollback on subscribe", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      const created = await ws.nextMessageOfType("terminal_created");

      // Push data through the mock PTY
      mockPtys[0].emit("data", "scrollback content\n");
      // Consume the terminal_output message
      await ws.nextMessageOfType("terminal_output");

      // Now subscribe from a fresh perspective — we're already auto-subscribed
      // from create, so unsubscribe first
      ws.send(
        JSON.stringify({
          type: "terminal_unsubscribe",
          terminalId: created.terminal.id,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      ws.send(
        JSON.stringify({
          type: "terminal_subscribe",
          terminalId: created.terminal.id,
        }),
      );
      const sb = await ws.nextMessageOfType("terminal_scrollback");
      assert.equal(sb.terminalId, created.terminal.id);
      assert.ok(sb.data.includes("scrollback content"));
    });
  });

  // ── terminal_output ────────────────────────────────────────────────

  describe("terminal_output", () => {
    it("relays PTY output to subscribed clients", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      await ws.nextMessageOfType("terminal_created");

      mockPtys[0].emit("data", "hello from pty\n");
      const msg = await ws.nextMessageOfType("terminal_output");

      assert.equal(msg.data, "hello from pty\n");
    });
  });

  // ── terminal_close ─────────────────────────────────────────────────

  describe("terminal_close", () => {
    it("closes the terminal and broadcasts terminal_removed", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      const created = await ws.nextMessageOfType("terminal_created");

      ws.send(
        JSON.stringify({
          type: "terminal_close",
          terminalId: created.terminal.id,
        }),
      );
      const msg = await ws.nextMessageOfType("terminal_removed");
      assert.equal(msg.terminalId, created.terminal.id);
    });
  });

  // ── terminal_exit ──────────────────────────────────────────────────

  describe("terminal_exit", () => {
    it("broadcasts exit code when PTY exits", async () => {
      const { ws, instance } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instance.id };

      ws.send(JSON.stringify({ type: "terminal_create", scope, cols: 120, rows: 30 }));
      await ws.nextMessageOfType("terminal_created");

      mockPtys[0].emit("exit", 42, "SIGKILL");
      const msg = await ws.nextMessageOfType("terminal_exit");

      assert.equal(msg.code, 42);
      assert.equal(msg.signal, "SIGKILL");
    });
  });

  // ── Authorization ──────────────────────────────────────────────────

  describe("authorization", () => {
    it("rejects terminal_input for a terminal the client doesn't own", async () => {
      // Client A creates a terminal
      const { ws: wsA, instance: instA } = await connectAndSubscribe();
      const scope = { type: "instance", instanceId: instA.id };
      wsA.send(JSON.stringify({ type: "terminal_create", scope }));
      const created = await wsA.nextMessageOfType("terminal_created");

      // Client B connects but subscribes to a different instance
      const session2 = auth.createSession();
      const inst2 = manager.createInstance({ name: "Other" });
      const wsB = await connect(session2.id);
      await wsB.waitForHandshake();
      wsB.send(JSON.stringify({ type: "subscribe", instanceId: inst2.id }));
      await wsB.nextMessageOfType("instance_history");

      // Client B tries to write to Client A's terminal
      wsB.send(
        JSON.stringify({
          type: "terminal_input",
          terminalId: created.terminal.id,
          data: "evil\n",
        }),
      );
      const err = await wsB.nextMessageOfType("error");
      assert.ok(err.message.includes("Unauthorized") || err.message.includes("not found"));
    });

    it("rejects terminal_list for unauthorized scope", async () => {
      const session = auth.createSession();
      const ws = await connect(session.id);
      await ws.waitForHandshake();
      // Don't subscribe to any instance — scope check should fail
      const scope = { type: "instance", instanceId: "nobody" };
      ws.send(JSON.stringify({ type: "terminal_list", scope }));
      const err = await ws.nextMessageOfType("error");
      assert.ok(err.message.includes("Unauthorized"));
    });
  });
});
