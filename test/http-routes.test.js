/**
 * Tests for HTTP routes that were missing coverage:
 * - GET /logout
 * - GET /api/directories
 * - GET /api/browse?prefix=...
 * - GET /api/file?path=...
 * - Stats endpoint external double-counting behavior
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createRequestHandler } from "../dist/server/http.js";
import { AuthManager } from "../dist/server/auth.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { archiveTasks } from "../dist/server/core/task-manager.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

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

describe("HTTP Routes — Additional Coverage", () => {
  let server;
  let auth;
  let manager;
  let tempDir;
  let getProviderModels;
  let getProviderCapabilities;
  let getAvailableProviders;
  let getOpenTargets;
  let openPathCalls;

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-http-test-"));
    getProviderModels = undefined;
    getProviderCapabilities = undefined;
    getAvailableProviders = undefined;
    getOpenTargets = async (targetPath) => ({
      path: targetPath,
      preferredTargetId: null,
      targets: [
        { id: "system-default", label: "Default app", kind: "default" },
        { id: "cursor", label: "Cursor", kind: "app" },
        { id: "finder", label: "Finder", kind: "finder" },
      ],
    });
    openPathCalls = [];
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
    const handler = createRequestHandler(config, auth, manager, undefined, {
      getProviderModels: (...args) => getProviderModels?.(...args),
      getProviderCapabilities: (...args) => getProviderCapabilities?.(...args),
      getAvailableProviders: () => getAvailableProviders?.(),
      getOpenTargets: (...args) => getOpenTargets?.(...args),
      openNativePath: async (request) => {
        openPathCalls.push(request);
      },
    });
    server = http.createServer(handler);
    server.listen(0, done);
  });

  afterEach((_, done) => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
    server.close(done);
  });

  describe("GET /logout", () => {
    it("clears session and redirects to /login", async () => {
      const session = auth.createSession();
      const res = await request(server, "GET", "/logout", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, "/login");
      // Cookie should be cleared
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie);
      const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
      assert.ok(cookieStr.includes("Max-Age=0"));

      // Session should be invalidated
      const validated = auth.validateSession(session.id);
      assert.equal(validated, null);
    });

    it("works even without an active session", async () => {
      const res = await request(server, "GET", "/logout");
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, "/login");
    });
  });

  describe("GET /api/directories", () => {
    it("requires authentication", async () => {
      const res = await request(server, "GET", "/api/directories");
      assert.equal(res.status, 401);
    });

    it("returns defaultDirectory and directories array", async () => {
      const session = auth.createSession();
      const res = await request(server, "GET", "/api/directories", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.ok("defaultDirectory" in res.body);
      assert.ok(Array.isArray(res.body.directories));
    });
  });

  describe("GET /api/browse", () => {
    it("requires authentication", async () => {
      const res = await request(server, "GET", "/api/browse?prefix=/tmp");
      assert.equal(res.status, 401);
    });

    it("returns directories for a valid prefix", async () => {
      const session = auth.createSession();
      const home = homedir();
      const res = await request(
        server,
        "GET",
        `/api/browse?prefix=${encodeURIComponent(home + "/")}`,
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );
      assert.equal(res.status, 200);
      assert.ok("directories" in res.body);
      assert.ok(Array.isArray(res.body.directories));
      assert.equal(res.body.home, home);
    });

    it("returns empty array for nonexistent prefix", async () => {
      const session = auth.createSession();
      const res = await request(
        server,
        "GET",
        `/api/browse?prefix=${encodeURIComponent(homedir() + "/nonexistent-dir-12345/")}`,
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.directories, []);
    });

    it("rejects paths outside home directory", async () => {
      const session = auth.createSession();
      const res = await request(
        server,
        "GET",
        `/api/browse?prefix=${encodeURIComponent("/etc/")}`,
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes("home directory"));
    });
  });

  describe("GET /api/provider-models", () => {
    it("requires authentication", async () => {
      const res = await request(server, "GET", "/api/provider-models?provider=codex");
      assert.equal(res.status, 401);
    });

    it("returns provider-scoped model metadata", async () => {
      getProviderModels = async (provider) => [
        {
          provider,
          id: "gpt-5.4",
          label: "GPT-5.4",
          isDefault: true,
        },
      ];
      getProviderCapabilities = () => ({
        supportsResume: true,
        supportsTranscriptReplay: true,
        supportsApprovals: true,
        supportsUserInputRequests: true,
        supportsReasoningEffort: true,
        supportsFastMode: true,
        supportsModelSelection: true,
        supportsTitleUpdates: true,
      });
      getAvailableProviders = () => [
        {
          provider: "codex",
          label: "Codex",
          capabilities: getProviderCapabilities(),
        },
      ];

      const session = auth.createSession();
      const res = await request(server, "GET", "/api/provider-models?provider=codex", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.provider, "codex");
      assert.equal(res.body.models.length, 1);
      const [model] = res.body.models;
      // Strip resolvedCapabilities (injected by the route from provider caps)
      // before comparing the model shape.
      const { resolvedCapabilities, ...modelShape } = model;
      assert.ok(resolvedCapabilities, "expected resolvedCapabilities to be present");
      assert.deepEqual(modelShape, {
        provider: "codex",
        id: "gpt-5.4",
        label: "GPT-5.4",
        isDefault: true,
      });
      assert.equal(res.body.defaultModel?.id, "gpt-5.4");
    });
  });

  describe("GET /api/providers", () => {
    it("requires authentication", async () => {
      const res = await request(server, "GET", "/api/providers");
      assert.equal(res.status, 401);
    });

    it("returns the available provider catalog", async () => {
      getAvailableProviders = () => [
        {
          provider: "claude",
          label: "Claude Code",
          capabilities: {
            supportsResume: true,
            supportsTranscriptReplay: true,
            supportsApprovals: true,
            supportsUserInputRequests: true,
            supportsReasoningEffort: false,
            supportsFastMode: false,
            supportsModelSelection: true,
            supportsTitleUpdates: false,
          },
        },
      ];

      const session = auth.createSession();
      const res = await request(server, "GET", "/api/providers", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.providers, getAvailableProviders());
    });
  });

  describe("MCP provider routes", () => {
    const capabilities = {
      supportsResume: true,
      supportsTranscriptReplay: true,
      supportsApprovals: true,
      supportsUserInputRequests: true,
      supportsReasoningEffort: false,
      supportsFastMode: false,
      supportsModelSelection: true,
      supportsTitleUpdates: false,
      mcp: {
        discovery: "global",
        toolEnumeration: false,
        management: {
          scopes: ["global"],
          bearerTokenEnvVar: false,
          transports: ["http"],
        },
      },
    };

    beforeEach(() => {
      getAvailableProviders = () => [{ provider: "claude", label: "Claude Code", capabilities }];
      getProviderCapabilities = () => capabilities;
    });

    it("requires authentication for MCP additions", async () => {
      const res = await request(server, "POST", "/api/providers/claude/mcp-servers", {
        headers: { "Content-Type": "application/json" },
        body: { name: "github", transport: "http", url: "https://example.com/mcp" },
      });
      assert.equal(res.status, 401);
    });

    it("rejects transports not advertised by the Provider", async () => {
      const session = auth.createSession();
      const res = await request(server, "POST", "/api/providers/claude/mcp-servers", {
        headers: {
          Cookie: `session=${session.id}`,
          "Content-Type": "application/json",
        },
        body: { name: "local", transport: "stdio", command: "node" },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "Provider does not support stdio MCP servers");
    });

    it("does not expose an interactive MCP action endpoint", async () => {
      const session = auth.createSession();
      const res = await request(server, "POST", "/api/providers/claude/mcp-servers/github/action", {
        headers: {
          Cookie: `session=${session.id}`,
          "Content-Type": "application/json",
        },
        body: { action: "login" },
      });
      assert.equal(res.status, 404);
    });

    it("does not expose an MCP removal endpoint", async () => {
      const session = auth.createSession();
      const res = await request(server, "DELETE", "/api/providers/claude/mcp-servers/github", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 404);
    });
  });

  describe("POST /api/providers/update", () => {
    it("requires authentication", async () => {
      const res = await request(server, "POST", "/api/providers/update?provider=codex");
      assert.equal(res.status, 401);
    });

    it("rejects unknown providers", async () => {
      getAvailableProviders = () => [];
      const session = auth.createSession();
      const res = await request(server, "POST", "/api/providers/update?provider=bogus", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "Invalid provider");
    });

    it("returns diagnostics and providers when no automatic update is available", async () => {
      getAvailableProviders = () => [
        {
          provider: "codex",
          label: "Codex",
          capabilities: {
            supportsResume: true,
            supportsTranscriptReplay: true,
            supportsApprovals: true,
            supportsUserInputRequests: true,
            supportsReasoningEffort: true,
            supportsFastMode: false,
            supportsModelSelection: true,
            supportsTitleUpdates: true,
          },
        },
      ];
      const session = auth.createSession();
      const res = await request(server, "POST", "/api/providers/update?provider=codex", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.result.status, "no_update");
      assert.match(res.body.result.message, /No automatic update is currently available/);
      assert.equal(res.body.result.output, "");
      assert.deepEqual(res.body.providers, getAvailableProviders());
    });
  });

  describe("GET /api/open-targets", () => {
    it("requires authentication", async () => {
      const res = await request(
        server,
        "GET",
        `/api/open-targets?path=${encodeURIComponent(tempDir)}`,
      );
      assert.equal(res.status, 401);
    });

    it("returns detected open targets for a project path", async () => {
      const session = auth.createSession();
      const res = await request(
        server,
        "GET",
        `/api/open-targets?path=${encodeURIComponent(tempDir)}`,
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.path, tempDir);
      assert.equal(res.body.preferredTargetId, null);
      assert.deepEqual(
        res.body.targets.map((target) => target.id),
        ["system-default", "cursor", "finder"],
      );
    });
  });

  describe("GET /api/spaces/:id/diff", () => {
    it("returns an empty diff when a space worktree no longer exists", async () => {
      execSync("git init -q", { cwd: tempDir });
      execSync('git config user.email "test@example.com"', { cwd: tempDir });
      execSync('git config user.name "Test User"', { cwd: tempDir });
      writeFileSync(join(tempDir, "README.md"), "hello\n");
      execSync("git add README.md", { cwd: tempDir });
      execSync('git commit -qm "init"', { cwd: tempDir });

      manager.db.upsertSpace({
        id: "262013e4-17c1-422d-a709-f2cc34c12681",
        project_directory: tempDir,
        name: "relay-space/deadbeef",
        git_branch: "relay-space/deadbeef",
        worktree_path: join(tempDir, ".relay", "worktrees", "space-deadbeef"),
        is_default: 0,
        status: "active",
        created_at: Date.now(),
        last_activity_at: Date.now(),
      });

      const session = auth.createSession();
      const res = await request(
        server,
        "GET",
        "/api/spaces/262013e4-17c1-422d-a709-f2cc34c12681/diff",
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.diff, "");
    });
  });

  describe("POST /api/spaces/:id/pinned", () => {
    it("persists and returns the updated space", async () => {
      const session = auth.createSession();
      const projectDir = join(tempDir, "pin-space-project");
      mkdirSync(projectDir);
      const space = manager.getSpaceManager().getOrCreateDefaultSpace(projectDir);

      const res = await request(server, "POST", `/api/spaces/${space.id}/pinned`, {
        headers: { Cookie: `session=${session.id}` },
        body: { pinned: true },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.id, space.id);
      assert.equal(res.body.pinned, true);
      assert.equal(manager.getSpaceManager().getSpace(space.id).pinned, true);
    });

    it("returns 404 for an unknown space", async () => {
      const session = auth.createSession();
      const res = await request(server, "POST", "/api/spaces/missing/pinned", {
        headers: { Cookie: `session=${session.id}` },
        body: { pinned: true },
      });
      assert.equal(res.status, 404);
    });

    it("rejects a non-boolean pin without changing the persisted value", async () => {
      const session = auth.createSession();
      const projectDir = join(tempDir, "malformed-pin-space-project");
      mkdirSync(projectDir);
      const space = manager.getSpaceManager().getOrCreateDefaultSpace(projectDir);
      manager.getSpaceManager().setSpacePinned(space.id, true);

      const res = await request(server, "POST", `/api/spaces/${space.id}/pinned`, {
        headers: { Cookie: `session=${session.id}` },
        body: { pinned: "false" },
      });

      assert.equal(res.status, 400);
      assert.match(res.body.error, /boolean/);
      assert.equal(manager.getSpaceManager().getSpace(space.id).pinned, true);
    });
  });

  describe("GET /api/file", () => {
    it("requires authentication", async () => {
      const res = await request(server, "GET", "/api/file?path=/tmp/test.png");
      assert.equal(res.status, 401);
    });

    it("rejects missing path parameter", async () => {
      const session = auth.createSession();
      const res = await request(server, "GET", "/api/file", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes("Missing path"));
    });

    it("rejects disallowed file extensions", async () => {
      const session = auth.createSession();
      // .exe is not in the allowlist (which includes images, PDFs, and common
      // text-ish file types). Use a path under home so the dir check doesn't
      // kick in first.
      const filePath = join(homedir(), "test-disallowed-12345.exe");
      const res = await request(server, "GET", `/api/file?path=${encodeURIComponent(filePath)}`, {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.toLowerCase().includes("not allowed"));
    });

    it("returns 404 for nonexistent image file", async () => {
      const session = auth.createSession();
      const filePath = join(homedir(), "nonexistent-image-12345.png");
      const res = await request(server, "GET", `/api/file?path=${encodeURIComponent(filePath)}`, {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 404);
    });

    it("serves a valid image file", async () => {
      const session = auth.createSession();
      // Create a tiny 1x1 PNG in the temp directory (under home)
      // This is the smallest valid PNG: 67 bytes
      const pngHeader = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG signature
        0x00,
        0x00,
        0x00,
        0x0d,
        0x49,
        0x48,
        0x44,
        0x52, // IHDR
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x01,
        0x08,
        0x02,
        0x00,
        0x00,
        0x00,
        0x90,
        0x77,
        0x53,
        0xde,
        0x00,
        0x00,
        0x00,
        0x0c,
        0x49,
        0x44,
        0x41, // IDAT
        0x54,
        0x08,
        0xd7,
        0x63,
        0xf8,
        0xcf,
        0xc0,
        0x00,
        0x00,
        0x00,
        0x02,
        0x00,
        0x01,
        0xe2,
        0x21,
        0xbc,
        0x33,
        0x00,
        0x00,
        0x00,
        0x00,
        0x49,
        0x45,
        0x4e, // IEND
        0x44,
        0xae,
        0x42,
        0x60,
        0x82,
      ]);
      const imgPath = join(tempDir, "test-image.png");
      writeFileSync(imgPath, pngHeader);

      const res = await request(server, "GET", `/api/file?path=${encodeURIComponent(imgPath)}`, {
        headers: { Cookie: `session=${session.id}` },
      });
      // Home and system temp dirs are both allowed roots.
      assert.equal(res.status, 200);
    });

    it("rejects files outside home directory", async () => {
      const session = auth.createSession();
      const res = await request(
        server,
        "GET",
        `/api/file?path=${encodeURIComponent("/etc/hosts.png")}`,
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );
      // Should be 403 (access denied) or 404 (not found with .png extension)
      assert.ok(res.status === 403 || res.status === 404);
    });
  });

  describe("POST /api/open", () => {
    it("requires authentication", async () => {
      const res = await request(server, "POST", "/api/open", {
        body: { path: join(tempDir, "example.txt") },
      });
      assert.equal(res.status, 401);
    });

    it("rejects missing path", async () => {
      const session = auth.createSession();
      const res = await request(server, "POST", "/api/open", {
        headers: { Cookie: `session=${session.id}` },
        body: {},
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Missing path/);
    });

    it("opens an absolute local path via the override", async () => {
      const session = auth.createSession();
      const filePath = join(tempDir, "open-me.txt");
      writeFileSync(filePath, "hello");
      const res = await request(server, "POST", "/api/open", {
        headers: { Cookie: `session=${session.id}` },
        body: { path: filePath, line: 12, column: 3 },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(openPathCalls, [
        {
          path: filePath,
          line: 12,
          column: 3,
          targetId: undefined,
          rememberForProject: false,
        },
      ]);
    });

    it("passes through target selection and project preference intent", async () => {
      const session = auth.createSession();
      const filePath = join(tempDir, "open-project.txt");
      writeFileSync(filePath, "hello");
      const res = await request(server, "POST", "/api/open", {
        headers: { Cookie: `session=${session.id}` },
        body: { path: filePath, targetId: "cursor", rememberForProject: true },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(openPathCalls, [
        {
          path: filePath,
          line: undefined,
          column: undefined,
          targetId: "cursor",
          rememberForProject: true,
        },
      ]);
    });
  });

  describe("Stats endpoint counting", () => {
    it("counts external as a separate cross-cutting dimension", async () => {
      const session = auth.createSession();

      // Create a normal instance
      await request(server, "POST", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
        body: { name: "Normal" },
      });

      const res = await request(server, "GET", "/api/stats", {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.instances.total, 1);
      // Normal instances are idle, not external
      assert.equal(res.body.instances.idle, 1);
      assert.equal(res.body.instances.external, 0);
    });
  });

  describe("GET /api/instances/:id/diff", () => {
    it("requires authentication", async () => {
      const res = await request(
        server,
        "GET",
        "/api/instances/00000000-0000-0000-0000-000000000000/diff",
      );
      assert.equal(res.status, 401);
    });

    it("returns 404 for unknown instance", async () => {
      const session = auth.createSession();
      const res = await request(
        server,
        "GET",
        "/api/instances/00000000-0000-0000-0000-000000000000/diff",
        {
          headers: { Cookie: `session=${session.id}` },
        },
      );
      assert.equal(res.status, 404);
    });

    it("returns diff object for a valid instance", async () => {
      const session = auth.createSession();
      const createRes = await request(server, "POST", "/api/instances", {
        headers: { Cookie: `session=${session.id}` },
        body: { name: "diff-test" },
      });
      assert.equal(createRes.status, 201);
      const id = createRes.body.id;

      const res = await request(server, "GET", `/api/instances/${id}/diff`, {
        headers: { Cookie: `session=${session.id}` },
      });
      // The working directory may or may not be a git repo — either 200 with diff or 404
      assert.ok(res.status === 200 || res.status === 404);
      if (res.status === 200) {
        assert.ok("diff" in res.body);
        assert.equal(typeof res.body.diff, "string");
      }
    });
  });

  describe("Task routes", () => {
    function createTaskProject(name) {
      const projectDir = join(tempDir, name);
      mkdirSync(projectDir, { recursive: true });
      execSync("git init", { cwd: projectDir, stdio: "pipe" });
      execSync("git config user.email test@test.com", { cwd: projectDir, stdio: "pipe" });
      execSync("git config user.name Test", { cwd: projectDir, stdio: "pipe" });
      writeFileSync(join(projectDir, "README.md"), `# ${name}\n`);
      execSync("git add .", { cwd: projectDir, stdio: "pipe" });
      execSync("git commit -m initial", { cwd: projectDir, stdio: "pipe" });
      return manager.projectManager.addProject(projectDir);
    }

    it("reads legacy tasks but rejects mutation until explicit migration", async () => {
      const session = auth.createSession();
      const project = createTaskProject("task-project");
      const projectDir = project.directory;
      mkdirSync(join(projectDir, ".relay"), { recursive: true });
      writeFileSync(
        join(projectDir, ".relay", "tasks.json"),
        JSON.stringify({
          version: 1,
          tasks: [
            {
              id: "517e8e5b",
              title: "Task",
              description: "",
              status: "open",
              priority: 2,
              type: "task",
              tags: [],
              parent: null,
              blockedBy: [],
              createdAt: "2026-03-08T15:17:47.774793-04:00",
              updatedAt: "2026-03-08T15:17:47.774793-04:00",
            },
          ],
        }) + "\n",
      );

      const listRes = await request(server, "GET", `/api/projects/${project.id}/tasks`, {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(listRes.status, 200);
      assert.equal(listRes.body.tasks.length, 1);

      const res = await request(server, "DELETE", `/api/projects/${project.id}/tasks/517e8e5b`, {
        headers: { Cookie: `session=${session.id}` },
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "legacy_requires_migration");
    });

    it("isolates Main and Space task files", async () => {
      const session = auth.createSession();
      const project = createTaskProject("scoped-task-project");
      const space = manager.getSpaceManager().createSpace(project.directory, {
        name: "Scoped tasks",
      });
      assert.ok(space.worktreePath);
      const authHeaders = { Cookie: `session=${session.id}` };
      const scoped = `?spaceId=${encodeURIComponent(space.id)}`;

      assert.equal(
        (
          await request(server, "POST", `/api/projects/${project.id}/tasks/init`, {
            headers: authHeaders,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(server, "POST", `/api/projects/${project.id}/tasks/init${scoped}`, {
            headers: authHeaders,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(server, "POST", `/api/projects/${project.id}/tasks`, {
            headers: authHeaders,
            body: { title: "Main task" },
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await request(server, "POST", `/api/projects/${project.id}/tasks${scoped}`, {
            headers: authHeaders,
            body: { title: "Space task" },
          })
        ).status,
        201,
      );

      const main = await request(server, "GET", `/api/projects/${project.id}/tasks`, {
        headers: authHeaders,
      });
      const inSpace = await request(server, "GET", `/api/projects/${project.id}/tasks${scoped}`, {
        headers: authHeaders,
      });
      assert.deepEqual(
        main.body.tasks.map((task) => task.title),
        ["Main task"],
      );
      assert.deepEqual(
        inSpace.body.tasks.map((task) => task.title),
        ["Space task"],
      );
    });

    it("rejects a Space from another Project and closed or broken Space scopes", async () => {
      const session = auth.createSession();
      const first = createTaskProject("first-task-project");
      const second = createTaskProject("second-task-project");
      const foreignSpace = manager.getSpaceManager().createSpace(first.directory, {
        name: "Foreign tasks",
      });
      const headers = { Cookie: `session=${session.id}` };
      const foreignQuery = `?spaceId=${encodeURIComponent(foreignSpace.id)}`;

      const crossProject = await request(
        server,
        "GET",
        `/api/projects/${second.id}/tasks${foreignQuery}`,
        { headers },
      );
      assert.equal(crossProject.status, 404);
      assert.equal(crossProject.body.code, "scope_not_found");

      manager.getSpaceManager().deleteSpace(foreignSpace.id);
      const closed = await request(
        server,
        "POST",
        `/api/projects/${first.id}/tasks${foreignQuery}`,
        { headers, body: { title: "Nope" } },
      );
      assert.equal(closed.status, 409);
      assert.equal(closed.body.code, "scope_unavailable");

      const brokenSpace = manager.getSpaceManager().createSpace(second.directory, {
        name: "Broken tasks",
      });
      assert.ok(brokenSpace.worktreePath);
      rmSync(brokenSpace.worktreePath, { recursive: true, force: true });
      const broken = await request(
        server,
        "POST",
        `/api/projects/${second.id}/tasks?spaceId=${encodeURIComponent(brokenSpace.id)}`,
        { headers, body: { title: "Nope" } },
      );
      assert.equal(broken.status, 409);
      assert.equal(broken.body.code, "scope_unavailable");
    });

    it("supports revisions, comments, and archived task detail", async () => {
      const session = auth.createSession();
      const project = createTaskProject("task-detail-project");
      const headers = { Cookie: `session=${session.id}` };
      await request(server, "POST", `/api/projects/${project.id}/tasks/init`, { headers });
      const created = await request(server, "POST", `/api/projects/${project.id}/tasks`, {
        headers,
        body: { title: "Detailed task" },
      });
      assert.equal(created.status, 201);

      const stale = await request(
        server,
        "PATCH",
        `/api/projects/${project.id}/tasks/${created.body.id}`,
        { headers, body: { title: "Stale edit", expectedRevision: "stale" } },
      );
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, "conflict");

      const comment = await request(
        server,
        "POST",
        `/api/projects/${project.id}/tasks/${created.body.id}/comments`,
        { headers, body: { body: "A useful note", author: "Tester" } },
      );
      assert.equal(comment.status, 201);
      assert.equal(comment.body.taskId, created.body.id);
      const comments = await request(
        server,
        "GET",
        `/api/projects/${project.id}/tasks/${created.body.id}/comments`,
        { headers },
      );
      assert.deepEqual(
        comments.body.comments.map((item) => item.body),
        ["A useful note"],
      );

      const completed = await request(
        server,
        "PATCH",
        `/api/projects/${project.id}/tasks/${created.body.id}`,
        { headers, body: { status: "done", expectedRevision: created.body.revision } },
      );
      assert.equal(completed.status, 200);
      archiveTasks(project.directory, { days: 0 });

      const detail = await request(
        server,
        "GET",
        `/api/projects/${project.id}/tasks/${created.body.id}`,
        { headers },
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.body.archived, true);
    });

    it("surfaces corrupt task diagnostics without breaking Project artifacts", async () => {
      const session = auth.createSession();
      const project = createTaskProject("corrupt-task-project");
      const headers = { Cookie: `session=${session.id}` };
      await request(server, "POST", `/api/projects/${project.id}/tasks/init`, { headers });
      writeFileSync(
        join(project.directory, ".relay", "tasks", "broken.md"),
        '---\nid: "not-an-id"\n---\nBroken\n',
      );

      const tasks = await request(server, "GET", `/api/projects/${project.id}/tasks`, {
        headers,
      });
      assert.equal(tasks.status, 400);
      assert.equal(tasks.body.code, "validation");
      assert.match(tasks.body.error, /broken\.md|YAML|front matter/i);

      const artifacts = await request(server, "GET", `/api/project-artifacts/${project.id}`, {
        headers,
      });
      assert.equal(artifacts.status, 200);
      assert.equal(artifacts.body.tasks, null);
    });
  });
});
