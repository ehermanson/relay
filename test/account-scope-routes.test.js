// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * `?accountId=` on account-scoped routes:
 *   GET /api/provider-models?provider=claude&accountId=
 *   GET /api/providers/claude/mcp-servers?projectId=&accountId=
 *
 * An absent, `default`, or unknown id (and any id on a single-account
 * provider) takes exactly the pre-accounts path; a known non-default id
 * scopes the read to that account's config dir.
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
import {
  resolveAccountConfigDir,
  resolveAccountLoginRoots,
} from "../dist/server/core/account-scope.js";

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
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
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
  supportsAccountLogins: true,
  mcp: { management: { transports: ["http", "sse", "stdio"], scopes: ["global", "project"] } },
};
const codexCapabilities = { ...claudeCapabilities, supportsAccountLogins: false };

describe("account-scoped routes (?accountId=)", () => {
  let server;
  let manager;
  let tempDir;
  let defaultClaudeDir;
  let workDir;
  let projectDir;
  let project;
  let cookie;
  let depsModelCalls;
  let managerModelCalls;

  beforeEach((_, done) => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-account-scope-"));
    defaultClaudeDir = join(tempDir, ".claude");
    workDir = join(tempDir, ".claude-work");
    projectDir = join(tempDir, "repo");
    for (const dir of [defaultClaudeDir, workDir, projectDir]) mkdirSync(dir, { recursive: true });
    execSync("git init", { cwd: projectDir, stdio: "pipe" });

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
    const auth = new AuthManager(config);
    manager = new InstanceManager(config);
    manager.sessionDb.updateGlobalSettings({
      accounts_json: JSON.stringify([
        { id: "work", label: "Work", logins: { claude: { configDir: workDir } } },
      ]),
    });
    project = manager.projectManager.addProject(projectDir);

    depsModelCalls = [];
    managerModelCalls = [];
    manager.getProviderModels = async (provider, configDir) => {
      managerModelCalls.push({ provider, configDir });
      return [{ provider, id: "claude-work-model", label: "Work model", isDefault: true }];
    };
    const handler = createRequestHandler(config, auth, manager, undefined, {
      getProviderModels: async (provider) => {
        depsModelCalls.push(provider);
        return [{ provider, id: "claude-default-model", label: "Default model", isDefault: true }];
      },
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
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
    server.close(done);
  });

  const get = (path) => request(server, "GET", path, { headers: { Cookie: cookie } });

  it("resolveAccountConfigDir: absent/default/unknown/no-login all mean the default path", () => {
    const seen = [];
    const logger = { debug: (m) => seen.push(m) };
    assert.equal(resolveAccountConfigDir(manager, "claude", undefined, logger), undefined);
    assert.equal(resolveAccountConfigDir(manager, "claude", "", logger), undefined);
    assert.equal(resolveAccountConfigDir(manager, "claude", "default", logger), undefined);
    assert.equal(resolveAccountConfigDir(manager, "claude", "nope", logger), undefined);
    // "work" has no Codex login: unavailable there, never another account's dir.
    assert.equal(resolveAccountConfigDir(manager, "codex", "work", logger), undefined);
    assert.equal(resolveAccountConfigDir(manager, "claude", "work", logger), workDir);
    assert.equal(resolveAccountConfigDir(manager, "claude", " work ", logger), workDir);
    assert.deepEqual(
      seen.map((m) => m.includes('Unknown account "nope"')),
      [true],
      "only the unknown id is logged",
    );
  });

  it("resolveAccountLoginRoots: no account = aggregate, an account = its own login, no login = nothing", () => {
    const logger = { debug: () => {} };
    // Absent: the caller keeps its union-across-roots read (single-account/legacy).
    assert.equal(resolveAccountLoginRoots(manager, "claude", undefined, logger), undefined);
    assert.equal(resolveAccountLoginRoots(manager, "claude", "", logger), undefined);
    // The default account reads only the server's own dir — never another account's files.
    assert.deepEqual(resolveAccountLoginRoots(manager, "claude", "default", logger), [
      manager.getProviderDirs().claude,
    ]);
    assert.deepEqual(resolveAccountLoginRoots(manager, "claude", "work", logger), [workDir]);
    // "work" has no Codex login: nothing, not the default's Codex files.
    assert.deepEqual(resolveAccountLoginRoots(manager, "codex", "work", logger), []);
    // Unknown ids read as the default account.
    assert.deepEqual(resolveAccountLoginRoots(manager, "claude", "nope", logger), [
      manager.getProviderDirs().claude,
    ]);
  });

  it("resolveAccountConfigDir needs only `accounts.resolveLogin` from its source", () => {
    const calls = [];
    const source = {
      accounts: {
        resolveLogin(accountId, provider) {
          calls.push([accountId, provider]);
          return accountId === "a"
            ? { available: true, account: { id: "a" }, configDir: "/x" }
            : { available: false, account: { id: "default" } };
        },
      },
    };
    assert.equal(resolveAccountConfigDir(source, "codex", "a"), "/x");
    assert.equal(resolveAccountConfigDir(source, "codex", "b"), undefined);
    assert.equal(resolveAccountConfigDir(source, "codex", "default"), undefined);
    assert.deepEqual(calls, [
      ["a", "codex"],
      ["b", "codex"],
    ]);
  });

  it("GET /api/provider-models scopes to the account's dir only for a known non-default id", async () => {
    const plain = await get("/api/provider-models?provider=claude");
    assert.equal(plain.status, 200);
    assert.equal(plain.body.models[0].id, "claude-default-model");

    const unknown = await get("/api/provider-models?provider=claude&accountId=gone");
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.models[0].id, "claude-default-model");

    const dflt = await get("/api/provider-models?provider=claude&accountId=default");
    assert.equal(dflt.body.models[0].id, "claude-default-model");
    assert.deepEqual(depsModelCalls, ["claude", "claude", "claude"]);
    assert.deepEqual(managerModelCalls, []);

    const work = await get("/api/provider-models?provider=claude&accountId=work");
    assert.equal(work.status, 200);
    assert.equal(work.body.provider, "claude");
    assert.equal(work.body.models[0].id, "claude-work-model");
    assert.equal(work.body.defaultModel?.id, "claude-work-model");
    assert.deepEqual(managerModelCalls, [{ provider: "claude", configDir: workDir }]);
    assert.equal(
      depsModelCalls.length,
      3,
      "the shared route cache is bypassed for another account",
    );

    // The account has no Codex login: the scoped routes take the default path.
    const codex = await get("/api/provider-models?provider=codex&accountId=work");
    assert.equal(codex.status, 200);
    assert.equal(codex.body.provider, "codex");
    assert.deepEqual(depsModelCalls, ["claude", "claude", "claude", "codex"]);
    assert.equal(managerModelCalls.length, 1);
  });

  it("GET /api/providers/claude/mcp-servers reads the account's .claude.json for a known id", async () => {
    writeFileSync(
      join(workDir, ".claude.json"),
      JSON.stringify({
        projects: {
          // Keyed by the registered (realpath'd) directory, as the CLI writes it.
          [project.directory]: {
            mcpServers: { "work-http": { type: "http", url: "https://work.example/mcp?token=x" } },
          },
        },
      }),
    );
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "npx", args: ["shared-mcp"] } } }),
    );

    const work = await get(
      `/api/providers/claude/mcp-servers?projectId=${project.id}&accountId=work`,
    );
    assert.equal(work.status, 200);
    assert.deepEqual(
      work.body.servers.map((s) => [s.name, s.scope, s.transport, s.target]),
      [
        ["work-http", "local", "http", "https://work.example/mcp"],
        ["shared", "project", "stdio", "npx"],
      ],
    );

    // Unknown id ⇒ the default account's config: only the shared project file
    // is guaranteed here (the default `.claude.json` is the server's own).
    const unknown = await get(
      `/api/providers/claude/mcp-servers?projectId=${project.id}&accountId=gone`,
    );
    assert.equal(unknown.status, 200);
    const plain = await get(`/api/providers/claude/mcp-servers?projectId=${project.id}`);
    assert.deepEqual(unknown.body, plain.body, "unknown id behaves exactly like no id");
    assert.ok(unknown.body.servers.some((s) => s.name === "shared"));
    assert.ok(!unknown.body.servers.some((s) => s.name === "work-http"));
  });
});
