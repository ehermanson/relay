// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Account profile routes:
 *   GET    /api/providers/:provider/profiles
 *   POST   /api/providers/:provider/profiles
 *   PATCH  /api/providers/:provider/profiles/:id
 *   DELETE /api/providers/:provider/profiles/:id
 *   POST   /api/providers/:provider/profiles/:id/probe
 *
 * The identity probe is stubbed through the provider driver hook so no
 * `claude` process is ever spawned.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequestHandler } from "../dist/server/http.js";
import { AuthManager } from "../dist/server/auth.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import { getProviderDriver } from "../dist/server/core/provider-registry.js";
import { DEFAULT_ACCOUNT_PROFILE_ID } from "../dist/server/core/types.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function request(server, method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${server.address().port}`);
    const headers = { ...(options.headers || {}) };
    if (options.body) headers["Content-Type"] = "application/json";
    const req = http.request(url, { method, headers }, (res) => {
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

const claudeCapabilities = {
  supportsResume: true,
  supportsTranscriptReplay: true,
  supportsApprovals: true,
  supportsUserInputRequests: true,
  supportsReasoningEffort: false,
  supportsFastMode: false,
  supportsModelSelection: true,
  supportsTitleUpdates: false,
  supportsAccountProfiles: true,
};
const codexCapabilities = { ...claudeCapabilities, supportsAccountProfiles: false };

describe("account profile routes", () => {
  let server;
  let auth;
  let manager;
  let tempDir;
  let defaultClaudeDir;
  let workDir;
  let cookie;
  let refreshCalls;
  let probeCalls;
  /** configDir → snapshot returned by the stubbed driver */
  let snapshots;
  const driver = getProviderDriver("claude");
  const originalProbe = driver.probeAccountIdentity;
  const originalSnapshot = driver.getAccountIdentitySnapshot;

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-profile-routes-"));
    defaultClaudeDir = join(tempDir, ".claude");
    workDir = join(tempDir, ".claude-work");
    mkdirSync(defaultClaudeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(tempDir, "not-a-dir"), "x");

    refreshCalls = 0;
    probeCalls = [];
    snapshots = new Map();
    driver.probeAccountIdentity = async (configDir, _logger, options) => {
      probeCalls.push({ configDir, force: Boolean(options?.force) });
      const snap = {
        probeState: "ok",
        identity: { email: `user@${configDir.split("/").pop()}.test`, plan: "max" },
        probedAt: 1_700_000_000_000,
      };
      snapshots.set(configDir, snap);
      return snap;
    };
    driver.getAccountIdentitySnapshot = (configDir) =>
      snapshots.get(configDir) ?? { probeState: "unknown" };

    const config = resolveConfig({
      password: "testpass",
      logger: noopLogger,
      maxProcesses: 5,
      serveUI: false,
      rateLimitMax: 100,
      rateLimitWindow: 60_000,
      sessionFile: join(tempDir, "sessions.json"),
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: { claude: defaultClaudeDir, codex: join(tempDir, ".codex") },
    });
    auth = new AuthManager(config);
    manager = new InstanceManager(config);
    manager.refreshAccountProfileRoots = () => {
      refreshCalls += 1;
    };
    const handler = createRequestHandler(config, auth, manager, undefined, {
      getProviderModels: async () => [],
      getProviderCapabilities: (provider) =>
        provider === "claude" ? claudeCapabilities : codexCapabilities,
      getAvailableProviders: () => [
        { provider: "claude", label: "Claude Code", capabilities: claudeCapabilities },
        { provider: "codex", label: "Codex", capabilities: codexCapabilities },
      ],
      getOpenTargets: async (p) => ({ path: p, preferredTargetId: null, targets: [] }),
      openNativePath: async () => {},
    });
    cookie = `session=${auth.createSession().id}`;
    server = http.createServer(handler);
    server.listen(0, done);
  });

  afterEach((_, done) => {
    driver.probeAccountIdentity = originalProbe;
    driver.getAccountIdentitySnapshot = originalSnapshot;
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
    server.close(done);
  });

  const get = (path) => request(server, "GET", path, { headers: { Cookie: cookie } });
  const post = (path, body) => request(server, "POST", path, { headers: { Cookie: cookie }, body });
  const patch = (path, body) =>
    request(server, "PATCH", path, { headers: { Cookie: cookie }, body });
  const del = (path) => request(server, "DELETE", path, { headers: { Cookie: cookie } });
  const addWork = () =>
    post("/api/providers/claude/profiles", { label: "Work", configDir: workDir });

  it("requires authentication", async () => {
    const res = await request(server, "GET", "/api/providers/claude/profiles");
    assert.equal(res.status, 401);
  });

  it("404s for an unknown provider and returns [] without account-profile support", async () => {
    assert.equal((await get("/api/providers/bogus/profiles")).status, 404);
    const codex = await get("/api/providers/codex/profiles");
    assert.equal(codex.status, 200);
    assert.deepEqual(codex.body, []);
    assert.equal(probeCalls.length, 0);
  });

  it("lists the default profile first with its identity and kicks background probes", async () => {
    const res = await get("/api/providers/claude/profiles");
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    const [row] = res.body;
    assert.equal(row.id, DEFAULT_ACCOUNT_PROFILE_ID);
    assert.equal(row.isDefault, true);
    assert.equal(row.provider, "claude");
    assert.equal(row.configDir, defaultClaudeDir);
    // First list: no snapshot yet, so the row is unknown and a non-forced probe was kicked.
    assert.equal(row.probeState, "unknown");
    assert.deepEqual(probeCalls, [{ configDir: defaultClaudeDir, force: false }]);

    // Second list: the (stubbed) probe has landed and the row carries identity.
    const again = await get("/api/providers/claude/profiles");
    assert.equal(again.body[0].probeState, "ok");
    assert.equal(again.body[0].identity.email, "user@.claude.test");
    assert.equal(again.body[0].probedAt, 1_700_000_000_000);

    // ?probe=1 forces a re-probe.
    await get("/api/providers/claude/profiles?probe=1");
    assert.deepEqual(probeCalls.at(-1), { configDir: defaultClaudeDir, force: true });
  });

  it("adds a profile (201), persists it, refreshes roots and force-probes it", async () => {
    const res = await addWork();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.label, "Work");
    assert.equal(res.body.configDir, workDir);
    assert.equal(res.body.provider, "claude");
    assert.equal(res.body.isDefault, false);
    assert.match(res.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(refreshCalls, 1);
    assert.ok(probeCalls.some((c) => c.configDir === workDir && c.force));

    const stored = JSON.parse(manager.sessionDb.getGlobalSettings().provider_profiles_json);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, res.body.id);

    const list = await get("/api/providers/claude/profiles");
    assert.deepEqual(
      list.body.map((p) => p.id),
      [DEFAULT_ACCOUNT_PROFILE_ID, res.body.id],
    );
    assert.equal(list.body[1].probeState, "ok");

    // GET /api/settings exposes the stored (non-default) profiles.
    const settings = await get("/api/settings");
    assert.equal(settings.body.providerProfiles.length, 1);
    assert.equal(settings.body.providerProfiles[0].id, res.body.id);
  });

  it("expands ~ in configDir", async () => {
    const home = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const res = await post("/api/providers/claude/profiles", {
        label: "Tilde",
        configDir: "~/.claude-work",
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.configDir, workDir);
    } finally {
      process.env.HOME = home;
    }
  });

  it("rejects bad input with a clear 400", async () => {
    const cases = [
      [{ label: "", configDir: workDir }, /Enter a name/],
      [{ label: "X", configDir: "relative" }, /absolute path/],
      [{ label: "X", configDir: join(tempDir, "missing") }, /does not exist/],
      [{ label: "X", configDir: join(tempDir, "not-a-dir") }, /not a directory/],
      [{ label: "X", configDir: defaultClaudeDir }, /"Default" already uses/],
      [{ label: "X", configDir: `${defaultClaudeDir}/` }, /"Default" already uses/],
    ];
    for (const [body, pattern] of cases) {
      const res = await post("/api/providers/claude/profiles", body);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, pattern);
    }
    assert.equal(refreshCalls, 0);

    await addWork();
    const dupDir = await post("/api/providers/claude/profiles", {
      label: "Other",
      configDir: `${workDir}/`,
    });
    assert.equal(dupDir.status, 400);
    assert.match(dupDir.body.error, /"Work" already uses/);
    const dupLabel = await post("/api/providers/claude/profiles", {
      label: "work",
      configDir: defaultClaudeDir,
    });
    assert.equal(dupLabel.status, 400);

    const codex = await post("/api/providers/codex/profiles", { label: "X", configDir: workDir });
    assert.equal(codex.status, 400);
    assert.equal((await post("/api/providers/bogus/profiles", {})).status, 404);
  });

  it("renames a profile and refuses to rename the default", async () => {
    const { body: created } = await addWork();
    const res = await patch(`/api/providers/claude/profiles/${created.id}`, { label: "Client" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.label, "Client");
    assert.equal(res.body.configDir, workDir);
    assert.equal(res.body.probeState, "ok");

    const stored = JSON.parse(manager.sessionDb.getGlobalSettings().provider_profiles_json);
    assert.equal(stored[0].label, "Client");

    const dflt = await patch(`/api/providers/claude/profiles/${DEFAULT_ACCOUNT_PROFILE_ID}`, {
      label: "Nope",
    });
    assert.equal(dflt.status, 400);
    const missing = await patch("/api/providers/claude/profiles/nope", { label: "X" });
    assert.equal(missing.status, 404);
    const dupe = await patch(`/api/providers/claude/profiles/${created.id}`, { label: "default" });
    assert.equal(dupe.status, 400);
    assert.match(dupe.body.error, /already exists/);
  });

  it("deletes a profile and clears global + project default references", async () => {
    const { body: created } = await addWork();
    refreshCalls = 0;

    // Point the global provider default and a project default at it.
    await patch("/api/settings", {
      providerDefaults: { claude: { model: "opus", profileId: created.id } },
    });
    const before = await get("/api/settings");
    assert.equal(before.body.providerDefaults.claude.profileId, created.id);

    const projectDir = join(tempDir, "proj");
    mkdirSync(projectDir);
    execSync("git init -q", { cwd: projectDir });
    const project = manager.projectManager.addProject(projectDir);
    manager.projectManager.updateProject(project.id, { defaultProfileId: created.id });
    assert.equal(manager.projectManager.getProject(project.id).defaultProfileId, created.id);

    const res = await del(`/api/providers/claude/profiles/${created.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, clearedProjects: 1 });
    assert.equal(refreshCalls, 1);

    const after = await get("/api/settings");
    assert.equal(after.body.providerProfiles.length, 0);
    assert.equal(after.body.providerDefaults.claude.profileId, null);
    assert.equal(after.body.providerDefaults.claude.model, "opus");
    assert.equal(manager.projectManager.getProject(project.id).defaultProfileId, null);

    assert.equal((await del(`/api/providers/claude/profiles/${created.id}`)).status, 404);
    assert.equal(
      (await del(`/api/providers/claude/profiles/${DEFAULT_ACCOUNT_PROFILE_ID}`)).status,
      400,
    );
  });

  it("force-probes a single profile and returns the row once done", async () => {
    const { body: created } = await addWork();
    probeCalls = [];
    driver.probeAccountIdentity = async (configDir, _logger, options) => {
      probeCalls.push({ configDir, force: Boolean(options?.force) });
      const snap = { probeState: "error", probeError: "Not signed in", probedAt: 42 };
      snapshots.set(configDir, snap);
      return snap;
    };
    const res = await post(`/api/providers/claude/profiles/${created.id}/probe`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(probeCalls, [{ configDir: workDir, force: true }]);
    assert.equal(res.body.id, created.id);
    assert.equal(res.body.probeState, "error");
    assert.equal(res.body.probeError, "Not signed in");
    assert.equal(res.body.probedAt, 42);

    assert.equal((await post("/api/providers/claude/profiles/nope/probe")).status, 404);
    assert.equal(
      (await post(`/api/providers/codex/profiles/${DEFAULT_ACCOUNT_PROFILE_ID}/probe`)).status,
      400,
    );
  });

  it("PATCH /api/settings ignores providerProfiles", async () => {
    const res = await patch("/api/settings", {
      providerProfiles: [{ id: "x", provider: "claude", label: "Sneaky", configDir: workDir }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.providerProfiles, []);
    assert.equal(manager.sessionDb.getGlobalSettings().provider_profiles_json ?? null, null);
  });
});
