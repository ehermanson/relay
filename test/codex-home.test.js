// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexSpawnEnv,
  resolveCodexHomeDir,
} from "../dist/server/core/providers/codex-cli.js";
import {
  clearCodexModelsCache,
  getCachedCodexModels,
  refreshCodexModelsIfStale,
} from "../dist/server/core/providers/codex-models.js";
import {
  CodexAppServerSession,
  clearCodexAccountIdentityCache,
  codexAccountIdentityFromStatus,
  fetchCodexProviderGlobalStateSnapshot,
  getCodexAccountIdentitySnapshot,
  probeCodexAccountIdentity,
} from "../dist/server/core/providers/codex-app-server.js";
import { getProviderDriver } from "../dist/server/core/provider-registry.js";
import {
  clearCodexAgentHistoryCache,
  resolveCodexAgentRolloutPath,
} from "../dist/server/core/providers/codex-transcript.js";

// The driver resolves the binary lazily; tests must not depend on a host install.
process.env.RELAY_CODEX_CLI_PATH ??= "/usr/local/bin/codex";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
const DEFAULT_HOME = join(homedir(), ".codex");

/**
 * A fake `codex app-server`: answers each JSON-RPC request from `respond`,
 * which sees the method and the env the process was spawned with.
 */
function fakeAppServer(respond) {
  const spawns = [];
  return {
    spawns,
    spawnProcess(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      spawns.push({ command, args, options });
      let buffer = "";
      child.stdin.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          const msg = JSON.parse(line);
          if (msg.id === undefined) continue;
          const result = respond(msg.method, options.env ?? {});
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
        }
      });
      return child;
    },
  };
}

describe("resolveCodexHomeDir", () => {
  it("prefers CODEX_DIR, then CODEX_HOME, then ~/.codex", () => {
    assert.equal(resolveCodexHomeDir({}), DEFAULT_HOME);
    assert.equal(resolveCodexHomeDir({ CODEX_HOME: "/tmp/codex-work" }), "/tmp/codex-work");
    assert.equal(
      resolveCodexHomeDir({ CODEX_HOME: "/tmp/codex-work", CODEX_DIR: "/tmp/codex-relay" }),
      "/tmp/codex-relay",
    );
    assert.equal(resolveCodexHomeDir({ CODEX_DIR: "  ", CODEX_HOME: "" }), DEFAULT_HOME);
  });

  it("expands ~ and resolves to an absolute, normalized path", () => {
    assert.equal(
      resolveCodexHomeDir({ CODEX_HOME: "~/.codex-work/" }),
      join(homedir(), ".codex-work"),
    );
    assert.equal(resolveCodexHomeDir({ CODEX_DIR: "/tmp/a/../codex" }), "/tmp/codex");
  });
});

