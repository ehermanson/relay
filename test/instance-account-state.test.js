// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Provider state per account: global state (account identity, rate limits,
 * MCP servers, notices) and SDK model discovery are keyed by config dir, so
 * a second Claude login never bleeds into the default account's view.
 *
 *  (a) a live session bound to a non-default dir updates only its own key;
 *      the default account's state is untouched
 *  (b) persisted `provider-state.json` round-trips `configDir` on non-default
 *      states only, and files without it load as the default account
 *  (c) `listProviderGlobalState()` (the WS list payload) carries `configDir`
 *      only on non-default states
 *  (d) two config dirs hold independent SDK model caches
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager, providerStateKey } from "../dist/server/core/instance-manager.js";
import {
  loadPersistedProviderState,
  persistProviderState,
  providerStateFilePath,
} from "../dist/server/core/provider-state-file.js";
import {
  clearSdkDiscoveryCache,
  createSdkSessionSync,
  getSdkDiscoveredModels,
} from "../dist/server/core/providers/claude-sdk.js";
import { getProviderDriver } from "../dist/server/core/provider-registry.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

class FakeProviderSession extends EventEmitter {
  constructor() {
    super();
    this.provider = "claude";
    this.isProcessing = false;
    this.pid = undefined;
    this.stats = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }
  send() {}
  interrupt() {}
  close() {}
  setModel() {}
  addAllowedTool() {}
  setRuntimeMode() {}
  setSessionId() {}
  getRuntimeBinding() {
    return { provider: "claude" };
  }
  respondToRequest() {
    return false;
  }
}

function setup(cleanups) {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-account-state-")));
  const defaultRoot = join(tempDir, ".claude");
  const workRoot = join(tempDir, ".claude-work");
  const projectDir = join(tempDir, "repo");
  for (const dir of [defaultRoot, workRoot, projectDir]) mkdirSync(dir, { recursive: true });
  const config = resolveConfig({
    password: "test",
    logger: noopLogger,
    maxProcesses: 10,
    dbPath: join(tempDir, "sessions.db"),
    providerDirs: { claude: defaultRoot, codex: join(tempDir, ".codex") },
    workingDirectory: projectDir,
  });
  const manager = new InstanceManager(config);
  cleanups.push(() => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });
  // The runner's shared provider-state backstop dir is per process: give
  // each manager its own file and forget anything an earlier test persisted.
  manager._providerStateFilePath = join(tempDir, "provider-state.json");
  manager.providerGlobalState.clear();
  const codexWorkRoot = join(tempDir, ".codex-work");
  manager.sessionDb.updateGlobalSettings({
    accounts_json: JSON.stringify([
      {
        id: "work",
        label: "Work",
        logins: { claude: { configDir: workRoot }, codex: { configDir: codexWorkRoot } },
      },
    ]),
  });
  manager.createProviderSession = () => new FakeProviderSession();
  return { tempDir, defaultRoot, workRoot, codexWorkRoot, projectDir, config, manager };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Emit a provider_status system event from a chat's fake session. */
function emitProviderStatus(manager, instanceId, payload) {
  manager.instances.get(instanceId).process.emit("systemEvent", {
    type: "system_event",
    event: "provider_status",
    payload,
  });
}

