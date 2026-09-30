// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Account routes:
 *   GET    /api/accounts[?probe=1]
 *   POST   /api/accounts
 *   PATCH  /api/accounts/:id
 *   DELETE /api/accounts/:id
 *   POST   /api/accounts/:id/probe
 *   GET    /api/providers?accountId=
 *
 * The identity probe is stubbed through the provider driver hooks so no
 * provider CLI is ever spawned.
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
import { DEFAULT_ACCOUNT_ID } from "../dist/server/core/types.js";

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

const baseCapabilities = {
  supportsResume: true,
  supportsTranscriptReplay: true,
  supportsApprovals: true,
  supportsUserInputRequests: true,
  supportsReasoningEffort: false,
  supportsFastMode: false,
  supportsModelSelection: true,
  supportsTitleUpdates: false,
};

describe("account routes", () => {
  let server;
  let auth;
  let manager;
  let tempDir;
  let defaultClaudeDir;
  let defaultCodexDir;
  let workClaudeDir;
  let workCodexDir;
  let cookie;
  let probeCalls;
  /** `${provider}:${configDir}` → snapshot returned by the stubbed drivers */
  let snapshots;
  /** Flipped per test: which providers advertise `supportsAccountLogins`. */
  let loginSupport;
  const drivers = ["claude", "codex"].map((kind) => {
    const driver = getProviderDriver(kind);
    return {
      kind,
      driver,
      probe: driver.probeAccountIdentity,
      snapshot: driver.getAccountIdentitySnapshot,
    };
  });

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-account-routes-"));
    defaultClaudeDir = join(tempDir, ".claude");
    defaultCodexDir = join(tempDir, ".codex");
    workClaudeDir = join(tempDir, ".claude-work");
    workCodexDir = join(tempDir, ".codex-work");
    for (const dir of [defaultClaudeDir, defaultCodexDir, workClaudeDir, workCodexDir])
      mkdirSync(dir, { recursive: true });
    writeFileSync(join(tempDir, "not-a-dir"), "x");

    probeCalls = [];
    snapshots = new Map();
    loginSupport = { claude: true, codex: true };
    for (const { kind, driver } of drivers) {
      driver.probeAccountIdentity = async (configDir, _logger, options) => {
        probeCalls.push({ provider: kind, configDir, force: Boolean(options?.force) });
        const snap = {
          probeState: "ok",
          identity: { email: `${kind}@${configDir.split("/").pop()}.test`, plan: "max" },
          probedAt: 1_700_000_000_000,
        };
        snapshots.set(`${kind}:${configDir}`, snap);
        return snap;
      };
      driver.getAccountIdentitySnapshot = (configDir) =>
        snapshots.get(`${kind}:${configDir}`) ?? { probeState: "unknown" };
    }

    const config = resolveConfig({
      password: "testpass",
      logger: noopLogger,
      maxProcesses: 5,
      serveUI: false,
      rateLimitMax: 100,
      rateLimitWindow: 60_000,
      sessionFile: join(tempDir, "sessions.json"),
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: { claude: defaultClaudeDir, codex: defaultCodexDir },
    });
    auth = new AuthManager(config);
    manager = new InstanceManager(config);
    const capabilities = (provider) => ({
      ...baseCapabilities,
      supportsAccountLogins: loginSupport[provider],
    });
    const handler = createRequestHandler(config, auth, manager, undefined, {
      getProviderModels: async () => [],
      getProviderCapabilities: capabilities,
      getAvailableProviders: () => [
        { provider: "claude", label: "Claude Code", capabilities: capabilities("claude") },
        { provider: "codex", label: "Codex", capabilities: capabilities("codex") },
      ],
      getOpenTargets: async (p) => ({ path: p, preferredTargetId: null, targets: [] }),
      openNativePath: async () => {},
    });
    cookie = `session=${auth.createSession().id}`;
    server = http.createServer(handler);
    server.listen(0, done);
  });

  afterEach((_, done) => {
    for (const { driver, probe, snapshot } of drivers) {
      driver.probeAccountIdentity = probe;
      driver.getAccountIdentitySnapshot = snapshot;
    }
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
    server.close(done);
  });

  const get = (path) => request(server, "GET", path, { headers: { Cookie: cookie } });
  const post = (path, body) => request(server, "POST", path, { headers: { Cookie: cookie }, body });
  const patch = (path, body) =>
    request(server, "PATCH", path, { headers: { Cookie: cookie }, body });
  const del = (path) => request(server, "DELETE", path, { headers: { Cookie: cookie } });
  const addWork = (logins = { claude: { configDir: workClaudeDir } }) =>
    post("/api/accounts", { label: "Work", logins });
  const storedAccounts = () => {
    const raw = manager.sessionDb.getGlobalSettings().accounts_json;
    return raw ? JSON.parse(raw) : null;
  };
  /** Let fire-and-forget probes settle. */
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("requires authentication", async () => {
    assert.equal((await request(server, "GET", "/api/accounts")).status, 401);
    assert.equal((await request(server, "POST", "/api/accounts", { body: {} })).status, 401);
  });

  it("the removed per-provider profile routes are gone", async () => {
    assert.equal((await get("/api/providers/claude/profiles")).status, 404);
    assert.equal(
      (await post("/api/providers/claude/profiles", { label: "X", configDir: workClaudeDir }))
        .status,
      404,
    );
  });

  it("lists the default account first with each login's identity and kicks background probes", async () => {
    const res = await get("/api/accounts");
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    const [row] = res.body;
    assert.equal(row.id, DEFAULT_ACCOUNT_ID);
    assert.equal(row.label, "Default");
    assert.equal(row.isDefault, true);
    assert.deepEqual(row.logins, {
      claude: { configDir: defaultClaudeDir, probeState: "unknown" },
      codex: { configDir: defaultCodexDir, probeState: "unknown" },
    });
    await tick();
    assert.deepEqual(probeCalls, [
      { provider: "claude", configDir: defaultClaudeDir, force: false },
      { provider: "codex", configDir: defaultCodexDir, force: false },
    ]);

    // The probe landed in the driver cache: the next list carries the identity.
    const again = await get("/api/accounts");
    assert.equal(again.body[0].logins.claude.probeState, "ok");
    assert.equal(again.body[0].logins.claude.identity.email, "claude@.claude.test");
    assert.equal(again.body[0].logins.codex.identity.email, "codex@.codex.test");
    assert.equal(again.body[0].logins.claude.probedAt, 1_700_000_000_000);

    // ?probe=1 forces a re-probe of every login.
    probeCalls = [];
    await get("/api/accounts?probe=1");
    await tick();
    assert.deepEqual(
      probeCalls.map((c) => c.force),
      [true, true],
    );
  });

  it("creates an account (201) with one login per provider, persists it and force-probes it", async () => {
    const res = await addWork({
      claude: { configDir: `${workClaudeDir}/` },
      codex: { configDir: workCodexDir },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.label, "Work");
    assert.equal(res.body.isDefault, false);
    assert.equal(res.body.logins.claude.configDir, workClaudeDir);
    assert.equal(res.body.logins.codex.configDir, workCodexDir);
    await tick();
    assert.ok(
      probeCalls.some((c) => c.provider === "claude" && c.configDir === workClaudeDir && c.force),
    );
    assert.ok(
      probeCalls.some((c) => c.provider === "codex" && c.configDir === workCodexDir && c.force),
    );

    assert.deepEqual(storedAccounts(), [
      {
        id: res.body.id,
        label: "Work",
        logins: { claude: { configDir: workClaudeDir }, codex: { configDir: workCodexDir } },
      },
    ]);
    // The manager's store sees it immediately (creation/discovery share it).
    assert.equal(manager.accounts.resolveLogin(res.body.id, "codex").configDir, workCodexDir);

    const list = await get("/api/accounts");
    assert.deepEqual(
      list.body.map((a) => a.id),
      [DEFAULT_ACCOUNT_ID, res.body.id],
    );
    assert.equal(list.body[1].logins.claude.probeState, "ok");
    assert.equal(list.body[1].logins.claude.identity.email, "claude@.claude-work.test");

    // GET /api/settings exposes the stored (non-default) accounts.
    const settings = await get("/api/settings");
    assert.equal(settings.body.accounts.length, 1);
    assert.equal(settings.body.accounts[0].id, res.body.id);
  });

  it("expands ~ in a login's configDir", async () => {
    const home = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const res = await addWork({ claude: { configDir: "~/.claude-work" } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.logins.claude.configDir, workClaudeDir);
    } finally {
      process.env.HOME = home;
    }
  });

  it("rejects bad input with a user-facing 400 and stores nothing", async () => {
    const claude = (configDir) => ({ claude: { configDir } });
    const cases = [
      [{ label: "", logins: claude(workClaudeDir) }, /Enter a name/],
      [{ label: "default", logins: claude(workClaudeDir) }, /"Default" already exists/],
      [{ label: "X" }, /at least one provider login/],
      [{ label: "X", logins: {} }, /at least one provider login/],
      [{ label: "X", logins: claude("relative") }, /absolute path/],
      [{ label: "X", logins: claude(join(tempDir, "missing")) }, /does not exist/],
      [{ label: "X", logins: claude(join(tempDir, "not-a-dir")) }, /not a directory/],
      [{ label: "X", logins: claude(defaultClaudeDir) }, /"Default" already uses/],
      [{ label: "X", logins: claude(`${defaultClaudeDir}/`) }, /"Default" already uses/],
      [{ label: "X", logins: { bogus: { configDir: workClaudeDir } } }, /bogus does not support/],
    ];
    for (const [body, pattern] of cases) {
      const res = await post("/api/accounts", body);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, pattern);
    }
    assert.equal(storedAccounts(), null);

    await addWork();
    const dupDir = await post("/api/accounts", {
      label: "Other",
      logins: { claude: { configDir: `${workClaudeDir}/` } },
    });
    assert.equal(dupDir.status, 400);
    assert.match(dupDir.body.error, /"Work" already uses that claude config directory/);
    const dupLabel = await post("/api/accounts", {
      label: "work",
      logins: { claude: { configDir: workCodexDir } },
    });
    assert.equal(dupLabel.status, 400);
    assert.match(dupLabel.body.error, /already exists/);
    assert.equal(storedAccounts().length, 1);
  });

  it("only providers advertising supportsAccountLogins can carry a login", async () => {
    loginSupport.codex = false;
    const res = await post("/api/accounts", {
      label: "X",
      logins: { codex: { configDir: workCodexDir } },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /codex does not support separate account logins/);
  });

  it("PATCH renames and/or replaces logins; the default account is label-only", async () => {
    const { body: created } = await addWork();
    const renamed = await patch(`/api/accounts/${created.id}`, { label: "Client" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.label, "Client");
    assert.equal(renamed.body.logins.claude.configDir, workClaudeDir);
    assert.equal(renamed.body.isDefault, false);
    assert.equal(storedAccounts()[0].label, "Client");

    probeCalls = [];
    const relogged = await patch(`/api/accounts/${created.id}`, {
      logins: { claude: { configDir: workClaudeDir }, codex: { configDir: workCodexDir } },
    });
    assert.equal(relogged.status, 200, JSON.stringify(relogged.body));
    assert.equal(relogged.body.label, "Client");
    assert.deepEqual(Object.keys(relogged.body.logins), ["claude", "codex"]);
    await tick();
    assert.ok(
      probeCalls.some((c) => c.provider === "codex" && c.configDir === workCodexDir && c.force),
    );

    // Dropping a login makes the provider unavailable in that account.
    const dropped = await patch(`/api/accounts/${created.id}`, {
      logins: { codex: { configDir: workCodexDir } },
    });
    assert.deepEqual(Object.keys(dropped.body.logins), ["codex"]);
    assert.equal(manager.accounts.resolveLogin(created.id, "claude").available, false);

    const badDir = await patch(`/api/accounts/${created.id}`, {
      logins: { claude: { configDir: join(tempDir, "missing") } },
    });
    assert.equal(badDir.status, 400);
    assert.match(badDir.body.error, /does not exist/);
    const noLogins = await patch(`/api/accounts/${created.id}`, { logins: {} });
    assert.equal(noLogins.status, 400);
    const dupe = await patch(`/api/accounts/${created.id}`, { label: "default" });
    assert.equal(dupe.status, 400);
    assert.match(dupe.body.error, /already exists/);
    assert.equal((await patch("/api/accounts/nope", { label: "X" })).status, 404);

    // Default account: renamable, logins are the server's own.
    const dflt = await patch(`/api/accounts/${DEFAULT_ACCOUNT_ID}`, { label: "Personal" });
    assert.equal(dflt.status, 200, JSON.stringify(dflt.body));
    assert.equal(dflt.body.label, "Personal");
    assert.equal(dflt.body.isDefault, true);
    assert.equal(dflt.body.logins.claude.configDir, defaultClaudeDir);
    const dfltLogins = await patch(`/api/accounts/${DEFAULT_ACCOUNT_ID}`, {
      logins: { claude: { configDir: workClaudeDir } },
    });
    assert.equal(dfltLogins.status, 400);
    assert.match(dfltLogins.body.error, /cannot be edited/);
    const list = await get("/api/accounts");
    assert.deepEqual(
      list.body.map((a) => [a.id, a.label]),
      [
        [DEFAULT_ACCOUNT_ID, "Personal"],
        [created.id, "Client"],
      ],
    );
  });

  it("DELETE removes the account and drops it from every project's membership", async () => {
    const { body: created } = await addWork();

    const mkRepo = (name) => {
      const dir = join(tempDir, name);
      mkdirSync(dir);
      execSync("git init -q", { cwd: dir });
      return dir;
    };
    const onlyWork = manager.projectManager.addProject(mkRepo("only-work"), {
      accountId: created.id,
    });
    const both = manager.projectManager.addProject(mkRepo("both"));
    manager.projectManager.updateProject(both.id, { accountIds: ["default", created.id] });
    const untouched = manager.projectManager.addProject(mkRepo("untouched"));

    const res = await del(`/api/accounts/${created.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true });

    // Stored as [] on purpose: null would read as "never migrated" and bring
    // the legacy profile list back.
    assert.deepEqual(storedAccounts(), []);
    assert.equal((await get("/api/settings")).body.accounts.length, 0);
    // An emptied project falls back to the default account.
    assert.deepEqual(manager.projectManager.getProject(onlyWork.id).accountIds, ["default"]);
    assert.deepEqual(manager.projectManager.getProject(both.id).accountIds, ["default"]);
    assert.deepEqual(manager.projectManager.getProject(untouched.id).accountIds, ["default"]);

    assert.equal((await del(`/api/accounts/${created.id}`)).status, 404);
    const dflt = await del(`/api/accounts/${DEFAULT_ACCOUNT_ID}`);
    assert.equal(dflt.status, 400);
    assert.match(dflt.body.error, /cannot be removed/);
  });

  it("project routes take accountId; PATCH accountIds validates against the account list", async () => {
    const { body: created } = await addWork();
    const projectDir = join(tempDir, "proj");
    mkdirSync(projectDir);
    execSync("git init -q", { cwd: projectDir });

    const unknown = await post("/api/projects", { directory: projectDir, accountId: "ghost" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Unknown account: ghost/);
    const badType = await post("/api/projects", { directory: projectDir, accountId: 3 });
    assert.equal(badType.status, 400);
    assert.match(badType.body.error, /accountId must be a string/);

    const added = await post("/api/projects", { directory: projectDir, accountId: created.id });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual(added.body.accountIds, [created.id]);
    assert.equal("defaultProfileId" in added.body, false);

    // The legacy param is not an alias: it is ignored (default account).
    const legacyDir = join(tempDir, "legacy");
    mkdirSync(legacyDir);
    execSync("git init -q", { cwd: legacyDir });
    const legacy = await post("/api/projects", { directory: legacyDir, profileId: created.id });
    assert.deepEqual(legacy.body.accountIds, ["default"]);

    const patched = await patch(`/api/projects/${added.body.id}`, {
      accountIds: ["default", created.id],
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual(patched.body.accountIds, ["default", created.id]);
    const bad = await patch(`/api/projects/${added.body.id}`, { accountIds: ["ghost"] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Unknown account: ghost/);

    const init = await post("/api/projects/init", {
      parentDirectory: tempDir,
      name: "fresh",
      accountId: created.id,
    });
    assert.equal(init.status, 201, JSON.stringify(init.body));
    assert.deepEqual(init.body.accountIds, [created.id]);
  });

  it("POST /:id/probe awaits a forced probe of every login and returns the row", async () => {
    const { body: created } = await addWork({
      claude: { configDir: workClaudeDir },
      codex: { configDir: workCodexDir },
    });
    await tick();
    probeCalls = [];
    const claude = getProviderDriver("claude");
    claude.probeAccountIdentity = async (configDir, _logger, options) => {
      probeCalls.push({ provider: "claude", configDir, force: Boolean(options?.force) });
      const snap = { probeState: "error", probeError: "Not signed in", probedAt: 42 };
      snapshots.set(`claude:${configDir}`, snap);
      return snap;
    };
    const res = await post(`/api/accounts/${created.id}/probe`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(probeCalls, [
      { provider: "claude", configDir: workClaudeDir, force: true },
      { provider: "codex", configDir: workCodexDir, force: true },
    ]);
    assert.equal(res.body.id, created.id);
    assert.equal(res.body.logins.claude.probeState, "error");
    assert.equal(res.body.logins.claude.probeError, "Not signed in");
    assert.equal(res.body.logins.claude.probedAt, 42);
    assert.equal(res.body.logins.codex.probeState, "ok");

    // A probe that throws never fails the request.
    claude.probeAccountIdentity = async () => {
      throw new Error("spawn failed");
    };
    assert.equal((await post(`/api/accounts/${created.id}/probe`)).status, 200);

    const dflt = await post(`/api/accounts/${DEFAULT_ACCOUNT_ID}/probe`);
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.isDefault, true);
    assert.equal((await post("/api/accounts/nope/probe")).status, 404);
  });

  it("GET /api/providers?accountId= lists only providers with a login in that account", async () => {
    const { body: created } = await addWork({ codex: { configDir: workCodexDir } });
    const names = (res) => res.body.providers.map((p) => p.provider);

    assert.deepEqual(names(await get("/api/providers")), ["claude", "codex"]);
    assert.deepEqual(names(await get("/api/providers?accountId=default")), ["claude", "codex"]);
    assert.deepEqual(names(await get("/api/providers?accountId=gone")), ["claude", "codex"]);
    // Work has no Claude login: Claude is unavailable there — never a fallback.
    assert.deepEqual(names(await get(`/api/providers?accountId=${created.id}`)), ["codex"]);

    await patch(`/api/accounts/${created.id}`, {
      logins: { claude: { configDir: workClaudeDir }, codex: { configDir: workCodexDir } },
    });
    assert.deepEqual(names(await get(`/api/providers?accountId=${created.id}`)), [
      "claude",
      "codex",
    ]);
  });

  it("PATCH /api/settings ignores accounts and providerProfiles", async () => {
    const res = await patch("/api/settings", {
      accounts: [{ id: "x", label: "Sneaky", logins: { claude: { configDir: workClaudeDir } } }],
      providerProfiles: [
        { id: "y", provider: "claude", label: "Sneaky", configDir: workClaudeDir },
      ],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.accounts, []);
    const row = manager.sessionDb.getGlobalSettings();
    assert.equal(row.accounts_json ?? null, null);
    assert.equal(row.provider_profiles_json ?? null, null);
  });
});