describe("buildCodexSpawnEnv", () => {
  // A preset host path keeps these independent of whether ChatGPT.app exists.
  const base = { PATH: "/usr/bin", CODEX_CODE_MODE_HOST_PATH: "/opt/host" };

  it("returns the env untouched when no home is given", () => {
    assert.equal(buildCodexSpawnEnv(undefined, base), base);
  });

  it("leaves the env untouched when it already resolves to the home", () => {
    // Unset CODEX_HOME + the default home: a single-account install.
    assert.equal(buildCodexSpawnEnv(DEFAULT_HOME, base), base);
    assert.equal(buildCodexSpawnEnv("~/.codex/", base), base);
    // Explicit CODEX_HOME that already agrees (even spelled differently).
    const explicit = { ...base, CODEX_HOME: "/tmp/codex-work/" };
    assert.equal(buildCodexSpawnEnv("/tmp/codex-work", explicit), explicit);
  });

  it("pins CODEX_HOME when the home differs from what the env resolves to", () => {
    const pinned = buildCodexSpawnEnv("/tmp/codex-work", base);
    assert.notEqual(pinned, base);
    assert.equal(pinned.CODEX_HOME, "/tmp/codex-work");
    assert.equal(pinned.PATH, "/usr/bin");
    assert.equal(base.CODEX_HOME, undefined, "base env is never mutated");

    // The default home under an env that points elsewhere is pinned back.
    const elsewhere = { ...base, CODEX_HOME: "/tmp/codex-work" };
    assert.equal(buildCodexSpawnEnv(DEFAULT_HOME, elsewhere).CODEX_HOME, DEFAULT_HOME);
  });

  it("pins the home when only Relay's CODEX_DIR override names it (the CLI never reads CODEX_DIR)", () => {
    const env = { ...base, CODEX_DIR: "/tmp/codex-relay" };
    assert.equal(buildCodexSpawnEnv(resolveCodexHomeDir(env), env).CODEX_HOME, "/tmp/codex-relay");
  });

  it("keeps the code-mode host injection alongside the pin, and a user value wins", () => {
    const pinned = buildCodexSpawnEnv("/tmp/codex-work", base);
    assert.equal(pinned.CODEX_CODE_MODE_HOST_PATH, "/opt/host");

    const bare = { PATH: "/usr/bin" };
    const env = buildCodexSpawnEnv("/tmp/codex-work", bare);
    assert.equal(env.CODEX_HOME, "/tmp/codex-work");
    const aligned = buildCodexSpawnEnv(undefined, bare);
    // Injection depends on the host binary being present on this machine; the
    // pin must not change whether it happens.
    assert.equal(env.CODEX_CODE_MODE_HOST_PATH, aligned.CODEX_CODE_MODE_HOST_PATH);
    if (aligned.CODEX_CODE_MODE_HOST_PATH === undefined) assert.equal(aligned, bare);
  });
});

describe("Codex spawns carry the home", () => {
  it("pins CODEX_HOME on a session bound to a non-default home, and not otherwise", () => {
    const server = fakeAppServer(() => ({}));
    const bound = new CodexAppServerSession({
      cwd: "/tmp",
      logger: noopLogger,
      spawnProcess: server.spawnProcess,
      codexPath: "/usr/local/bin/codex",
      codexHome: "/tmp/codex-work",
    });
    bound.send("hi");
    assert.equal(server.spawns[0].options.env.CODEX_HOME, "/tmp/codex-work");
    bound.close?.();

    const inherited = new CodexAppServerSession({
      cwd: "/tmp",
      logger: noopLogger,
      spawnProcess: server.spawnProcess,
      codexPath: "/usr/local/bin/codex",
    });
    inherited.send("hi");
    assert.equal(server.spawns[1].options.env.CODEX_HOME, process.env.CODEX_HOME);
    inherited.close?.();
  });

  it("the driver's createSession passes config.providerDirs.codex as the home", () => {
    const session = getProviderDriver("codex").createSession(
      {
        workingDirectory: "/tmp",
        defaultRuntimeMode: "full-access",
        processTimeout: 0,
        logger: noopLogger,
        providerDirs: { claude: "/tmp/claude", codex: "/tmp/codex-work" },
      },
      { model: "gpt-5.4" },
      { providerDirs: { claude: "/tmp/claude", codex: "/tmp/ignored" }, logger: noopLogger },
    );
    assert.equal(session.codexHome, "/tmp/codex-work");
  });

  it("runs the global-state snapshot under the requested home", async () => {
    const server = fakeAppServer(() => ({}));
    await fetchCodexProviderGlobalStateSnapshot({
      cwd: "/tmp",
      logger: noopLogger,
      spawnProcess: server.spawnProcess,
      codexPath: "codex",
      codexHome: "/tmp/codex-work",
    });
    assert.equal(server.spawns[0].options.env.CODEX_HOME, "/tmp/codex-work");
  });
});

