/**
 * Tests for the "Merge to main" feature:
 * - git.ts: await isWorktreeDirty(), await mergeWorktreeBranch()
 * - instance-manager.ts: mergeInstance()
 * - http.ts: POST /api/instances/:id/merge
 * - websocket.ts: merge_instance message
 */

import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cpSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { addWSHelpers } from "./helpers.js";
import { WebSocket } from "ws";
import {
  isWorktreeDirty,
  mergeWorktreeBranch,
  squashMergeBranch,
  createWorktree,
  removeWorktree,
  getCurrentBranch,
} from "../dist/server/core/git.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { createRequestHandler } from "../dist/server/http.js";
import { createWebSocketServer } from "../dist/server/websocket.js";
import { AuthManager } from "../dist/server/auth.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

let seedRepoDir;

function ensureSeedRepo() {
  if (seedRepoDir) return seedRepoDir;
  seedRepoDir = mkdtempSync(join(tmpdir(), "relay-merge-seed-"));
  execSync("git init -b main", { cwd: seedRepoDir, stdio: "pipe" });
  writeFileSync(join(seedRepoDir, "README.md"), "# Test\n");
  execSync("git add . && git commit -m initial", { cwd: seedRepoDir, stdio: "pipe" });
  return seedRepoDir;
}

function makeRepoDir() {
  const root = mkdtempSync(join(tmpdir(), "relay-merge-test-"));
  const dir = join(root, "repo");
  cpSync(ensureSeedRepo(), dir, { recursive: true });
  return dir;
}

// =============================================================================
// git.ts — isWorktreeDirty / mergeWorktreeBranch
// =============================================================================

describe("git merge utilities", () => {
  let repoDir;

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    // Clean up worktrees before removing the repo
    try {
      execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" });
    } catch {}
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("isWorktreeDirty", () => {
    it("returns false for a clean worktree", async () => {
      assert.equal(await isWorktreeDirty(repoDir), false);
    });

    it("returns true when there are uncommitted changes", async () => {
      writeFileSync(join(repoDir, "dirty.txt"), "uncommitted\n");
      assert.equal(await isWorktreeDirty(repoDir), true);
    });

    it("returns true when there are staged but uncommitted changes", async () => {
      writeFileSync(join(repoDir, "staged.txt"), "staged\n");
      execSync("git add staged.txt", { cwd: repoDir, stdio: "pipe" });
      assert.equal(await isWorktreeDirty(repoDir), true);
    });

    it("rejects for a nonexistent directory", async () => {
      // Unknown is not "dirty" or "clean" — callers get an error to surface.
      await assert.rejects(isWorktreeDirty("/nonexistent/path"), { kind: "not_a_repo" });
    });
  });

  describe("mergeWorktreeBranch", () => {
    it("successfully merges a branch", async () => {
      // Create a branch with a commit
      execSync("git checkout -b feature-branch", { cwd: repoDir, stdio: "pipe" });
      writeFileSync(join(repoDir, "feature.txt"), "new feature\n");
      execSync("git add . && git commit -m 'add feature'", { cwd: repoDir, stdio: "pipe" });
      execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });

      const result = await mergeWorktreeBranch(repoDir, "feature-branch");
      assert.deepEqual(result, { success: true });

      // Verify the file exists on main now
      const output = execSync("git log --oneline -1", { cwd: repoDir, stdio: "pipe" }).toString();
      assert.ok(output.includes("feature"));
    });

    it("returns error on merge conflict and aborts", async () => {
      // Create conflicting changes
      execSync("git checkout -b conflict-branch", { cwd: repoDir, stdio: "pipe" });
      writeFileSync(join(repoDir, "README.md"), "conflict branch content\n");
      execSync("git add . && git commit -m 'conflict change'", { cwd: repoDir, stdio: "pipe" });
      execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
      writeFileSync(join(repoDir, "README.md"), "main branch content\n");
      execSync("git add . && git commit -m 'main change'", { cwd: repoDir, stdio: "pipe" });

      const result = await mergeWorktreeBranch(repoDir, "conflict-branch");
      assert.equal(result.success, false);
      assert.ok(result.error.length > 0);

      // Verify repo is clean (merge was aborted)
      assert.equal(await isWorktreeDirty(repoDir), false);
    });

    it("returns error for nonexistent branch", async () => {
      const result = await mergeWorktreeBranch(repoDir, "nonexistent-branch");
      assert.equal(result.success, false);
    });

    it("bypasses pre-commit hooks on merge commits", async () => {
      execSync("git checkout -b feature-branch", { cwd: repoDir, stdio: "pipe" });
      writeFileSync(join(repoDir, "feature.txt"), "new feature\n");
      execSync("git add . && git commit -m 'add feature'", { cwd: repoDir, stdio: "pipe" });
      execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
      execSync(
        "printf '#!/bin/sh\nexit 1\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit",
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      );

      const result = await mergeWorktreeBranch(repoDir, "feature-branch");
      assert.deepEqual(result, { success: true });
    });
  });

  describe("squashMergeBranch", () => {
    it("bypasses pre-commit hooks on squash commits", async () => {
      execSync("git checkout -b feature-branch", { cwd: repoDir, stdio: "pipe" });
      writeFileSync(join(repoDir, "feature.txt"), "new feature\n");
      execSync("git add . && git commit -m 'add feature'", { cwd: repoDir, stdio: "pipe" });
      execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
      execSync(
        "printf '#!/bin/sh\nexit 1\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit",
        {
          cwd: repoDir,
          stdio: "pipe",
        },
      );

      const result = await squashMergeBranch(repoDir, "feature-branch", "feature squash");
      assert.deepEqual(result, { success: true });
    });
  });

  describe("end-to-end worktree merge flow", () => {
    it("creates worktree, commits changes, merges back", async () => {
      const wt = await createWorktree(repoDir, "test-wt");
      assert.ok(wt);

      // Make a change in the worktree
      writeFileSync(join(wt.worktreePath, "worktree-change.txt"), "from worktree\n");
      execSync("git add . && git commit -m 'worktree commit'", {
        cwd: wt.worktreePath,
        stdio: "pipe",
      });

      // Worktree should be clean after commit
      assert.equal(await isWorktreeDirty(wt.worktreePath), false);

      // Merge the worktree branch into main
      const result = await mergeWorktreeBranch(repoDir, wt.branchName);
      assert.deepEqual(result, { success: true });

      // Clean up
      await removeWorktree(repoDir, wt.worktreePath, wt.branchName);

      // Verify the change is on main
      const branch = await getCurrentBranch(repoDir);
      assert.equal(branch, "main");
      const log = execSync("git log --oneline", { cwd: repoDir, stdio: "pipe" }).toString();
      assert.ok(log.includes("worktree commit"));
    });
  });
});

