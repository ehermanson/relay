// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequestHandler } from "../dist/server/http.js";
import { AuthManager } from "../dist/server/auth.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Helper to make HTTP requests against the test server.
 */
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

describe("HTTP Server", () => {
  let server;
  let auth;
  let manager;
  let tempDir;

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-server-test-"));
    const config = resolveConfig({
      password: "testpass",
      logger: noopLogger,
      maxProcesses: 5,
      serveUI: false, // return JSON instead of HTML for easier testing
      rateLimitMax: 3,
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

  describe("GET /health", () => {
    it("returns 200 with status, uptime, instances, version", async () => {
      const res = await request(server, "GET", "/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ok");
      assert.equal(typeof res.body.uptime, "number");
      assert.equal(typeof res.body.instances, "number");
      assert.equal(typeof res.body.version, "string");
    });

    it("does not require auth", async () => {
      // No cookies, should still return 200
      const res = await request(server, "GET", "/health");
      assert.equal(res.status, 200);
    });
  });

  describe("GET /", () => {
    it("returns JSON status when not authenticated (serveUI=false)", async () => {
      const res = await request(server, "GET", "/");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ok");
      assert.equal(res.body.authenticated, false);
    });

    it("returns JSON status when authenticated (serveUI=false)", async () => {
      const session = auth.createSession();
      const res = await request(server, "GET", "/", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ok");
      assert.equal(res.body.authenticated, true);
    });
  });

  describe("POST /auth", () => {
    it("returns 200 + Set-Cookie with correct password", async () => {
      const res = await request(server, "POST", "/auth", {
        body: { password: "testpass" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie);
      const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
      assert.ok(cookieStr.includes("session="));
    });

    it("returns 401 with wrong password", async () => {
      const res = await request(server, "POST", "/auth", {
        body: { password: "wrong" },
      });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, "Wrong password");
    });

    it("returns 429 after too many attempts", async () => {
      // rateLimitMax is 3 — send 3 allowed, then 1 blocked
      await request(server, "POST", "/auth", { body: { password: "wrong" } });
      await request(server, "POST", "/auth", { body: { password: "wrong" } });
      await request(server, "POST", "/auth", { body: { password: "wrong" } });
      const res = await request(server, "POST", "/auth", { body: { password: "wrong" } });
      assert.equal(res.status, 429);
      assert.ok(res.body.error.includes("Too many"));
    });
  });

  describe("pairing auth", () => {
    it("issues a pairing code for authenticated users", async () => {
      const session = auth.createSession();
      const res = await request(server, "POST", "/api/pairing", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.code, "string");
      assert.equal(res.body.code.length, 8);
      assert.equal(typeof res.body.expiresAt, "number");
    });

    it("redeems a pairing code into a session cookie", async () => {
      const session = auth.createSession();
      const pairingRes = await request(server, "POST", "/api/pairing", {
        headers: { Cookie: `session=${session.id}` },
      });
      const res = await request(server, "POST", "/auth/pair", {
        body: { code: pairingRes.body.code.toLowerCase() },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie);
      const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
      assert.ok(cookieStr.includes("session="));
    });

    it("rejects invalid pairing codes", async () => {
      const res = await request(server, "POST", "/auth/pair", {
        body: { code: "BADCODE1" },
      });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, "Invalid or expired pairing code");
    });

    it("lists connect endpoints for authenticated users", async () => {
      const session = auth.createSession();
      const res = await request(server, "GET", "/api/connect-endpoints", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.endpoints));
      assert.ok(res.body.endpoints.some((endpoint) => endpoint.url.includes("localhost")));
    });
  });

  describe("GET /api/instances", () => {
    it("returns 401 without auth", async () => {
      const res = await request(server, "GET", "/api/instances");
      assert.equal(res.status, 401);
      assert.equal(res.body.error, "Unauthorized");
    });

    it("returns 200 + array with auth", async () => {
      const session = auth.createSession();
      const res = await request(server, "GET", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 0);
    });
  });

  describe("POST /api/instances", () => {
    it("returns 401 without auth", async () => {
      const res = await request(server, "POST", "/api/instances", {
        body: { name: "Test" },
      });
      assert.equal(res.status, 401);
    });

    it("creates an instance with auth", async () => {
      const session = auth.createSession();
      const res = await request(server, "POST", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
        body: { name: "Test Instance" },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, "Test Instance");
      assert.ok(res.body.id);
      assert.equal(res.body.status, "idle");

      // Verify it shows up in the list
      const listRes = await request(server, "GET", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(listRes.body.length, 1);
    });
  });

  describe("DELETE /api/instances/:id", () => {
    it("returns 401 without auth", async () => {
      const res = await request(
        server,
        "DELETE",
        "/api/instances/00000000-0000-0000-0000-000000000000",
      );
      assert.equal(res.status, 401);
    });

    it("removes an existing instance", async () => {
      const session = auth.createSession();
      // Create first
      const createRes = await request(server, "POST", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
        body: { name: "ToDelete" },
      });
      const id = createRes.body.id;

      // Delete
      const deleteRes = await request(server, "DELETE", `/api/instances/${id}`, {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(deleteRes.status, 200);
      assert.equal(deleteRes.body.success, true);

      // Verify it's gone
      const listRes = await request(server, "GET", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(listRes.body.length, 0);
    });

    it("returns 404 for unknown instance", async () => {
      const session = auth.createSession();
      const res = await request(
        server,
        "DELETE",
        "/api/instances/00000000-0000-0000-0000-000000000000",
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );
      assert.equal(res.status, 404);
    });
  });

  describe("GET /api/instances/:id/history", () => {
    it("returns 401 without auth", async () => {
      const res = await request(
        server,
        "GET",
        "/api/instances/00000000-0000-0000-0000-000000000000/history",
      );
      assert.equal(res.status, 401);
    });

    it("returns history for existing instance", async () => {
      const session = auth.createSession();
      const createRes = await request(server, "POST", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
        body: { name: "HistoryTest" },
      });
      const id = createRes.body.id;

      const res = await request(server, "GET", `/api/instances/${id}/history`, {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 0);
    });

    it("returns 404 for unknown instance", async () => {
      const session = auth.createSession();
      const res = await request(
        server,
        "GET",
        "/api/instances/00000000-0000-0000-0000-000000000000/history",
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );
      assert.equal(res.status, 404);
    });
  });

  describe("GET /api/stats", () => {
    it("returns 401 without auth", async () => {
      const res = await request(server, "GET", "/api/stats");
      assert.equal(res.status, 401);
    });

    it("returns stats object with auth", async () => {
      const session = auth.createSession();

      // Create an instance so stats are non-trivial
      await request(server, "POST", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
        body: { name: "StatsTest" },
      });

      const res = await request(server, "GET", "/api/stats", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.instances, "object");
      assert.equal(res.body.instances.total, 1);
      assert.equal(typeof res.body.uptime, "number");
      assert.equal(typeof res.body.connections, "number");
    });
  });

  describe("Unknown route", () => {
    it("returns 404", async () => {
      const res = await request(server, "GET", "/nonexistent");
      assert.equal(res.status, 404);
    });
  });
});