describe("Codex model cache is per home", () => {
  afterEach(() => clearCodexModelsCache());

  const modelsFor = (env) => {
    const name = env.CODEX_HOME === "/tmp/codex-work" ? "work-model" : "personal-model";
    return { data: [{ id: name, model: name, displayName: name }] };
  };

  it("keeps each home's list, staleness and probe independent", async () => {
    clearCodexModelsCache();
    const server = fakeAppServer((method, env) => (method === "model/list" ? modelsFor(env) : {}));
    const options = { spawnProcess: server.spawnProcess, codexPath: "codex", logger: noopLogger };

    await refreshCodexModelsIfStale({ ...options, codexHome: "/tmp/codex-work" });
    assert.deepEqual(
      getCachedCodexModels("/tmp/codex-work").map((m) => m.id),
      ["work-model"],
    );
    assert.equal(getCachedCodexModels("/tmp/codex-personal"), null, "other home stays cold");
    assert.equal(getCachedCodexModels(), null, "default home stays cold");

    await refreshCodexModelsIfStale({ ...options, codexHome: "/tmp/codex-personal" });
    assert.deepEqual(
      getCachedCodexModels("/tmp/codex-personal").map((m) => m.id),
      ["personal-model"],
    );
    assert.deepEqual(
      getCachedCodexModels("/tmp/codex-work/").map((m) => m.id),
      ["work-model"],
      "first home is not clobbered (and keys are normalized)",
    );
    assert.equal(server.spawns.length, 2);
    assert.equal(server.spawns[0].options.env.CODEX_HOME, "/tmp/codex-work");
    assert.equal(server.spawns[1].options.env.CODEX_HOME, "/tmp/codex-personal");

    // Fresh per home: no re-probe within the TTL.
    await refreshCodexModelsIfStale({ ...options, codexHome: "/tmp/codex-work" });
    assert.equal(server.spawns.length, 2);
  });

  it("an absent home is the server's resolved home", async () => {
    clearCodexModelsCache();
    const server = fakeAppServer((method, env) => (method === "model/list" ? modelsFor(env) : {}));
    await refreshCodexModelsIfStale({ spawnProcess: server.spawnProcess, codexPath: "codex" });
    assert.ok(getCachedCodexModels());
    assert.deepEqual(getCachedCodexModels(resolveCodexHomeDir()), getCachedCodexModels());
  });
});

