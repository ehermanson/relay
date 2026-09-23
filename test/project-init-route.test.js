// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
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

function request(server, method, routePath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(routePath, `http://localhost:${server.address().port}`);
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

describe("project init route", () => {
  let auth;
  let manager;
  let tempDir;
  let server;

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-project-route-"));
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
    const res = await request(server, "POST", "/api/projects/init");
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
  });

  it("creates and registers a new git project", async () => {
    const session = auth.createSession();
    const res = await request(server, "POST", "/api/projects/init", {
      headers: { Cookie: `session=${session.id}` },
      body: { parentDirectory: tempDir, name: "new-project" },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.name, "new-project");
    assert.equal(realpathSync(res.body.directory), realpathSync(join(tempDir, "new-project")));
    assert.equal(
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: join(tempDir, "new-project"),
        stdio: "pipe",
      })
        .toString()
        .trim(),
      "true",
    );
    assert.ok(
      execSync("git rev-parse --verify HEAD", {
        cwd: join(tempDir, "new-project"),
        stdio: "pipe",
      })
        .toString()
        .trim().length > 0,
    );
    assert.equal(
      realpathSync(manager.projectManager.getProject(res.body.id)?.directory),
      realpathSync(join(tempDir, "new-project")),
    );
  });
});
