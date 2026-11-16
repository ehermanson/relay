// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Workstreams: the SessionDB tables and the routes over them.
 *   GET    /api/workstreams[?accountId=]
 *   POST   /api/workstreams
 *   PATCH  /api/workstreams/:id
 *   DELETE /api/workstreams/:id
 *   POST   /api/instances/:id/workstream
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequestHandler } from "../dist/server/http.js";
import { AuthManager } from "../dist/server/auth.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import { SessionDB } from "../dist/server/core/db.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function workstream(id, overrides = {}) {
  return {
    id,
    accountId: "default",
    name: id,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("SessionDB workstreams", () => {
  let tempDir;
  let db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-workstreams-db-"));
    db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores workstreams per account", () => {
    db.insertWorkstream(workstream("w1", { name: "GraphQL" }));
    db.insertWorkstream(workstream("w2", { accountId: "work" }));
    assert.deepEqual(
      db.listWorkstreams("default").map((w) => w.name),
      ["GraphQL"],
    );
    assert.deepEqual(
      db.listWorkstreams("work").map((w) => w.id),
      ["w2"],
    );
  });

  it("updates name and status independently", () => {
    db.insertWorkstream(workstream("w1", { name: "GraphQL" }));
    assert.equal(db.updateWorkstream("w1", { status: "done" }, 5).name, "GraphQL");
    const renamed = db.updateWorkstream("w1", { name: "GraphQL perf" }, 9);
    assert.equal(renamed.status, "done");
    assert.equal(renamed.name, "GraphQL perf");
    assert.equal(renamed.updatedAt, 9);
    assert.equal(db.updateWorkstream("missing", { name: "x" }, 1), null);
  });

  it("keeps a chat in at most one workstream", () => {
    db.insertWorkstream(workstream("w1"));
    db.insertWorkstream(workstream("w2"));
    db.setChatWorkstream("chat-a", "w1", "manual", 10);
    db.setChatWorkstream("chat-b", "w1", "manual", 10);
    db.setChatWorkstream("chat-a", "w2", "manual", 20);
    assert.deepEqual(db.listWorkstreamMembers("default"), { "chat-a": "w2", "chat-b": "w1" });
  });

  it("removes a chat with null and lets it rejoin later", () => {
    db.insertWorkstream(workstream("w1"));
    db.setChatWorkstream("chat-a", "w1", "manual", 10);
    db.setChatWorkstream("chat-a", null, "manual", 20);
    assert.deepEqual(db.listWorkstreamMembers("default"), {});
    db.setChatWorkstream("chat-a", "w1", "manual", 30);
    assert.deepEqual(db.listWorkstreamMembers("default"), { "chat-a": "w1" });
  });

  it("scopes membership to the account's workstreams", () => {
    db.insertWorkstream(workstream("w1"));
    db.insertWorkstream(workstream("w2", { accountId: "work" }));
    db.setChatWorkstream("chat-a", "w1", "manual", 10);
    db.setChatWorkstream("chat-b", "w2", "manual", 10);
    assert.deepEqual(db.listWorkstreamMembers("work"), { "chat-b": "w2" });
  });

  it("deletes a workstream with its membership", () => {
    db.insertWorkstream(workstream("w1"));
    db.setChatWorkstream("chat-a", "w1", "manual", 10);
    assert.equal(db.deleteWorkstream("w1"), true);
    assert.equal(db.deleteWorkstream("w1"), false);
    assert.deepEqual(db.listWorkstreams("default"), []);
    assert.deepEqual(db.listWorkstreamMembers("default"), {});
  });

  it("survives reopening the database", () => {
    db.insertWorkstream(workstream("w1", { name: "GraphQL" }));
    db.setChatWorkstream("chat-a", "w1", "manual", 10);
    db.close();
    db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    assert.equal(db.getWorkstream("w1").name, "GraphQL");
    assert.deepEqual(db.listWorkstreamMembers("default"), { "chat-a": "w1" });
  });
});