describe("Codex account identity", () => {
  afterEach(() => clearCodexAccountIdentityCache());

  it("maps an account status to an identity", () => {
    assert.deepEqual(
      codexAccountIdentityFromStatus({
        email: "a@work.example",
        plan: "team",
        label: "ChatGPT account",
        status: "auth_required",
        rateLimits: [],
      }),
      { email: "a@work.example", plan: "team", label: "ChatGPT account" },
    );
    assert.deepEqual(codexAccountIdentityFromStatus({ label: "API key", status: "api_key" }), {
      label: "API key",
      status: "api_key",
    });
    assert.equal(codexAccountIdentityFromStatus({ status: "auth_required" }), undefined);
    assert.equal(codexAccountIdentityFromStatus(undefined), undefined);
  });

  it("probes per home, caches, dedupes in-flight probes, and honours force", async () => {
    const accounts = {
      "/tmp/codex-work": {
        account: { type: "chatgpt", email: "a@work.example", planType: "team" },
        requiresOpenaiAuth: true,
      },
      "/tmp/codex-empty": { account: null, requiresOpenaiAuth: true },
    };
    const server = fakeAppServer((method, env) =>
      method === "account/read" ? accounts[env.CODEX_HOME] : {},
    );
    const options = { spawnProcess: server.spawnProcess, codexPath: "codex" };

    assert.deepEqual(getCodexAccountIdentitySnapshot("/tmp/codex-work"), { probeState: "unknown" });

    const [first, second] = await Promise.all([
      probeCodexAccountIdentity("/tmp/codex-work", noopLogger, options),
      probeCodexAccountIdentity("/tmp/codex-work/", noopLogger, options),
    ]);
    assert.equal(server.spawns.length, 1, "concurrent probes share one spawn");
    assert.equal(server.spawns[0].options.env.CODEX_HOME, "/tmp/codex-work");
    assert.deepEqual(first, second);
    assert.equal(first.probeState, "ok");
    assert.deepEqual(first.identity, {
      email: "a@work.example",
      plan: "team",
      label: "ChatGPT account",
    });
    assert.ok(first.probedAt);
    assert.deepEqual(getCodexAccountIdentitySnapshot("/tmp/codex-work"), first);

    await probeCodexAccountIdentity("/tmp/codex-work", noopLogger, options);
    assert.equal(server.spawns.length, 1, "served from cache within the TTL");
    await probeCodexAccountIdentity("/tmp/codex-work", noopLogger, { ...options, force: true });
    assert.equal(server.spawns.length, 2, "force bypasses the TTL");

    const empty = await probeCodexAccountIdentity("/tmp/codex-empty", noopLogger, options);
    assert.equal(empty.probeState, "error");
    assert.equal(empty.probeError, "Not signed in");
    assert.equal(empty.identity, undefined);
    assert.equal(
      getCodexAccountIdentitySnapshot("/tmp/codex-work").probeState,
      "ok",
      "homes do not collide",
    );
  });

  it("is exposed through the codex driver hooks", () => {
    const driver = getProviderDriver("codex");
    assert.equal(driver.capabilities.supportsAccountLogins, true);
    assert.equal(typeof driver.probeAccountIdentity, "function");
    assert.deepEqual(driver.getAccountIdentitySnapshot("/tmp/codex-never-probed"), {
      probeState: "unknown",
    });
  });
});

describe("Codex rollouts across homes", () => {
  const dirs = [];
  afterEach(() => {
    clearCodexAgentHistoryCache();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeHome(threadId, cwd) {
    const home = mkdtempSync(join(tmpdir(), "relay-codex-home-"));
    dirs.push(home);
    const day = join(home, "sessions", "2026", "09", "30");
    mkdirSync(day, { recursive: true });
    const file = join(day, `rollout-2026-09-30T10-00-00-${threadId}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: { id: threadId, cwd, originator: "codex_cli_rs" },
      }) + "\n",
    );
    return { home, file };
  }

  it("rollout lookups are keyed by the home they were asked for", () => {
    const threadId = "11111111-2222-3333-4444-555555555555";
    const a = makeHome(threadId, "/tmp/project");
    const b = makeHome(threadId, "/tmp/project");
    assert.equal(resolveCodexAgentRolloutPath(a.home, threadId), a.file);
    assert.equal(resolveCodexAgentRolloutPath(b.home, threadId), b.file);
    assert.equal(resolveCodexAgentRolloutPath(a.home, threadId), a.file);
  });

  it("external discovery walks every root in providerRoots.codex", async () => {
    const cwd = "/tmp/relay-codex-home-project";
    const a = makeHome("aaaaaaaa-2222-3333-4444-555555555555", cwd);
    const b = makeHome("bbbbbbbb-2222-3333-4444-555555555555", cwd);
    const context = {
      providerDirs: { claude: "/tmp/none", codex: a.home },
      logger: noopLogger,
      excludePids: new Set(),
      runningProcessCwds: new Map([["codex", new Map()]]),
      registeredDirectories: new Set([cwd]),
      transcriptActivityWindowMs: 60_000,
    };
    const driver = getProviderDriver("codex");

    const onlyDefault = await driver.discoverExternalSessions(context);
    assert.deepEqual(
      onlyDefault.map((s) => s.transcriptPath),
      [a.file],
    );

    const both = await driver.discoverExternalSessions({
      ...context,
      providerRoots: { codex: [a.home, b.home, a.home] },
    });
    assert.deepEqual(both.map((s) => s.transcriptPath).sort(), [a.file, b.file].sort());
  });
});