describe("provider global state per account", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("keys state by (provider, configDir): a bound session updates only its own account", async () => {
    const { manager, workRoot } = setup(cleanups);
    const updates = [];
    manager.on("provider_global_state:updated", (provider, state) => {
      updates.push({ provider, state });
    });

    const dflt = manager.createInstance({ provider: "claude" });
    const work = manager.createInstance({ provider: "claude", accountId: "work" });
    assert.equal(dflt.configDir, undefined);
    assert.equal(work.configDir, workRoot);

    emitProviderStatus(manager, dflt.id, { account: { email: "me@personal.test", plan: "max" } });
    await tick();
    emitProviderStatus(manager, work.id, {
      account: {
        email: "me@work.test",
        plan: "team",
        rateLimits: [{ kind: "plan", windows: [{ label: "5h", utilization: 0.4 }] }],
      },
      mcpServers: [{ id: "work-mcp", name: "work-mcp", provider: "claude" }],
    });
    await tick();

    const states = manager.listProviderGlobalState();
    const defaultState = states.find((s) => s.provider === "claude" && !s.configDir);
    const workState = states.find((s) => s.provider === "claude" && s.configDir === workRoot);
    assert.ok(defaultState, "default account state exists");
    assert.ok(workState, "work account state exists");
    assert.equal(defaultState.account.email, "me@personal.test");
    assert.equal(
      defaultState.account.rateLimits,
      undefined,
      "work rate limits never reach default",
    );
    assert.equal(defaultState.mcpServers, undefined, "work MCP servers never reach default");
    assert.equal(workState.account.email, "me@work.test");
    assert.equal(workState.account.rateLimits[0].windows[0].utilization, 0.4);
    assert.equal(workState.mcpServers[0].name, "work-mcp");

    // The broadcast payload names the account only when it isn't the default.
    assert.deepEqual(
      updates.map((u) => [u.provider, u.state.configDir]),
      [
        ["claude", undefined],
        ["claude", workRoot],
      ],
    );
    assert.ok(!("configDir" in updates[0].state), "default state has no configDir key");

    // The direct getter resolves the same keys; a dir equal to the server's
    // own collapses onto the default account.
    assert.equal(manager.getProviderGlobalState("claude").account.email, "me@personal.test");
    assert.equal(manager.getProviderGlobalState("claude", workRoot).account.email, "me@work.test");
    assert.equal(
      manager.getProviderGlobalState("claude", manager.getProviderDirs().claude).account.email,
      "me@personal.test",
    );
    assert.equal(providerStateKey("claude"), "claude:");
    assert.equal(providerStateKey("claude", `${workRoot}/`), `claude:${workRoot}`);
  });

  it("records managed MCP configuration on the named account only", () => {
    const { manager, workRoot } = setup(cleanups);
    manager.recordManagedMcpConfiguration("claude", "work-only", workRoot);
    const states = manager.listProviderGlobalState();
    assert.equal(states.length, 1);
    assert.equal(states[0].configDir, workRoot);
    assert.ok(states[0].mcpServers.some((s) => s.name === "work-only"));
    assert.equal(manager.getProviderGlobalState("claude"), undefined);
  });

  it("persists configDir for non-default states and restores older files as the default account", async () => {
    const { manager, workRoot, tempDir, config } = setup(cleanups);
    const filePath = providerStateFilePath(join(tempDir, "relay-home"));
    mkdirSync(join(tempDir, "relay-home"), { recursive: true });
    manager._providerStateFilePath = filePath;

    const dflt = manager.createInstance({ provider: "claude" });
    const work = manager.createInstance({ provider: "claude", accountId: "work" });
    emitProviderStatus(manager, dflt.id, { account: { email: "me@personal.test" } });
    emitProviderStatus(manager, work.id, { account: { email: "me@work.test" } });
    await tick(700); // debounced write (~500ms)

    const written = JSON.parse(readFileSync(filePath, "utf8")).states;
    const writtenDefault = written.find((s) => s.provider === "claude" && !("configDir" in s));
    const writtenWork = written.find((s) => s.configDir === workRoot);
    assert.ok(writtenDefault, "default state persisted without configDir");
    assert.ok(writtenWork, "work state persisted with configDir");
    assert.equal(writtenDefault.account.email, "me@personal.test");
    assert.equal(writtenWork.account.email, "me@work.test");

    // Round-trip through the loader keeps the shapes.
    const loaded = loadPersistedProviderState(filePath);
    assert.deepEqual(
      loaded.map((s) => [s.provider, s.configDir]).sort(),
      [
        ["claude", undefined],
        ["claude", workRoot],
      ].sort(),
    );

    // A file from before accounts existed (no configDir) loads as the
    // default account; a configDir equal to the server's own collapses too;
    // a non-string configDir is dropped rather than keying a phantom account.
    const legacyPath = join(tempDir, "relay-home", "legacy.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        savedAt: 1,
        states: [
          { provider: "codex", updatedAt: 1, account: { plan: "pro" } },
          { provider: "claude", updatedAt: 1, configDir: 42, account: { plan: "max" } },
        ],
      }),
    );
    const legacy = loadPersistedProviderState(legacyPath);
    assert.deepEqual(
      legacy.map((s) => s.configDir),
      [undefined, undefined],
    );

    // A fresh manager restores each state under its own key.
    persistProviderState(filePath, [
      // A state stamped with the server's own dir is the default account
      // (restore is last-wins per key, so the plain entry below replaces it).
      {
        provider: "claude",
        updatedAt: 2,
        configDir: config.providerDirs.claude,
        account: { plan: "collapsed-onto-default" },
      },
      { provider: "claude", updatedAt: 2, account: { email: "restored@personal.test" } },
      {
        provider: "claude",
        updatedAt: 2,
        configDir: `${workRoot}/`,
        account: { email: "restored@work.test" },
      },
    ]);
    // `_providerStateFilePath` is derived from the relay dir at construction;
    // a second manager restores from the file through the constructor's path.
    const second = new InstanceManager({ ...config, dbPath: join(tempDir, "second.db") });
    cleanups.push(() => second.stopAll());
    second.providerGlobalState.clear();
    second.restorePersistedProviderState(filePath);
    const list = second.listProviderGlobalState();
    assert.equal(list.length, 2, "server-dir state collapsed onto the default key");
    assert.equal(list.find((s) => !s.configDir).account.email, "restored@personal.test");
    assert.equal(list.find((s) => s.configDir === workRoot).account.email, "restored@work.test");
  });

  it("hydrates a non-default account from that dir's identity snapshot, leaving the default alone", async () => {
    const { manager, workRoot, codexWorkRoot } = setup(cleanups);
    const driver = getProviderDriver("claude");
    const originalSnapshot = driver.getAccountIdentitySnapshot;
    const asked = [];
    driver.getAccountIdentitySnapshot = (configDir) => {
      asked.push(configDir);
      return configDir === workRoot
        ? { probeState: "ok", identity: { email: "probe@work.test", plan: "team" } }
        : { probeState: "unknown" };
    };
    cleanups.push(() => {
      driver.getAccountIdentitySnapshot = originalSnapshot;
    });

    await manager.ensureProviderGlobalState("claude", true, workRoot);
    assert.deepEqual(asked, [workRoot]);
    const work = manager.getProviderGlobalState("claude", workRoot);
    assert.equal(work.configDir, workRoot);
    assert.equal(work.account.email, "probe@work.test");
    assert.equal(work.account.plan, "team");
    assert.equal(
      manager.getProviderGlobalState("claude"),
      undefined,
      "a non-default hydration never touches the default key",
    );

    // The default account's hydration asks about the server's own dir; with
    // nothing known it creates no state at all (pre-accounts behaviour).
    await manager.ensureProviderGlobalState("claude", true);
    assert.deepEqual(asked, [workRoot, manager.getProviderDirs().claude]);
    assert.equal(manager.getProviderGlobalState("claude"), undefined);

    // The WS connect path hydrates every non-default login of every provider.
    assert.deepEqual(manager.listAccountConfigDirs("claude"), [workRoot]);
    assert.deepEqual(manager.listAccountConfigDirs("codex"), [codexWorkRoot]);
  });

  it("keys Codex state by login too: a non-default CODEX_HOME never collapses onto the default", () => {
    const { manager, codexWorkRoot } = setup(cleanups);
    manager.updateProviderGlobalState("codex", { account: { plan: "pro" } }, codexWorkRoot);
    assert.equal(manager.getProviderGlobalState("codex"), undefined);
    const work = manager.getProviderGlobalState("codex", codexWorkRoot);
    assert.equal(work.configDir, codexWorkRoot);
    assert.equal(work.account.plan, "pro");
    // The server's own dir is the default key and carries no configDir.
    manager.updateProviderGlobalState(
      "codex",
      { account: { plan: "plus" } },
      manager.getProviderDirs().codex,
    );
    assert.equal(manager.getProviderGlobalState("codex").configDir, undefined);
    assert.equal(manager.getProviderGlobalState("codex").account.plan, "plus");
  });
});

