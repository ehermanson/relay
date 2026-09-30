// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Accounts: a named context owning one login (config dir) per provider. A
 * chat is bound to one account + login for its whole life, and transcript
 * discovery covers every login root of every provider.
 *
 *  (a) creation binds `accountId` + the account's login dir for the chat's
 *      provider (Claude and Codex) and hands the dir to the provider session
 *  (b) a provider with no login in the account is unavailable there: explicit
 *      creation throws, provider defaulting skips it — never a fallback
 *  (c) a resume follows the root that holds its transcript
 *  (d) external chats are stamped from (provider, transcript root)
 *  (e) a restored managed row with `config_dir` resumes under that dir
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  InstanceManager,
  ProviderUnavailableInAccountError,
} from "../dist/server/core/instance-manager.js";
import { accountLoginRootFilter } from "../dist/server/core/db.js";
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
    this.sent = [];
  }
  send(text) {
    this.sent.push(text);
  }
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

/** A minimal Claude transcript: one user turn carrying the cwd. */
function writeTranscript(path, cwd, ageMs = 0) {
  const sessionId = path.split("/").pop().replace(".jsonl", "");
  const timestamp = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(
    path,
    JSON.stringify({
      type: "user",
      cwd,
      sessionId,
      timestamp,
      uuid: `${sessionId}-u1`,
      message: { role: "user", content: `hello from ${sessionId}` },
    }) + "\n",
  );
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    utimesSync(path, past, past);
  }
}