function request(server, method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${server.address().port}`);
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const req = http.request(url, { method, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe("workstream routes", () => {
  let server;
  let manager;
  let tempDir;
  let cookie;

  const call = (method, path, body) =>
    request(server, method, path, { headers: { Cookie: cookie }, body });

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-workstream-routes-"));
    const claude = join(tempDir, ".claude");
    const codex = join(tempDir, ".codex");
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });
    const config = resolveConfig({
      password: "testpass",
      logger: noopLogger,
      maxProcesses: 5,
      serveUI: false,
      rateLimitMax: 100,
      rateLimitWindow: 60_000,
      sessionFile: join(tempDir, "sessions.json"),
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: { claude, codex },
    });
    const auth = new AuthManager(config);
    manager = new InstanceManager(config);
    const handler = createRequestHandler(config, auth, manager, undefined, {
      getProviderModels: async () => [],
      getProviderCapabilities: () => ({}),
      getAvailableProviders: () => [],
      getOpenTargets: async (p) => ({ path: p, preferredTargetId: null, targets: [] }),
      openNativePath: async () => {},
    });
    cookie = `session=${auth.createSession().id}`;
    server = http.createServer(handler);
    server.listen(0, done);
  });

  afterEach((_, done) => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
    server.close(done);
  });

  it("requires authentication", async () => {
    const res = await request(server, "GET", "/api/workstreams");
    assert.equal(res.status, 401);
  });

  it("creates, lists, renames, marks done and deletes", async () => {
    const created = await call("POST", "/api/workstreams", { name: "  GraphQL   perf " });
    assert.equal(created.status, 200);
    const { id } = created.body.workstream;
    assert.equal(created.body.workstream.name, "GraphQL perf");
    assert.equal(created.body.workstream.accountId, "default");

    const listed = await call("GET", "/api/workstreams");
    assert.deepEqual(
      listed.body.workstreams.map((w) => w.id),
      [id],
    );
    assert.deepEqual(listed.body.members, {});

    const patched = await call("PATCH", `/api/workstreams/${id}`, {
      name: "GraphQL",
      status: "done",
    });
    assert.equal(patched.body.workstream.name, "GraphQL");
    assert.equal(patched.body.workstream.status, "done");

    assert.equal((await call("DELETE", `/api/workstreams/${id}`)).status, 200);
    assert.equal((await call("DELETE", `/api/workstreams/${id}`)).status, 404);
  });

  it("rejects bad names and statuses", async () => {
    assert.equal((await call("POST", "/api/workstreams", { name: "   " })).status, 400);
    assert.equal((await call("POST", "/api/workstreams", { name: "x".repeat(81) })).status, 400);
    const { id } = (await call("POST", "/api/workstreams", { name: "ok" })).body.workstream;
    assert.equal((await call("PATCH", `/api/workstreams/${id}`, { status: "nope" })).status, 400);
    assert.equal((await call("PATCH", "/api/workstreams/missing", { name: "x" })).status, 404);
  });

  it("treats an unknown account as the default account", async () => {
    const created = await call("POST", "/api/workstreams", { name: "a", accountId: "ghost" });
    assert.equal(created.body.workstream.accountId, "default");
    const listed = await call("GET", "/api/workstreams?accountId=ghost");
    assert.equal(listed.body.workstreams.length, 1);
  });

  it("moves a chat between workstreams and out again", async () => {
    const a = (await call("POST", "/api/workstreams", { name: "a" })).body.workstream.id;
    const b = (await call("POST", "/api/workstreams", { name: "b" })).body.workstream.id;

    assert.equal(
      (await call("POST", "/api/instances/chat-1/workstream", { workstreamId: a })).status,
      200,
    );
    await call("POST", "/api/instances/chat-1/workstream", { workstreamId: b });
    assert.deepEqual((await call("GET", "/api/workstreams")).body.members, { "chat-1": b });

    await call("POST", "/api/instances/chat-1/workstream", { workstreamId: null });
    assert.deepEqual((await call("GET", "/api/workstreams")).body.members, {});
  });

  it("refuses an unknown workstream or a malformed body", async () => {
    assert.equal(
      (await call("POST", "/api/instances/chat-1/workstream", { workstreamId: "missing" })).status,
      404,
    );
    assert.equal((await call("POST", "/api/instances/chat-1/workstream", {})).status, 400);
  });
});