// =============================================================================
// InstanceManager.mergeInstance()
// =============================================================================

describe("InstanceManager.mergeInstance", () => {
  let manager;
  let tempDir;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-merge-im-"));
    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 5,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: join(tempDir, ".claude"),
        codex: join(tempDir, ".codex"),
      },
    });
    manager = new InstanceManager(config);
  });

  afterEach(async () => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws for unknown instance", async () => {
    await assert.rejects(manager.mergeInstance("nonexistent"), /not found/);
  });

  it("throws for instance without worktree metadata", async () => {
    // Use tempDir (not a git repo) so no worktree is created
    const info = manager.createInstance({ name: "No Worktree", workingDirectory: tempDir });
    await assert.rejects(manager.mergeInstance(info.id), /does not have a worktree/);
  });
});

// =============================================================================
// HTTP: POST /api/instances/:id/merge
// =============================================================================

function request(server, method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${server.address().port}`);
    const req = http.request(url, { method, headers: options.headers || {} }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe("POST /api/instances/:id/merge", () => {
  let server;
  let auth;
  let manager;
  let tempDir;

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-merge-http-"));
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
    server.listen(0, done);
  });

  afterEach((_, done) => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
    server.close(done);
  });

  it("requires authentication", async () => {
    const res = await request(
      server,
      "POST",
      "/api/instances/00000000-0000-0000-0000-000000000000/merge",
    );
    assert.equal(res.status, 401);
  });

  it("returns 400 for nonexistent instance", async () => {
    const session = auth.createSession();
    const res = await request(
      server,
      "POST",
      "/api/instances/00000000-0000-0000-0000-000000000000/merge",
      { headers: { Cookie: `session=${session.id}` } },
    );
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes("not found"));
  });

  it("returns 400 for instance without worktree", async () => {
    const session = auth.createSession();
    // Use tempDir (not a git repo) so no worktree metadata is set
    const info = manager.createInstance({ name: "No WT", workingDirectory: tempDir });
    const res = await request(server, "POST", `/api/instances/${info.id}/merge`, {
      headers: { Cookie: `session=${session.id}` },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes("worktree"));
  });
});

// =============================================================================
// WebSocket: merge_instance message
// =============================================================================

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

  const ready = new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });

  return { ws, ready };
}

describe("WebSocket merge_instance", () => {
  let server;
  let auth;
  let manager;
  let tempDir;
  let wsHandle;
  const openSockets = [];

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-merge-ws-"));
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

  it("returns error for nonexistent instance", async () => {
    const session = auth.createSession();
    const ws = await connect(session.id);
    await ws.waitForHandshake();

    ws.send(
      JSON.stringify({
        type: "merge_instance",
        instanceId: "00000000-0000-0000-0000-000000000000",
      }),
    );

    const msg = await ws.nextMessageOfType("error");
    assert.ok(msg.message.includes("not found"));
  });

  it("returns error for instance without worktree", async () => {
    const session = auth.createSession();
    // Use tempDir (not a git repo) so no worktree metadata is set
    const info = manager.createInstance({ name: "No WT", workingDirectory: tempDir });

    const ws = await connect(session.id);
    await ws.waitForHandshake();

    ws.send(
      JSON.stringify({
        type: "merge_instance",
        instanceId: info.id,
      }),
    );

    // May receive instance_status events from process startup — find the error
    let msg;
    for (let i = 0; i < 10; i++) {
      msg = await ws.nextMessage();
      if (msg.type === "error" && msg.instanceId === info.id) break;
    }
    assert.equal(msg.type, "error");
    assert.ok(msg.message.includes("worktree"));
  });
});