describe("SDK model discovery per account", () => {
  afterEach(() => clearSdkDiscoveryCache());

  const modelsFor = (family) => [
    { value: "default", displayName: `${family} default`, resolvedModel: `claude-${family}-4-6` },
    { value: `claude-${family}-4-6`, displayName: family, resolvedModel: `claude-${family}-4-6` },
  ];

  function fakeQuery(models) {
    const pending = () => new Promise(() => {});
    return {
      async *[Symbol.asyncIterator]() {
        await pending();
      },
      accountInfo: async () => ({ email: "x@y" }),
      supportedModels: async () => models,
      getContextUsage: pending,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: pending,
      setModel: pending,
      setPermissionMode: pending,
      applyFlagSettings: pending,
      interrupt: pending,
      close() {},
    };
  }

  it("two config dirs hold independent caches, and the driver reads the dir it was scoped to", async () => {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-account-models-")));
    const dirA = join(tempDir, "a");
    const dirB = join(tempDir, "b");
    const sessionA = createSdkSessionSync(
      { cwd: tempDir, logger: noopLogger, configDir: dirA },
      () => fakeQuery(modelsFor("opus")),
    );
    const sessionB = createSdkSessionSync(
      { cwd: tempDir, logger: noopLogger, configDir: `${dirB}/` },
      () => fakeQuery(modelsFor("sonnet")),
    );
    try {
      await tick();
      assert.deepEqual(
        getSdkDiscoveredModels(dirA).map((m) => m.value),
        ["default", "claude-opus-4-6"],
      );
      assert.deepEqual(
        getSdkDiscoveredModels(dirB).map((m) => m.value),
        ["default", "claude-sonnet-4-6"],
      );
      assert.equal(getSdkDiscoveredModels(join(tempDir, "c")), null);

      const driver = getProviderDriver("claude");
      const context = (claude, accountConfigDir) => ({
        providerDirs: { claude, codex: join(tempDir, ".codex") },
        logger: noopLogger,
        sdkQueryFn: null,
        ...(accountConfigDir ? { accountConfigDir } : {}),
      });
      const listA = await driver.getModels(context(dirA));
      const listB = await driver.getModels(context(dirB, dirB));
      assert.equal(listA.find((m) => m.isDefault)?.id, "claude-opus-4-6");
      assert.equal(listB.find((m) => m.isDefault)?.id, "claude-sonnet-4-6");
      // A cold, non-default dir without an SDK falls back to builtins rather than hanging.
      const listC = await driver.getModels(context(join(tempDir, "c"), join(tempDir, "c")));
      assert.ok(listC.length > 0);
      assert.ok(listC.every((m) => m.provider === "claude"));
    } finally {
      sessionA.close();
      sessionB.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