/** A minimal Codex rollout: `session_meta` plus one user turn. */
function writeCodexRollout(codexRoot, sessionId, cwd) {
  const dir = join(codexRoot, "sessions", "2026", "09", "30");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-30T10-00-00-${sessionId}.jsonl`);
  const timestamp = new Date().toISOString();
  writeFileSync(
    path,
    [
      { type: "session_meta", timestamp, payload: { id: sessionId, cwd, timestamp } },
      { type: "event_msg", timestamp, payload: { type: "user_message", message: "hello codex" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return path;
}

function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9_-]/g, "-");
}

function setup(cleanups) {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-accounts-")));
  const defaultRoot = join(tempDir, ".claude");
  const workRoot = join(tempDir, ".claude-work");
  const codexDir = join(tempDir, ".codex");
  const codexWorkRoot = join(tempDir, ".codex-work");
  const projectDir = join(tempDir, "projects", "repo");
  mkdirSync(projectDir, { recursive: true });
  execSync("git init", { cwd: projectDir, stdio: "pipe" });
  const encoded = encodeCwd(projectDir);
  const defaultProjectDir = join(defaultRoot, "projects", encoded);
  const workProjectDir = join(workRoot, "projects", encoded);
  mkdirSync(defaultProjectDir, { recursive: true });
  mkdirSync(workProjectDir, { recursive: true });

  const config = resolveConfig({
    password: "test",
    logger: noopLogger,
    maxProcesses: 10,
    dbPath: join(tempDir, "sessions.db"),
    providerDirs: { claude: defaultRoot, codex: codexDir },
    workingDirectory: projectDir,
  });
  const manager = new InstanceManager(config);
  cleanups.push(() => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });
  const project = manager.projectManager.addProject(projectDir);
  // "work" has a login for both providers; "solo" only uses Codex.
  const accounts = [
    {
      id: "work",
      label: "Work",
      logins: { claude: { configDir: workRoot }, codex: { configDir: codexWorkRoot } },
    },
    { id: "solo", label: "Solo", logins: { codex: { configDir: join(tempDir, ".codex-solo") } } },
  ];
  manager.sessionDb.updateGlobalSettings({ accounts_json: JSON.stringify(accounts) });
  return {
    accounts,
    codexWorkRoot,
    tempDir,
    defaultRoot,
    workRoot,
    codexDir,
    projectDir,
    project,
    encoded,
    defaultProjectDir,
    workProjectDir,
    config,
    manager,
  };
}

/** Capture what the manager asks the provider layer for, without spawning anything. */
function captureSessionCreation(manager) {
  const calls = [];
  manager.createProviderSession = (config, options) => {
    calls.push({ config, options });
    return new FakeProviderSession();
  };
  return calls;
}

/** A `query()` stub that records the SDK options and then stays silent forever. */
function stubSdkQuery(captured) {
  const pending = () => new Promise(() => {});
  return (params) => {
    captured.push(params.options);
    return {
      async *[Symbol.asyncIterator]() {
        await pending();
      },
      accountInfo: pending,
      supportedModels: pending,
      getContextUsage: pending,
      setModel: pending,
      setPermissionMode: pending,
      applyFlagSettings: pending,
      interrupt: pending,
      close() {},
    };
  };
}

describe("accounts", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("lists each provider's roots: the server's own first, then every account login, deduped", () => {
    const { manager, tempDir, defaultRoot, workRoot, codexDir, codexWorkRoot } = setup(cleanups);
    assert.deepEqual(manager.getProviderRoots("claude"), [defaultRoot, workRoot]);
    assert.deepEqual(manager.getProviderRoots("codex"), [
      codexDir,
      codexWorkRoot,
      join(tempDir, ".codex-solo"),
    ]);
    manager.sessionDb.updateGlobalSettings({
      accounts_json: JSON.stringify([
        { id: "work", label: "Work", logins: { claude: { configDir: `${workRoot}/` } } },
        { id: "dup", label: "Dup", logins: { claude: { configDir: workRoot } } },
        { id: "same", label: "Same as default", logins: { claude: { configDir: defaultRoot } } },
      ]),
    });
    assert.deepEqual(manager.getProviderRoots("claude"), [defaultRoot, workRoot]);
    assert.deepEqual(manager.getProviderRoots("codex"), [codexDir]);
    // The discovery context carries the same roots for every provider.
    assert.deepEqual(manager.getProviderContext().providerRoots, {
      claude: [defaultRoot, workRoot],
      codex: [codexDir],
    });
  });

  it("reads legacy per-provider profiles as one account each", () => {
    const { manager, defaultRoot, workRoot } = setup(cleanups);
    manager.sessionDb.updateGlobalSettings({
      accounts_json: null,
      provider_profiles_json: JSON.stringify([
        { id: "work", provider: "claude", label: "Work", configDir: workRoot },
      ]),
    });
    assert.deepEqual(manager.getProviderRoots("claude"), [defaultRoot, workRoot]);
    captureSessionCreation(manager);
    const info = manager.createInstance({ provider: "claude", accountId: "work" });
    assert.equal(info.accountId, "work");
    assert.equal(info.configDir, workRoot);
  });

  it("binds a Claude chat to its account's login: info, session, capture, and the managed row", async () => {
    const { manager, workRoot, defaultRoot, workProjectDir, projectDir } = setup(cleanups);
    const calls = captureSessionCreation(manager);

    const info = manager.createInstance({ provider: "claude", accountId: "work" });

    assert.equal(info.accountId, "work");
    assert.equal(info.configDir, workRoot);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.configDir, workRoot, "session is created under the bound dir");
    assert.equal(calls[0].options.provider, "claude");

    // A fresh chat is persisted once its session is captured. The CLI writes
    // the transcript under the bound root, so capture must look there.
    const transcript = join(workProjectDir, "sess-bound.jsonl");
    writeTranscript(transcript, projectDir);
    const instance = manager.instances.get(info.id);
    instance.process.getRuntimeBinding = () => ({
      provider: "claude",
      providerSessionId: "sess-bound",
    });
    instance.process.emit("output", { type: "output", text: "", isWaiting: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(instance.jsonlPath, transcript, "capture resolves the JSONL under the bound root");
    const row = manager.sessionDb.getManagedByInstanceId(info.id);
    assert.equal(row?.config_dir, workRoot, "login binding is persisted for restore");
    assert.equal(row?.account_id, "work", "account is persisted for restore");
    assert.equal(row?.transcript_path, transcript);

    // The default account's chat carries neither field.
    const plain = manager.createInstance({ provider: "claude" });
    assert.equal(plain.accountId, undefined);
    assert.equal(plain.configDir, undefined);
    assert.equal(calls[1].options.configDir, undefined);
    assert.equal(manager.getProviderDirs().claude, defaultRoot, "server default untouched");
  });

  it("binds a Codex chat to its account's CODEX_HOME and rebinds only that provider's dir", () => {
    const { manager, config, codexDir, codexWorkRoot, defaultRoot } = setup(cleanups);
    const created = [];
    const original = getProviderDriver("codex");
    const originalCreate = original.createSession;
    const originalAvailable = original.isAvailable;
    original.isAvailable = () => true;
    original.createSession = (sessionConfig, options, context) => {
      created.push({ sessionConfig, options, context });
      const session = new FakeProviderSession();
      session.provider = "codex";
      return session;
    };
    cleanups.push(() => {
      original.createSession = originalCreate;
      original.isAvailable = originalAvailable;
    });

    const info = manager.createInstance({ provider: "codex", accountId: "work" });
    assert.equal(info.accountId, "work");
    assert.equal(info.configDir, codexWorkRoot);
    assert.equal(created[0].options.configDir, codexWorkRoot);
    assert.equal(created[0].sessionConfig.providerDirs.codex, codexWorkRoot);
    assert.equal(
      created[0].sessionConfig.providerDirs.claude,
      defaultRoot,
      "other providers keep their dir",
    );
    assert.equal(created[0].context.providerDirs.codex, codexWorkRoot);
    assert.equal(created[0].context.accountConfigDir, codexWorkRoot);
    assert.equal(manager.providerDirsFor(manager.instances.get(info.id)).codex, codexWorkRoot);

    const plain = manager.createInstance({ provider: "codex" });
    assert.equal(plain.accountId, undefined);
    assert.equal(plain.configDir, undefined);
    assert.equal(created[1].sessionConfig.providerDirs.codex, config.providerDirs.codex);
    assert.equal(created[1].context.accountConfigDir, undefined);
    assert.equal(manager.getProviderDirs().codex, codexDir);
  });

  it("unknown and default account ids are the default account", () => {
    const { manager } = setup(cleanups);
    const calls = captureSessionCreation(manager);
    for (const accountId of [undefined, "default", "gone"]) {
      const info = manager.createInstance({ provider: "claude", accountId });
      assert.equal(info.accountId, undefined);
      assert.equal(info.configDir, undefined);
    }
    assert.deepEqual(
      calls.map((c) => c.options.configDir),
      [undefined, undefined, undefined],
    );
  });

  it("a provider with no login in the account is unavailable there — never a fallback", () => {
    const { manager } = setup(cleanups);
    const calls = captureSessionCreation(manager);
    assert.throws(
      () => manager.createInstance({ provider: "claude", accountId: "solo" }),
      (err) => {
        assert.ok(err instanceof ProviderUnavailableInAccountError);
        assert.equal(err.code, "provider_unavailable_in_account");
        assert.equal(err.provider, "claude");
        assert.equal(err.accountId, "solo");
        return true;
      },
    );
    assert.equal(calls.length, 0, "no session was started under another login");
    assert.equal(manager.listInstances().length, 0);
  });

  it("provider defaulting only considers providers the account has a login for", () => {
    const { manager, tempDir, project } = setup(cleanups);
    const calls = captureSessionCreation(manager);
    // The project and the global default both say Claude; "solo" has no Claude login.
    manager.projectManager.updateProject(project.id, { defaultProvider: "claude" });
    manager.sessionDb.updateGlobalSettings({ default_provider: "claude" });

    const solo = manager.createInstance({ accountId: "solo" });
    assert.equal(solo.provider, "codex");
    assert.equal(solo.accountId, "solo");
    assert.equal(solo.configDir, join(tempDir, ".codex-solo"));
    assert.equal(calls[0].options.provider, "codex");

    // An account that has the preferred provider keeps the preference.
    const work = manager.createInstance({ accountId: "work" });
    assert.equal(work.provider, "claude");
    assert.equal(work.accountId, "work");
  });

  it("resuming an existing session follows the root its transcript lives in", () => {
    const { manager, workRoot, workProjectDir, defaultProjectDir, projectDir } = setup(cleanups);
    writeTranscript(join(workProjectDir, "sess-work.jsonl"), projectDir);
    writeTranscript(join(defaultProjectDir, "sess-default.jsonl"), projectDir);
    const calls = captureSessionCreation(manager);

    // No account asked for: the transcript's login names it.
    const work = manager.createInstance({ provider: "claude", resumeSessionId: "sess-work" });
    assert.equal(work.accountId, "work");
    assert.equal(work.configDir, workRoot);
    assert.equal(calls[0].options.configDir, workRoot);
    assert.equal(calls[0].options.resumeSessionId, "sess-work");
    assert.equal(manager.instances.get(work.id).jsonlPath, join(workProjectDir, "sess-work.jsonl"));

    // A transcript under the default root stays default even when the caller
    // asks for another account.
    const dflt = manager.createInstance({
      provider: "claude",
      accountId: "work",
      resumeSessionId: "sess-default",
    });
    assert.equal(dflt.accountId, undefined);
    assert.equal(dflt.configDir, undefined);
    assert.equal(calls[1].options.configDir, undefined);
    assert.equal(
      manager.instances.get(dflt.id).jsonlPath,
      join(defaultProjectDir, "sess-default.jsonl"),
    );
  });

  it("a Codex resume follows the CODEX_HOME that holds its rollout", () => {
    const { manager, codexWorkRoot, projectDir } = setup(cleanups);
    const rollout = writeCodexRollout(codexWorkRoot, "codex-work-thread", projectDir);
    const calls = captureSessionCreation(manager);
    const info = manager.createInstance({
      provider: "codex",
      resumeSessionId: "codex-work-thread",
    });
    assert.equal(info.accountId, "work");
    assert.equal(info.configDir, codexWorkRoot);
    assert.equal(calls[0].options.configDir, codexWorkRoot);
    assert.equal(manager.instances.get(info.id).jsonlPath, rollout);
  });

  it("the Claude driver pins CLAUDE_CONFIG_DIR from the session's configDir, not the server default", () => {
    const { config, workRoot, defaultRoot, projectDir } = setup(cleanups);
    const captured = [];
    const context = {
      providerDirs: config.providerDirs,
      logger: noopLogger,
      sdkQueryFn: stubSdkQuery(captured),
    };
    const driver = getProviderDriver("claude");

    const bound = driver.createSession(
      { ...config, workingDirectory: projectDir },
      { configDir: workRoot },
      context,
    );
    cleanups.push(() => bound.close());
    assert.equal(captured[0].env.CLAUDE_CONFIG_DIR, workRoot);
    assert.equal(captured[0].cwd, projectDir);

    // Without a binding the session runs under `providerDirs.claude`.
    const plain = driver.createSession({ ...config, workingDirectory: projectDir }, {}, context);
    cleanups.push(() => plain.close());
    assert.equal(captured[1].env.CLAUDE_CONFIG_DIR, defaultRoot);
  });

  it("external discovery pairs a cwd's process with the newest JSONL from any root and stamps the account", async () => {
    const {
      config,
      manager,
      workRoot,
      defaultRoot,
      projectDir,
      defaultProjectDir,
      workProjectDir,
    } = setup(cleanups);
    const oldDefault = join(defaultProjectDir, "old-default.jsonl");
    const newWork = join(workProjectDir, "new-work.jsonl");
    writeTranscript(oldDefault, projectDir, 60_000);
    writeTranscript(newWork, projectDir);

    const discover = (count) =>
      getProviderDriver("claude").discoverExternalSessions({
        providerDirs: config.providerDirs,
        providerRoots: manager.getProviderContext().providerRoots,
        logger: noopLogger,
        sdkQueryFn: null,
        registeredDirectories: new Set([projectDir]),
        excludePids: new Set(),
        runningProcessCwds: new Map([
          ["claude", new Map([[projectDir, { count, pids: [4242, 4343] }]])],
        ]),
      });

    // One terminal process: it gets the newest transcript, which lives in the work root.
    const one = await discover(1);
    assert.deepEqual(
      one.map((s) => [s.transcriptPath, s.sessionId, s.pid]),
      [[newWork, "new-work", 4242]],
    );
    // Two processes: newest first, across both roots.
    const two = await discover(2);
    assert.deepEqual(
      two.map((s) => s.transcriptPath),
      [newWork, oldDefault],
    );

    // Without roots the driver still only sees the default root (legacy callers).
    const legacy = await getProviderDriver("claude").discoverExternalSessions({
      providerDirs: config.providerDirs,
      logger: noopLogger,
      sdkQueryFn: null,
      registeredDirectories: new Set([projectDir]),
      excludePids: new Set(),
      runningProcessCwds: new Map([["claude", new Map([[projectDir, { count: 1, pids: [1] }]])]]),
    });
    assert.deepEqual(
      legacy.map((s) => s.transcriptPath),
      [oldDefault],
    );

    // The manager stamps the account on the external chat under the non-default root only.
    manager.discoverExternalSessions = () => Promise.resolve(two);
    await manager.discoverExisting();
    const externals = manager.listInstances().filter((i) => i.external);
    const byId = Object.fromEntries(externals.map((i) => [i.sessionId, i]));
    assert.equal(byId["new-work"]?.accountId, "work");
    assert.equal(byId["new-work"]?.configDir, workRoot);
    assert.equal(byId["old-default"]?.accountId, undefined);
    assert.equal(byId["old-default"]?.configDir, undefined);
    assert.notEqual(defaultRoot, workRoot);

    // Summaries built from persisted rows carry the same derived binding.
    const summary = manager.getChatSummary(byId["new-work"].id);
    assert.equal(summary?.accountId, "work");
    assert.equal(summary?.configDir, workRoot);
  });

  it("scans every login root of every provider at startup and after an account is added", () => {
    const {
      manager,
      accounts,
      tempDir,
      projectDir,
      encoded,
      defaultProjectDir,
      workProjectDir,
      codexDir,
      codexWorkRoot,
    } = setup(cleanups);
    writeTranscript(join(defaultProjectDir, "scan-default.jsonl"), projectDir, 5_000);
    writeTranscript(join(workProjectDir, "scan-work.jsonl"), projectDir, 4_000);
    writeCodexRollout(codexDir, "codex-default", projectDir);
    writeCodexRollout(codexWorkRoot, "codex-work", projectDir);
    const laterRoot = join(tempDir, ".claude-later");
    const laterProjectDir = join(laterRoot, "projects", encoded);
    mkdirSync(laterProjectDir, { recursive: true });
    writeTranscript(join(laterProjectDir, "scan-later.jsonl"), projectDir, 3_000);

    manager.restoreInstances();
    manager.scanAndRestoreNew();
    const externals = () => manager.listInstances().filter((i) => i.external);
    const sessionIds = () =>
      externals()
        .map((i) => i.sessionId)
        .sort();
    assert.deepEqual(sessionIds(), ["codex-default", "codex-work", "scan-default", "scan-work"]);
    const bySession = (id) => externals().find((i) => i.sessionId === id);
    assert.equal(bySession("codex-work").accountId, "work");
    assert.equal(bySession("codex-work").configDir, codexWorkRoot);
    assert.equal(bySession("codex-default").accountId, undefined);
    assert.equal(bySession("codex-default").configDir, undefined);
    assert.equal(bySession("scan-work").accountId, "work");
    assert.equal(bySession("scan-default").accountId, undefined);

    // Adding an account through the store picks up its root without a restart.
    let scans = 0;
    const scan = manager.scanAndRestoreNew.bind(manager);
    manager.scanAndRestoreNew = () => {
      scans++;
      return scan();
    };
    const later = manager.accounts.create(
      { label: "Later", logins: { claude: { configDir: laterRoot } } },
      { loginProviders: ["claude", "codex"] },
    );
    assert.equal(scans, 1);
    assert.deepEqual(sessionIds(), [
      "codex-default",
      "codex-work",
      "scan-default",
      "scan-later",
      "scan-work",
    ]);
    assert.equal(bySession("scan-later").accountId, later.id);
    assert.equal(bySession("scan-later").configDir, laterRoot);

    // A change that adds no root (a rename) does not rescan.
    manager.accounts.update(later.id, { label: "Later on" }, { loginProviders: ["claude"] });
    assert.equal(scans, 1);
    assert.equal(accounts.length, 2);
  });

  it("a restored managed row with config_dir resumes under that dir", async () => {
    const { manager, workRoot, workProjectDir, projectDir, project } = setup(cleanups);
    const transcript = join(workProjectDir, "sess-restored.jsonl");
    writeTranscript(transcript, projectDir);
    const now = Date.now();
    manager.sessionDb.upsertManaged({
      instance_id: "managed-work",
      provider_name: "claude",
      provider_session_id: "sess-restored",
      name: "Work chat",
      working_directory: projectDir,
      created_at: now,
      last_activity_at: now,
      archived: 0,
      custom_title: 0,
      pinned: 0,
      done_at: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      git_branch: null,
      worktree_path: null,
      original_directory: null,
      parent_session_id: null,
      preferred_model: null,
      reasoning_budget: null,
      runtime_mode: "approval-required",
      resume_cursor_json: null,
      runtime_payload_json: null,
      transcript_path: null,
      last_message_text: null,
      last_message_from: null,
      last_message_at: null,
      git_info_branch: null,
      git_info_is_worktree: null,
      space_id: null,
      project_id: project.id,
      model: null,
      model_options_json: null,
      original_git_branch: null,
      config_dir: workRoot,
      // A row written before accounts carried an id: the login names it.
      account_id: null,
    });

    manager.restoreInstances();
    const restored = manager.instances.get("managed-work");
    assert.ok(restored, "row restored");
    assert.equal(restored.info.configDir, workRoot);
    assert.equal(restored.info.accountId, "work");
    assert.equal(restored.jsonlPath, transcript, "transcript resolved under the bound root");
    assert.equal(restored.process, null, "restore never boots");

    const calls = captureSessionCreation(manager);
    await manager.sendMessage("managed-work", "continue");
    assert.equal(calls.length, 1, "first send lazily resumes");
    assert.equal(calls[0].options.resumeSessionId, "sess-restored");
    assert.equal(calls[0].options.configDir, workRoot, "--resume runs under the transcript's dir");
  });

  it("a legacy managed row (config_dir, no account_id) is classified by its login everywhere, then backfilled", () => {
    const { manager, workRoot, defaultRoot, workProjectDir, projectDir, project } = setup(cleanups);
    writeTranscript(join(workProjectDir, "sess-legacy.jsonl"), projectDir);
    const now = Date.now();
    const legacyRow = (overrides) => ({
      instance_id: "managed-legacy",
      provider_name: "claude",
      provider_session_id: "sess-legacy",
      name: "Legacy work chat about quasar migration",
      working_directory: projectDir,
      created_at: now,
      last_activity_at: now,
      archived: 0,
      custom_title: 0,
      pinned: 0,
      done_at: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      git_branch: null,
      worktree_path: null,
      original_directory: null,
      parent_session_id: null,
      preferred_model: null,
      reasoning_budget: null,
      runtime_mode: "approval-required",
      resume_cursor_json: null,
      runtime_payload_json: null,
      transcript_path: null,
      last_message_text: null,
      last_message_from: null,
      last_message_at: null,
      git_info_branch: null,
      git_info_is_worktree: null,
      space_id: null,
      project_id: project.id,
      model: null,
      model_options_json: null,
      original_git_branch: null,
      config_dir: workRoot,
      account_id: null,
      ...overrides,
    });
    manager.sessionDb.upsertManaged(legacyRow({}));
    // Rows with no `config_dir`, or one the server itself owns, are the default account.
    manager.sessionDb.upsertManaged(
      legacyRow({
        instance_id: "managed-unbound",
        provider_session_id: "sess-unbound",
        name: "Unbound chat about quasar migration",
        config_dir: null,
      }),
    );
    manager.sessionDb.upsertManaged(
      legacyRow({
        instance_id: "managed-own-dir",
        provider_session_id: "sess-own-dir",
        name: "Own-dir chat about quasar migration",
        config_dir: defaultRoot,
      }),
    );
    for (const id of ["managed-legacy", "managed-unbound", "managed-own-dir"])
      manager.sessionDb.syncSearchIndexForInstance(id);

    // Persisted summaries (no live instance yet) name the account from the login.
    assert.equal(manager.getChatSummary("managed-legacy").accountId, "work");
    assert.equal(manager.getChatSummary("managed-unbound").accountId, undefined);
    assert.equal(manager.getChatSummary("managed-own-dir").accountId, undefined);
    const listed = new Map(manager.listProjectChats(project.id).map((c) => [c.id, c]));
    assert.equal(listed.get("managed-legacy").accountId, "work");
    assert.equal(listed.get("managed-unbound").accountId, undefined);
    assert.equal(listed.get("managed-own-dir").accountId, undefined);

    // Search results derive the same way, and the login-root filter scopes them.
    const accounts = manager.accounts;
    const hits = new Map(
      manager.sessionDb.search("quasar", { accounts }).map((r) => [r.instanceId, r]),
    );
    assert.equal(hits.get("managed-legacy").accountId, "work");
    assert.equal(hits.get("managed-unbound").accountId, undefined);
    assert.equal(hits.get("managed-own-dir").accountId, undefined);
    assert.deepEqual(
      manager.sessionDb
        .search("quasar", { accounts, loginRoots: accountLoginRootFilter(accounts.list(), "work") })
        .map((r) => r.instanceId),
      ["managed-legacy"],
    );
    assert.deepEqual(
      manager.sessionDb
        .search("quasar", {
          accounts,
          loginRoots: accountLoginRootFilter(accounts.list(), "default"),
        })
        .map((r) => r.instanceId)
        .sort(),
      ["managed-own-dir", "managed-unbound"],
    );

    // Restore derives the id and persists it through the normal save path...
    manager.restoreInstances();
    assert.equal(manager.instances.get("managed-legacy").info.accountId, "work");
    assert.equal(manager.sessionDb.getManagedByInstanceId("managed-legacy").account_id, "work");
    // ...while rows with no login binding are never stamped with a guess.
    assert.equal(manager.instances.get("managed-unbound").info.accountId, undefined);
    assert.equal(manager.sessionDb.getManagedByInstanceId("managed-unbound").account_id, null);
    assert.equal(manager.instances.get("managed-own-dir").info.accountId, undefined);
    assert.equal(manager.sessionDb.getManagedByInstanceId("managed-own-dir").account_id, null);
  });
});
