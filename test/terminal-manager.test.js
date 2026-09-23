// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Unit tests for TerminalManager.
 *
 * Uses a mock PtyAdapterFactory so no real PTY is spawned.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { TerminalManager } from "../dist/server/core/terminal-manager.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/** Minimal mock PtyProcess that lets tests drive data/exit events. */
class MockPty extends EventEmitter {
  pid = 999;
  written = [];
  resizes = [];
  killed = false;

  write(data) {
    this.written.push(data);
  }
  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }
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

describe("TerminalManager", () => {
  let tm;
  let ptys;

  const spaceScope = { type: "space", spaceId: "sp-1" };
  const instanceScope = { type: "instance", instanceId: "inst-1" };

  beforeEach(() => {
    const mock = createMockFactory();
    ptys = mock.ptys;
    tm = new TerminalManager(mock.factory, noopLogger);
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  describe("createTerminal", () => {
    it("creates a terminal and emits terminal:created", () => {
      const events = [];
      tm.on("terminal:created", (info) => events.push(info));

      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });

      assert.ok(info.id);
      assert.equal(info.scope, spaceScope);
      assert.equal(info.cwd, "/tmp");
      assert.equal(info.exited, false);
      assert.equal(events.length, 1);
      assert.equal(events[0].id, info.id);
    });

    it("uses default cols/rows when not specified", () => {
      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });
      assert.equal(info.cols, 120);
      assert.equal(info.rows, 30);
    });

    it("uses custom cols/rows when specified", () => {
      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 80, rows: 24 });
      assert.equal(info.cols, 80);
      assert.equal(info.rows, 24);
    });
  });

  describe("writeTerminal", () => {
    it("writes data to the PTY", () => {
      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });
      tm.writeTerminal(info.id, "ls\n");
      assert.deepEqual(ptys[0].written, ["ls\n"]);
    });

    it("silently ignores writes to nonexistent terminals", () => {
      assert.doesNotThrow(() => tm.writeTerminal("nonexistent", "data"));
    });
  });

  describe("resizeTerminal", () => {
    it("resizes the PTY and updates info", () => {
      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      tm.resizeTerminal(info.id, 200, 50);
      assert.deepEqual(ptys[0].resizes, [{ cols: 200, rows: 50 }]);

      const updated = tm.getTerminal(info.id);
      assert.equal(updated.cols, 200);
      assert.equal(updated.rows, 50);
    });
  });

  describe("closeTerminal", () => {
    it("kills the PTY and emits terminal:removed", () => {
      const events = [];
      tm.on("terminal:removed", (id) => events.push(id));

      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      tm.closeTerminal(info.id);

      assert.ok(ptys[0].killed);
      assert.equal(events.length, 1);
      assert.equal(events[0], info.id);
      assert.equal(tm.getTerminal(info.id), undefined);
    });

    it("does not kill an already-exited PTY", () => {
      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      // Simulate exit
      ptys[0].emit("exit", 0);
      ptys[0].killed = false; // reset
      tm.closeTerminal(info.id);
      assert.equal(ptys[0].killed, false);
    });

    it("silently ignores closing nonexistent terminals", () => {
      assert.doesNotThrow(() => tm.closeTerminal("nonexistent"));
    });
  });

  // ── PTY events ─────────────────────────────────────────────────────

  describe("PTY data events", () => {
    it("emits terminal:output when PTY produces data", () => {
      const events = [];
      tm.on("terminal:output", (id, data) => events.push({ id, data }));

      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      ptys[0].emit("data", "hello world");

      assert.equal(events.length, 1);
      assert.equal(events[0].id, info.id);
      assert.equal(events[0].data, "hello world");
    });
  });

  describe("PTY exit events", () => {
    it("emits terminal:exit and marks info as exited", () => {
      const events = [];
      tm.on("terminal:exit", (id, code, signal) => events.push({ id, code, signal }));

      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      ptys[0].emit("exit", 1, "SIGTERM");

      assert.equal(events.length, 1);
      assert.equal(events[0].code, 1);
      assert.equal(events[0].signal, "SIGTERM");

      const updated = tm.getTerminal(info.id);
      assert.equal(updated.exited, true);
      assert.equal(updated.exitCode, 1);
    });
  });

  // ── Scrollback ─────────────────────────────────────────────────────

  describe("scrollback", () => {
    it("accumulates output data", () => {
      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      ptys[0].emit("data", "line1\n");
      ptys[0].emit("data", "line2\n");

      const sb = tm.getScrollback(info.id);
      assert.equal(sb, "line1\nline2\n");
    });

    it("returns empty string for nonexistent terminal", () => {
      assert.equal(tm.getScrollback("nonexistent"), "");
    });

    it("trims old scrollback when exceeding limit", () => {
      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      // Push >512KB of data in chunks
      const chunk = "x".repeat(100 * 1024); // 100KB
      for (let i = 0; i < 7; i++) {
        ptys[0].emit("data", chunk);
      }
      const sb = tm.getScrollback(info.id);
      // Should be trimmed to roughly 512KB — always keeps at least 1 entry
      assert.ok(sb.length <= 600 * 1024, `scrollback too large: ${sb.length}`);
      assert.ok(sb.length > 0, "scrollback should not be empty");
    });
  });

  // ── Listing & scoping ──────────────────────────────────────────────

  describe("listTerminals", () => {
    it("lists all terminals when no scope given", () => {
      tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });
      tm.createTerminal({ scope: instanceScope, cwd: "/tmp" });

      const all = tm.listTerminals();
      assert.equal(all.length, 2);
    });

    it("filters by scope", () => {
      tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });
      tm.createTerminal({ scope: instanceScope, cwd: "/tmp" });

      const spaceOnly = tm.listTerminals(spaceScope);
      assert.equal(spaceOnly.length, 1);
      assert.equal(spaceOnly[0].scope.type, "space");

      const instanceOnly = tm.listTerminals(instanceScope);
      assert.equal(instanceOnly.length, 1);
      assert.equal(instanceOnly[0].scope.type, "instance");
    });
  });

  // ── Scope cleanup ──────────────────────────────────────────────────

  describe("closeAllForScope", () => {
    it("closes all terminals matching the scope", () => {
      tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });
      tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });
      tm.createTerminal({ scope: instanceScope, cwd: "/tmp" });

      tm.closeAllForScope(spaceScope);

      assert.equal(tm.listTerminals(spaceScope).length, 0);
      assert.equal(tm.listTerminals(instanceScope).length, 1);
    });
  });

  describe("listActiveScopes", () => {
    it("groups live terminals by scope with counts", () => {
      tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });
      tm.createTerminal({ scope: spaceScope, cwd: "/tmp" });
      tm.createTerminal({ scope: instanceScope, cwd: "/tmp" });

      const scopes = tm.listActiveScopes();
      const space = scopes.find((s) => s.scope.type === "space");
      const instance = scopes.find((s) => s.scope.type === "instance");

      assert.equal(space.count, 2);
      assert.equal(space.scope.spaceId, "sp-1");
      assert.equal(instance.count, 1);
      assert.equal(instance.scope.instanceId, "inst-1");
    });

    it("excludes exited terminals from the live count", () => {
      const info = tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      ptys[0].emit("exit", 0);

      const scopes = tm.listActiveScopes();
      assert.equal(scopes.length, 1);
      assert.equal(scopes[0].count, 1);

      // Closing the last live terminal drops the scope entirely.
      tm.closeTerminal(info.id);
      const remaining = tm.listActiveScopes().find((s) => s.scope.type === "space");
      assert.equal(remaining.count, 1);
    });

    it("returns an empty array when there are no terminals", () => {
      assert.deepEqual(tm.listActiveScopes(), []);
    });
  });

  describe("closeAll", () => {
    it("closes every terminal", () => {
      tm.createTerminal({ scope: spaceScope, cwd: "/tmp", cols: 120, rows: 30 });
      tm.createTerminal({ scope: instanceScope, cwd: "/tmp", cols: 120, rows: 30 });

      tm.closeAll();

      assert.equal(tm.listTerminals().length, 0);
      assert.ok(ptys.every((p) => p.killed));
    });
  });
});
