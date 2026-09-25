// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Claude account profiles: a chat is bound to one config dir for its whole
 * life, and transcript discovery covers every profile's root.
 *
 *  (a) creation resolves explicit > project default > global default > default
 *      and hands the bound dir to the provider session (SDK: CLAUDE_CONFIG_DIR)
 *  (b) external discovery pairs a cwd's process with the newest JSONL from any
 *      root and labels non-default ones with `configDir`
 *  (c) a restored managed row with `config_dir` resumes under that dir
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
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

function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9_-]/g, "-");
}

function setup(cleanups) {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-account-profiles-")));
  const defaultRoot = join(tempDir, ".claude");
  const workRoot = join(tempDir, ".claude-work");
  const codexDir = join(tempDir, ".codex");
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
  manager.sessionDb.updateGlobalSettings({
    provider_profiles_json: JSON.stringify([
      { id: "work", provider: "claude", label: "Work", configDir: workRoot },
    ]),
  });
  return {
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

describe("Claude account profiles", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("lists the default root first, then every profile root, deduped", () => {
    const { manager, defaultRoot, workRoot } = setup(cleanups);
    assert.deepEqual(manager.getClaudeRoots(), [defaultRoot, workRoot]);
    manager.sessionDb.updateGlobalSettings({
      provider_profiles_json: JSON.stringify([
        { id: "work", provider: "claude", label: "Work", configDir: `${workRoot}/` },
        { id: "dup", provider: "claude", label: "Dup", configDir: workRoot },
        { id: "same", provider: "claude", label: "Same as default", configDir: defaultRoot },
        { id: "cx", provider: "codex", label: "Not Claude", configDir: "/elsewhere" },
      ]),
    });
    assert.deepEqual(manager.getClaudeRoots(), [defaultRoot, workRoot]);
  });

  it("binds an explicit profile: configDir on the chat, the session, capture, and the managed row", async () => {
    const { manager, workRoot, defaultRoot, workProjectDir, projectDir } = setup(cleanups);
    const calls = captureSessionCreation(manager);

    const info = manager.createInstance({ provider: "claude", profileId: "work" });

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
    assert.equal(row?.config_dir, workRoot, "binding is persisted for restore");
    assert.equal(row?.transcript_path, transcript);

    // The unbound sibling stays on the server default with no configDir at all.
    const plain = manager.createInstance({ provider: "claude" });
    assert.equal(plain.configDir, undefined);
    assert.equal(calls[1].options.configDir, undefined);
    assert.equal(manager.getProviderDirs().claude, defaultRoot, "server default untouched");
  });

  it("resolves explicit > project default > global default > default (unknown ids fall through)", () => {
    const { manager, tempDir, workRoot, project } = setup(cleanups);
    const projRoot = join(tempDir, ".claude-proj");
    const globalRoot = join(tempDir, ".claude-global");
    manager.sessionDb.updateGlobalSettings({
      provider_profiles_json: JSON.stringify([
        { id: "work", provider: "claude", label: "Work", configDir: workRoot },
        { id: "proj", provider: "claude", label: "Project", configDir: projRoot },
        { id: "glob", provider: "claude", label: "Global", configDir: globalRoot },
      ]),
      provider_defaults_json: JSON.stringify({ claude: { profileId: "glob" } }),
    });
    manager.projectManager.updateProject(project.id, { defaultProfileId: "proj" });
    const calls = captureSessionCreation(manager);

    assert.equal(
      manager.createInstance({ provider: "claude", profileId: "work" }).configDir,
      workRoot,
    );
    assert.equal(manager.createInstance({ provider: "claude" }).configDir, projRoot);
    // A deleted/unknown explicit id falls through to the project default.
    assert.equal(
      manager.createInstance({ provider: "claude", profileId: "gone" }).configDir,
      projRoot,
    );

    manager.projectManager.updateProject(project.id, { defaultProfileId: null });
    assert.equal(manager.createInstance({ provider: "claude" }).configDir, globalRoot);

    manager.sessionDb.updateGlobalSettings({ provider_defaults_json: JSON.stringify({}) });
    assert.equal(manager.createInstance({ provider: "claude" }).configDir, undefined);
    assert.equal(
      manager.createInstance({ provider: "claude", profileId: "gone" }).configDir,
      undefined,
      "unknown id with no defaults binds nothing (server default)",
    );
    // Choosing the implicit default explicitly is the same as choosing nothing.
    assert.equal(
      manager.createInstance({ provider: "claude", profileId: "default" }).configDir,
      undefined,
    );
    assert.deepEqual(
      calls.map((c) => c.options.configDir),
      [workRoot, projRoot, projRoot, globalRoot, undefined, undefined, undefined],
    );
  });

  it("resuming an existing session follows the root its transcript lives in", () => {
    const { manager, workRoot, workProjectDir, defaultProjectDir, projectDir } = setup(cleanups);
    writeTranscript(join(workProjectDir, "sess-work.jsonl"), projectDir);
    writeTranscript(join(defaultProjectDir, "sess-default.jsonl"), projectDir);
    const calls = captureSessionCreation(manager);

    const work = manager.createInstance({ provider: "claude", resumeSessionId: "sess-work" });
    assert.equal(work.configDir, workRoot);
    assert.equal(calls[0].options.configDir, workRoot);
    assert.equal(calls[0].options.resumeSessionId, "sess-work");
    assert.equal(manager.instances.get(work.id).jsonlPath, join(workProjectDir, "sess-work.jsonl"));

    // A transcript under the default root stays default even with a project default set.
    manager.projectManager.updateProject(work.projectId, { defaultProfileId: "work" });
    const dflt = manager.createInstance({ provider: "claude", resumeSessionId: "sess-default" });
    assert.equal(dflt.configDir, undefined);
    assert.equal(calls[1].options.configDir, undefined);
    assert.equal(
      manager.instances.get(dflt.id).jsonlPath,
      join(defaultProjectDir, "sess-default.jsonl"),
    );
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

  it("external discovery pairs a cwd's process with the newest JSONL from any root", async () => {
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
        claudeRoots: manager.getClaudeRoots(),
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

    // The manager stamps configDir on the external chat under the non-default root only.
    manager.discoverExternalSessions = () => Promise.resolve(two);
    await manager.discoverExisting();
    const externals = manager.listInstances().filter((i) => i.external);
    const byId = Object.fromEntries(externals.map((i) => [i.sessionId, i]));
    assert.equal(byId["new-work"]?.configDir, workRoot);
    assert.equal(byId["old-default"]?.configDir, undefined);
    assert.notEqual(defaultRoot, workRoot);

    // Summaries built from persisted rows carry the same derived label.
    const summary = manager.getChatSummary(byId["new-work"].id);
    assert.equal(summary?.configDir, workRoot);
  });

  it("scans every root at startup and after a profile is added", () => {
    const { manager, tempDir, projectDir, encoded, defaultProjectDir, workProjectDir, workRoot } =
      setup(cleanups);
    writeTranscript(join(defaultProjectDir, "scan-default.jsonl"), projectDir, 5_000);
    writeTranscript(join(workProjectDir, "scan-work.jsonl"), projectDir, 4_000);
    const laterRoot = join(tempDir, ".claude-later");
    const laterProjectDir = join(laterRoot, "projects", encoded);
    mkdirSync(laterProjectDir, { recursive: true });
    writeTranscript(join(laterProjectDir, "scan-later.jsonl"), projectDir, 3_000);

    manager.restoreInstances();
    manager.scanAndRestoreNew();
    const sessionIds = () =>
      manager
        .listInstances()
        .filter((i) => i.external)
        .map((i) => i.sessionId)
        .sort();
    assert.deepEqual(sessionIds(), ["scan-default", "scan-work"]);

    // Adding a profile picks up its root without a restart; a repeat is a no-op.
    manager.sessionDb.updateGlobalSettings({
      provider_profiles_json: JSON.stringify([
        { id: "work", provider: "claude", label: "Work", configDir: workRoot },
        { id: "later", provider: "claude", label: "Later", configDir: laterRoot },
      ]),
    });
    manager.refreshAccountProfileRoots();
    assert.deepEqual(sessionIds(), ["scan-default", "scan-later", "scan-work"]);
    manager.refreshAccountProfileRoots();
    assert.deepEqual(sessionIds(), ["scan-default", "scan-later", "scan-work"], "idempotent");
    assert.equal(
      manager.listInstances().find((i) => i.sessionId === "scan-later")?.configDir,
      laterRoot,
    );
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
    });

    manager.restoreInstances();
    const restored = manager.instances.get("managed-work");
    assert.ok(restored, "row restored");
    assert.equal(restored.info.configDir, workRoot);
    assert.equal(restored.jsonlPath, transcript, "transcript resolved under the bound root");
    assert.equal(restored.process, null, "restore never boots");

    const calls = captureSessionCreation(manager);
    await manager.sendMessage("managed-work", "continue");
    assert.equal(calls.length, 1, "first send lazily resumes");
    assert.equal(calls[0].options.resumeSessionId, "sess-restored");
    assert.equal(calls[0].options.configDir, workRoot, "--resume runs under the transcript's dir");
  });
});
