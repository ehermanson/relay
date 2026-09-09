import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { SessionDB } from "../dist/server/core/db.js";
import { resolveConfig } from "../dist/server/config.js";

// Use a noop logger to keep test output clean
const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const fixturesDir = join(import.meta.dirname, "fixtures");

class FakeProviderSession extends EventEmitter {
  constructor(provider = "codex") {
    super();
    this.provider = provider;
    this.isProcessing = false;
    this.stats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
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
    return {
      provider: this.provider,
      providerSessionId: "fake-session",
      resumeCursor: { sessionId: "fake-session" },
    };
  }

  respondToRequest() {
    return false;
  }
}

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout: 15000,
  });
}

let seedRepoDir;

function ensureSeedRepo() {
  if (seedRepoDir) return seedRepoDir;

  seedRepoDir = mkdtempSync(join(tmpdir(), "relay-im-seed-"));
  runGit(seedRepoDir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(seedRepoDir, "README.md"), "# Test\n");
  runGit(seedRepoDir, ["add", "."]);
  runGit(seedRepoDir, [
    "-c",
    "user.email=test@test.com",
    "-c",
    "user.name=Test",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);

  return seedRepoDir;
}

function makeRepoDir() {
  const tempRoot = mkdtempSync(join(tmpdir(), "relay-im-test-"));
  const repoDir = join(tempRoot, "repo");
  cpSync(ensureSeedRepo(), repoDir, { recursive: true });
  return repoDir;
}

function makeConfig(overrides = {}) {
  const tempDir = makeRepoDir();
  return resolveConfig({
    password: "test",
    logger: noopLogger,
    maxProcesses: 3,
    dbPath: join(tempDir, "sessions.db"),
    providerDirs: {
      claude: join(tempDir, ".claude"),
      codex: join(tempDir, ".codex"),
    },
    workingDirectory: tempDir,
    ...overrides,
  });
}

function makeManagedRow(overrides = {}) {
  return {
    instance_id: "managed-1",
    provider_name: "claude",
    provider_session_id: "session-1",
    name: "Managed Session",
    working_directory: "/tmp/test",
    created_at: 1000,
    last_activity_at: 2000,
    archived: 0,
    custom_title: 0,
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
    runtime_payload_json: "{}",
    model_options_json: null,
    original_git_branch: null,
    transcript_path: null,
    last_message_text: null,
    last_message_from: null,
    last_message_at: null,
    git_info_branch: null,
    git_info_is_worktree: null,
    space_id: null,
    project_id: null,
    model: null,
    ...overrides,
  };
}

function makeExternalRow(overrides = {}) {
  return {
    session_id: "external-1",
    instance_id: "external-instance-1",
    provider_name: "claude",
    name: "External Session",
    working_directory: "/tmp/test",
    jsonl_path: "/tmp/test/session.jsonl",
    created_at: 1000,
    last_activity_at: 2000,
    type: "external",
    archived: 0,
    custom_title: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    summary: null,
    first_prompt: null,
    git_branch: null,
    message_count: 0,
    allowed_tools: "[]",
    worktree_path: null,
    original_directory: null,
    parent_session_id: null,
    preferred_model: null,
    reasoning_budget: null,
    runtime_mode: null,
    last_message_text: null,
    last_message_from: null,
    last_message_at: null,
    git_info_branch: null,
    git_info_is_worktree: null,
    space_id: null,
    project_id: null,
    model: null,
    ...overrides,
  };
}

describe("InstanceManager", () => {
  let manager;
  let managers;

  function trackManager(instanceManager) {
    managers.push(instanceManager);
    return instanceManager;
  }

  beforeEach(() => {
    managers = [];
    manager = trackManager(new InstanceManager(makeConfig()));
  });

  afterEach(() => {
    for (const instanceManager of managers.reverse()) {
      try {
        instanceManager.stopAll();
      } catch {
        // best-effort cleanup for test isolation
      }
    }
  });

  describe("createInstance", () => {
    it("creates an instance with defaults", () => {
      const info = manager.createInstance();
      assert.ok(info.id);
      assert.equal(info.name, "New Session");
      assert.equal(info.status, "idle");
      assert.equal(info.external, undefined);
    });

    it("accepts custom name and working directory", () => {
      const info = manager.createInstance({
        name: "My Project",
        workingDirectory: "/tmp/test",
      });
      assert.equal(info.name, "My Project");
      assert.equal(info.workingDirectory, "/tmp/test");
    });

    it("uses the default session title when no name is provided", () => {
      const a = manager.createInstance();
      const b = manager.createInstance();
      assert.equal(a.name, "New Session");
      assert.equal(b.name, "New Session");
    });

    it("enforces maxProcesses limit", () => {
      manager.createInstance();
      manager.createInstance();
      manager.createInstance();
      assert.throws(() => manager.createInstance(), /Maximum processes/);
    });

    it("stopInstance frees a process slot for a resumable session", () => {
      const a = manager.createInstance();
      manager.createInstance();
      manager.createInstance();
      // Give the first instance a resumable session id so it can be paused.
      const internal = manager.instances.get(a.id);
      internal.sessionId = "resume-1";
      internal.info.sessionId = "resume-1";

      assert.equal(manager.stopInstance(a.id), true);
      assert.equal(internal.process, null);
      assert.equal(internal.info.status, "stopped");
      // Slot is freed — a new instance can now be created.
      assert.doesNotThrow(() => manager.createInstance());
    });

    it("honors the global max_processes setting live, overriding config", () => {
      // Config default is 3; tighten to 1 via the global setting.
      manager.sessionDb.updateGlobalSettings({ max_processes: 1 });
      manager.createInstance();
      assert.throws(() => manager.createInstance(), /Maximum processes \(1\)/);

      // Raising it live takes effect immediately — no restart.
      manager.sessionDb.updateGlobalSettings({ max_processes: 3 });
      assert.doesNotThrow(() => manager.createInstance());
      assert.doesNotThrow(() => manager.createInstance());
      assert.throws(() => manager.createInstance(), /Maximum processes \(3\)/);

      // Clearing it falls back to the config default (still 3).
      manager.sessionDb.updateGlobalSettings({ max_processes: null });
      assert.throws(() => manager.createInstance(), /Maximum processes \(3\)/);
    });

    it("marking a chat done stops its idle process and frees the slot", async () => {
      const a = manager.createInstance();
      manager.createInstance();
      manager.createInstance();
      const internal = manager.instances.get(a.id);
      internal.sessionId = "resume-done";
      internal.info.sessionId = "resume-done";

      assert.equal(await manager.setInstanceDone(a.id, true), true);
      assert.equal(internal.process, null);
      assert.equal(internal.info.status, "stopped");
      assert.ok(internal.info.doneAt);
      assert.doesNotThrow(() => manager.createInstance());

      // Clearing the marker never boots the process back up.
      assert.equal(await manager.setInstanceDone(a.id, false), true);
      assert.equal(internal.process, null);
      assert.equal(internal.info.doneAt, undefined);
    });

    it("marking a chat done never interrupts a processing turn", async () => {
      const a = manager.createInstance();
      const internal = manager.instances.get(a.id);
      internal.sessionId = "resume-busy";
      internal.info.sessionId = "resume-busy";
      internal.info.status = "processing";

      assert.equal(await manager.setInstanceDone(a.id, true), true);
      assert.ok(internal.process);
      assert.equal(internal.info.status, "processing");
      assert.ok(internal.info.doneAt);
    });

    it("bulk mark-done stops idle live processes", () => {
      const a = manager.createInstance();
      const b = manager.createInstance();
      manager.createInstance();
      for (const id of [a.id, b.id]) {
        const internal = manager.instances.get(id);
        internal.sessionId = `resume-${id}`;
        internal.info.sessionId = `resume-${id}`;
      }

      assert.equal(manager.setInstancesDone([a.id, b.id], true), 2);
      assert.equal(manager.instances.get(a.id).process, null);
      assert.equal(manager.instances.get(b.id).process, null);
      // Two slots freed under a cap of 3.
      assert.doesNotThrow(() => manager.createInstance());
      assert.doesNotThrow(() => manager.createInstance());
    });

    it("stopInstance refuses a session with no resumable id", () => {
      const a = manager.createInstance();
      // Fresh instance has no captured session id yet.
      assert.equal(manager.stopInstance(a.id), false);
      const internal = manager.instances.get(a.id);
      assert.ok(internal.process);
      assert.notEqual(internal.info.status, "stopped");
    });

    it("does not persist an empty managed instance before it has resumable state", () => {
      const info = manager.createInstance({ name: "Unsaved Draft" });
      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);

      try {
        assert.equal(db.getManagedByInstanceId(info.id), undefined);
      } finally {
        db.close();
      }
    });

    it("refuses to create a chat in an isolated space whose worktree is missing", () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Broken space",
      });
      assert.ok(space.worktreePath);

      rmSync(space.worktreePath, { recursive: true, force: true });

      assert.throws(
        () => manager.createInstance({ spaceId: space.id }),
        /missing its worktree and is currently read-only/,
      );
    });

    it("marks an isolated space as broken when its worktree disappears", () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Broken marker",
      });
      assert.ok(space.worktreePath);

      rmSync(space.worktreePath, { recursive: true, force: true });

      const refreshed = manager.getSpaceManager().getSpace(space.id);
      assert.ok(refreshed);
      assert.equal(refreshed.status, "broken");
      assert.equal(refreshed.worktreePath, null);
    });

    it("reconciles missing in-memory ownership for current-space chats before persistence", () => {
      const project = manager.projectManager.addProject(manager.baseConfig.workingDirectory);
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Reconcile owned",
      });
      const info = manager.createInstance({ spaceId: space.id });
      const instance = manager.instances.get(info.id);

      assert.ok(instance);
      instance.info.spaceId = undefined;
      instance.info.projectId = undefined;
      instance.originalDirectory = undefined;
      instance.info.originalDirectory = undefined;

      manager.reconcileInstancePersistenceIdentity(instance);

      assert.equal(instance.info.spaceId, space.id);
      assert.equal(instance.info.projectId, project.id);
      assert.equal(instance.originalDirectory, manager.baseConfig.workingDirectory);
      assert.equal(instance.info.originalDirectory, manager.baseConfig.workingDirectory);
    });

    it("keeps space bootstrap guidance when creating a resumed space session", () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Resume Space",
      });
      const fakeProc = new FakeProviderSession("codex");
      manager.createProviderSession = (_config, options) => {
        fakeProc.bootstrapContext = options?.bootstrapContext;
        return fakeProc;
      };

      const info = manager.createInstance({
        provider: "codex",
        resumeSessionId: "resume-space-session",
        spaceId: space.id,
      });

      assert.equal(info.spaceId, space.id);
      assert.ok(fakeProc.bootstrapContext);
      assert.equal(
        fakeProc.bootstrapContext.blocks.some((b) => b.kind === "space_context"),
        true,
      );
      assert.equal(
        fakeProc.bootstrapContext.blocks.some((b) => b.kind === "custom_instructions"),
        false,
      );
      assert.equal(
        fakeProc.bootstrapContext.blocks.some((b) => b.kind === "task_guidance"),
        false,
      );
    });

    it("persists bootstrap context even when the provider does not echo it back", () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Bootstrap Contract",
      });
      const fakeProc = new FakeProviderSession("codex");
      manager.createProviderSession = () => fakeProc;

      const info = manager.createInstance({
        provider: "codex",
        spaceId: space.id,
      });
      const instance = manager.instances.get(info.id);

      assert.ok(instance);
      assert.ok(instance.info.sessionContext?.bootstrap);
      assert.equal(
        instance.info.sessionContext.bootstrap.blocks.some((b) => b.kind === "space_context"),
        true,
      );
    });

    it("cleans up a just-created worktree when createSpace fails after git worktree add", () => {
      const previousBase = process.env.RELAY_WORKTREE_BASE;
      const worktreeBase = mkdtempSync(join(tmpdir(), "relay-space-fail-"));
      const markerFile = join(manager.baseConfig.workingDirectory, "pwned");
      const spaceManager = manager.getSpaceManager();
      const originalExcludeRelayDir = spaceManager.excludeRelayDir;

      try {
        process.env.RELAY_WORKTREE_BASE = worktreeBase;
        spaceManager.excludeRelayDir = () => {
          throw new Error("exclude failed");
        };

        assert.throws(
          () =>
            spaceManager.createSpace(manager.baseConfig.workingDirectory, {
              name: "Broken Space",
            }),
          /exclude failed/,
        );

        assert.equal(existsSync(markerFile), false);
        assert.deepEqual(readdirSync(worktreeBase), []);
        assert.equal(
          spaceManager
            .listSpaces(manager.baseConfig.workingDirectory)
            .filter((space) => !space.isDefault).length,
          0,
        );
      } finally {
        spaceManager.excludeRelayDir = originalExcludeRelayDir;
        if (previousBase === undefined) {
          delete process.env.RELAY_WORKTREE_BASE;
        } else {
          process.env.RELAY_WORKTREE_BASE = previousBase;
        }
      }
    });
  });

  describe("listInstances / getInstance", () => {
    it("lists all instances", () => {
      manager.createInstance({ name: "A" });
      manager.createInstance({ name: "B" });
      const list = manager.listInstances();
      assert.equal(list.length, 2);
      assert.equal(list[0].name, "A");
      assert.equal(list[1].name, "B");
    });

    it("gets instance by id", () => {
      const info = manager.createInstance({ name: "X" });
      const found = manager.getInstance(info.id);
      assert.equal(found.name, "X");
    });

    it("returns undefined for unknown id", () => {
      assert.equal(manager.getInstance("nonexistent"), undefined);
    });

    it("skips restoring external shadow rows when a managed session already owns the transcript", () => {
      const projectDir = manager.baseConfig.workingDirectory;
      const space = manager.getSpaceManager().createSpace(projectDir, { name: "Shadow skip" });
      const transcriptPath = join(projectDir, "shadow-skip.jsonl");
      writeFileSync(transcriptPath, "{}\n");
      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);

      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "managed-shadow-owner",
            provider_session_id: "shadow-session",
            transcript_path: transcriptPath,
            working_directory: space.worktreePath,
            worktree_path: space.worktreePath,
            original_directory: projectDir,
            git_branch: space.gitBranch,
            space_id: space.id,
          }),
        );
        db.upsert(
          makeExternalRow({
            session_id: "shadow-session",
            instance_id: "shadow-external-restore",
            jsonl_path: transcriptPath,
            working_directory: projectDir,
            original_directory: projectDir,
            worktree_path: space.worktreePath,
            git_branch: space.gitBranch,
            space_id: space.id,
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(manager.baseConfig));
      restored.projectManager.addProject(projectDir);
      restored.restoreInstances();

      assert.ok(restored.getInstance("managed-shadow-owner"));
      assert.equal(restored.getInstance("shadow-external-restore"), undefined);
    });

    it("hides live external shadows in listInstances when a managed owner exists only in persisted state", () => {
      const projectDir = manager.baseConfig.workingDirectory;
      const project = manager.projectManager.addProject(projectDir);
      const transcriptPath = join(projectDir, "list-shadow.jsonl");
      writeFileSync(transcriptPath, "{}\n");
      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);

      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "managed-persisted-owner",
            provider_session_id: "list-shadow-session",
            transcript_path: transcriptPath,
            working_directory: projectDir,
            original_directory: projectDir,
            project_id: project.id,
          }),
        );
        db.upsert(
          makeExternalRow({
            session_id: "list-shadow-session",
            instance_id: "list-shadow-external",
            jsonl_path: transcriptPath,
            working_directory: projectDir,
            original_directory: projectDir,
            project_id: project.id,
          }),
        );
        const row = db.getBySessionId("list-shadow-session");
        assert.ok(row);
        assert.equal(manager.restoreExternalFromRow(row), true);
      } finally {
        db.close();
      }

      assert.equal(
        manager.listInstances().some((chat) => chat.id === "list-shadow-external"),
        false,
      );
    });

    it("removes a live external shadow once a managed session captures the same transcript", () => {
      const projectDir = manager.baseConfig.workingDirectory;
      const project = manager.projectManager.addProject(projectDir);
      const space = manager.getSpaceManager().createSpace(projectDir, { name: "Shadow prune" });
      const transcriptPath = join(projectDir, "shadow-prune.jsonl");
      writeFileSync(transcriptPath, "{}\n");

      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsert(
          makeExternalRow({
            session_id: "shadow-live-session",
            instance_id: "shadow-live-external",
            jsonl_path: transcriptPath,
            working_directory: projectDir,
            original_directory: projectDir,
            worktree_path: space.worktreePath,
            git_branch: space.gitBranch,
            space_id: space.id,
            project_id: project.id,
          }),
        );
        const row = db.getBySessionId("shadow-live-session");
        assert.ok(row);
        assert.equal(manager.restoreExternalFromRow(row), true);
      } finally {
        db.close();
      }

      assert.ok(manager.getInstance("shadow-live-external"));

      const managed = manager.createInstance({ spaceId: space.id });
      const managedInstance = manager.instances.get(managed.id);
      assert.ok(managedInstance);

      manager.finalizeSessionCapture(
        managed.id,
        managedInstance,
        managedInstance.process,
        "shadow-live-session",
        transcriptPath,
      );

      assert.equal(manager.instances.has("shadow-live-external"), false);
      assert.equal(
        manager.listSpaceChats(space.id).some((chat) => chat.id === "shadow-live-external"),
        false,
      );
      assert.equal(
        manager.listSpaceChats(space.id).filter((chat) => chat.sessionId === "shadow-live-session")
          .length,
        1,
      );

      const verifyDb = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        assert.equal(verifyDb.getByInstanceId("shadow-live-external"), undefined);
      } finally {
        verifyDb.close();
      }
    });

    it("falls back to persisted git metadata for originalGitBranch on restored managed sessions", () => {
      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);

      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "managed-legacy-branch",
            working_directory: manager.baseConfig.workingDirectory,
            git_branch: "relay-space/deadbeef",
            git_info_branch: "relay-space/deadbeef",
            original_git_branch: null,
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(manager.baseConfig));
      restored.restoreInstances();
      const info = restored.getInstance("managed-legacy-branch");

      assert.ok(info);
      assert.equal(info.originalGitBranch, "relay-space/deadbeef");
    });

    it("archives stale managed duplicates that point at the same provider session", () => {
      const projectDir = manager.baseConfig.workingDirectory;
      const transcriptPath = join(projectDir, "duplicate-managed.jsonl");
      writeFileSync(transcriptPath, "{}\n");
      const project = manager.projectManager.addProject(projectDir);

      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "managed-older",
            provider_session_id: "shared-provider-session",
            transcript_path: transcriptPath,
            working_directory: projectDir,
            project_id: project.id,
            created_at: 1000,
            last_activity_at: 1500,
          }),
        );
        db.upsertManaged(
          makeManagedRow({
            instance_id: "managed-newer",
            provider_session_id: "shared-provider-session",
            transcript_path: transcriptPath,
            working_directory: projectDir,
            project_id: project.id,
            created_at: 2000,
            last_activity_at: 2500,
            resume_cursor_json: JSON.stringify({ sessionId: "shared-provider-session" }),
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(manager.baseConfig));
      restored.projectManager.addProject(projectDir);
      restored.restoreInstances();

      assert.equal(restored.getInstance("managed-older"), undefined);
      assert.ok(restored.getInstance("managed-newer"));

      const chats = restored.listProjectChats(project.id);
      assert.equal(chats.filter((chat) => chat.sessionId === "shared-provider-session").length, 1);

      const verifyDb = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        assert.equal(verifyDb.getManagedByInstanceId("managed-older")?.archived, 1);
        assert.equal(verifyDb.getManagedByInstanceId("managed-newer")?.archived, 0);
      } finally {
        verifyDb.close();
      }
    });

    it("restores external sessions as historical until rediscovered live", () => {
      const projectDir = manager.baseConfig.workingDirectory;
      const transcriptPath = join(projectDir, "external-session.jsonl");
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "init",
          cwd: projectDir,
          sessionId: "external-1",
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsert(
          makeExternalRow({
            working_directory: projectDir,
            jsonl_path: transcriptPath,
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(manager.baseConfig));
      restored.projectManager.addProject(projectDir);
      restored.restoreInstances();

      const info = restored.getInstance("external-instance-1");
      const instance = restored.instances.get("external-instance-1");

      assert.ok(info);
      assert.ok(instance);
      assert.equal(info.status, "stopped");
      assert.equal(instance.jsonlPath, transcriptPath);
      assert.equal(instance.externalState, undefined);
      assert.equal(instance.watchState, undefined);
    });

    it("upgrades restored historical externals when discovery rediscovers them", async () => {
      const projectDir = manager.baseConfig.workingDirectory;
      const transcriptPath = join(projectDir, "external-redisco.jsonl");
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "init",
          cwd: projectDir,
          sessionId: "external-1",
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsert(
          makeExternalRow({
            working_directory: projectDir,
            jsonl_path: transcriptPath,
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(manager.baseConfig));
      restored.projectManager.addProject(projectDir);
      restored.restoreInstances();
      restored.discoverExternalSessions = async () => [
        {
          provider: "claude",
          cwd: projectDir,
          transcriptPath,
          sessionId: "external-1",
          pid: 1234,
        },
      ];

      await restored.discoverExistingInner();

      const info = restored.getInstance("external-instance-1");
      const instance = restored.instances.get("external-instance-1");

      assert.ok(info);
      assert.ok(instance);
      assert.equal(info.status, "idle");
      assert.equal(instance.externalState?.jsonlPath, transcriptPath);
      assert.equal(instance.externalState?.pid, 1234);
      assert.ok(instance.watchState);
    });

    it("waits for the external pid to exit before spawning the takeover session", async () => {
      const projectDir = manager.baseConfig.workingDirectory;
      const transcriptPath = join(projectDir, "external-takeover.jsonl");
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "init",
          cwd: projectDir,
          sessionId: "external-1",
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsert(
          makeExternalRow({
            working_directory: projectDir,
            jsonl_path: transcriptPath,
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(manager.baseConfig));
      restored.projectManager.addProject(projectDir);
      restored.restoreInstances();
      restored.discoverExternalSessions = async () => [
        {
          provider: "claude",
          cwd: projectDir,
          transcriptPath,
          sessionId: "external-1",
          pid: 4321,
        },
      ];
      await restored.discoverExistingInner();

      const order = [];
      const fakeProc = new FakeProviderSession("claude");
      const originalKill = process.kill;
      let waitCalls = 0;

      restored.waitForPidExit = (_pid, timeoutMs = 5000) => {
        order.push(`wait:${timeoutMs}`);
        waitCalls += 1;
        return waitCalls > 1;
      };
      restored.createProviderSession = () => {
        order.push("create");
        return fakeProc;
      };
      process.kill = (pid, signal) => {
        order.push(`kill:${pid}:${String(signal)}`);
        return true;
      };

      try {
        const info = await restored.takeoverInstance("external-instance-1");
        assert.ok(info);
      } finally {
        process.kill = originalKill;
      }

      assert.deepEqual(order, [
        "kill:4321:SIGINT",
        "wait:5000",
        "kill:4321:9",
        "wait:2000",
        "create",
      ]);

      const instance = restored.instances.get("external-instance-1");
      assert.ok(instance);
      assert.equal(instance.info.external, false);
      assert.equal(instance.externalState, undefined);
      assert.equal(instance.process, fakeProc);
    });

    it("proceeds with takeover when the external pid is already gone (ESRCH)", async () => {
      const projectDir = manager.baseConfig.workingDirectory;
      const transcriptPath = join(projectDir, "external-takeover-esrch.jsonl");
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "init",
          cwd: projectDir,
          sessionId: "external-1",
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsert(
          makeExternalRow({
            working_directory: projectDir,
            jsonl_path: transcriptPath,
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(manager.baseConfig));
      restored.projectManager.addProject(projectDir);
      restored.restoreInstances();
      restored.discoverExternalSessions = async () => [
        {
          provider: "claude",
          cwd: projectDir,
          transcriptPath,
          sessionId: "external-1",
          pid: 4321,
        },
      ];
      await restored.discoverExistingInner();

      const order = [];
      const fakeProc = new FakeProviderSession("claude");
      const originalKill = process.kill;

      restored.waitForPidExit = async (_pid, timeoutMs = 5000) => {
        order.push(`wait:${timeoutMs}`);
        return true;
      };
      restored.createProviderSession = () => {
        order.push("create");
        return fakeProc;
      };
      process.kill = (pid, signal) => {
        order.push(`kill:${pid}:${String(signal)}`);
        const err = new Error("kill ESRCH");
        err.code = "ESRCH";
        throw err;
      };

      try {
        const info = await restored.takeoverInstance("external-instance-1");
        assert.ok(info);
      } finally {
        process.kill = originalKill;
      }

      // SIGINT hit a dead PID — no waiting or SIGKILL, straight to resume
      assert.deepEqual(order, ["kill:4321:SIGINT", "create"]);

      const instance = restored.instances.get("external-instance-1");
      assert.ok(instance);
      assert.equal(instance.info.external, false);
      assert.equal(instance.externalState, undefined);
      assert.equal(instance.process, fakeProc);
    });

    it("treats a zombie external pid as exited while waiting", async () => {
      const originalKill = process.kill;
      // kill(pid, 0) always "succeeds" — the process table entry still exists
      process.kill = () => true;
      manager.isZombieProcess = async () => true;
      try {
        assert.equal(await manager.waitForPidExit(999999, 1000), true);
      } finally {
        process.kill = originalKill;
      }
    });

    it("refreshes the live git branch without waiting for a new message", async () => {
      const repoDir = makeRepoDir();

      const info = manager.createInstance({ workingDirectory: repoDir });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);
      assert.equal(instance.info.gitInfo?.branch, "main");

      runGit(repoDir, ["checkout", "-q", "-b", "feature-branch"]);

      await manager.refreshGitBranchStateAsync(info.id, instance);

      assert.equal(instance.info.gitInfo?.branch, "feature-branch");
      assert.equal(instance.info.originalGitBranch, "main");
    });

    it("warns only once per missing space-owned working directory during git refresh", async () => {
      const warnings = [];
      const logger = {
        info() {},
        warn(message) {
          warnings.push(String(message));
        },
        error() {},
        debug() {},
      };
      const noisyManager = trackManager(new InstanceManager(makeConfig({ logger })));
      const space = noisyManager
        .getSpaceManager()
        .createSpace(noisyManager.baseConfig.workingDirectory, {
          name: "Missing worktree",
        });
      assert.ok(space.worktreePath);

      const info = noisyManager.createInstance({ spaceId: space.id });
      const instance = noisyManager.instances.get(info.id);
      assert.ok(instance);

      rmSync(space.worktreePath, { recursive: true, force: true });

      await noisyManager.refreshGitBranchStateAsync(info.id, instance);
      await noisyManager.refreshGitBranchStateAsync(info.id, instance);

      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0],
        /Space-owned working directory .* is missing; keeping stale path to avoid falling back into the main repo/,
      );
    });
  });

  describe("provider registry", () => {
    it("surfaces available providers with capabilities", () => {
      const providers = manager.getAvailableProviders();
      assert.ok(providers.some((provider) => provider.provider === "claude"));
      for (const provider of providers) {
        assert.equal(typeof provider.capabilities.supportsResume, "boolean");
        assert.equal(typeof provider.capabilities.supportsModelSelection, "boolean");
      }
    });

    it("returns provider capabilities from the shared registry", () => {
      const _claude = manager.getProviderCapabilities("claude");
      const codex = manager.getProviderCapabilities("codex");
      assert.equal(codex.supportsTitleUpdates, true);
    });

    it("rejects switching to an unknown/unavailable provider", async () => {
      const info = manager.createInstance();
      assert.equal(await manager.setProvider(info.id, "gemini"), false);
    });

    it("applies target provider defaults when switching an empty chat", async () => {
      manager.sessionDb.updateGlobalSettings({
        provider_defaults_json: JSON.stringify({
          codex: {
            model: "gpt-5.4",
            reasoningEffort: "high",
          },
        }),
      });

      const info = manager.createInstance({ provider: "claude" });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      assert.equal(await manager.setProvider(info.id, "codex"), true);
      assert.equal(instance.info.provider, "codex");
      assert.equal(instance.info.preferredModel, "gpt-5.4");
      assert.deepEqual(instance.info.modelOptions, { reasoningEffort: "high" });
    });
  });

  describe("removeInstance", () => {
    it("removes an instance", () => {
      const info = manager.createInstance();
      assert.equal(manager.removeInstance(info.id), true);
      assert.equal(manager.listInstances().length, 0);
    });

    it("returns false for unknown id", () => {
      assert.equal(manager.removeInstance("nonexistent"), false);
    });

    it("frees a slot for new instances", () => {
      const a = manager.createInstance();
      manager.createInstance();
      manager.createInstance();
      assert.throws(() => manager.createInstance(), /Maximum/);
      manager.removeInstance(a.id);
      const d = manager.createInstance(); // should succeed now
      assert.ok(d.id);
    });

    it("does not remove a shared space worktree when deleting one chat", () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Shared space",
      });
      assert.ok(space.worktreePath);
      assert.equal(existsSync(space.worktreePath), true);

      const info = manager.createInstance({ spaceId: space.id });
      assert.equal(manager.removeInstance(info.id), true);

      const refreshedSpace = manager.getSpaceManager().getSpace(space.id);
      assert.ok(refreshedSpace?.worktreePath);
      assert.equal(existsSync(refreshedSpace.worktreePath), true);
    });

    it("preserves a shared space worktree even if the instance is missing in-memory spaceId", () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Recovered shared space",
      });
      assert.ok(space.worktreePath);
      assert.equal(existsSync(space.worktreePath), true);

      const info = manager.createInstance({ spaceId: space.id });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      instance.info.spaceId = undefined;

      assert.equal(manager.removeInstance(info.id), true);

      const refreshedSpace = manager.getSpaceManager().getSpace(space.id);
      assert.ok(refreshedSpace?.worktreePath);
      assert.equal(existsSync(refreshedSpace.worktreePath), true);
    });

    it("archives attached reviews when removing a source chat without purge", () => {
      const source = manager.createInstance({ name: "Source Chat" });
      const review = manager.createInstance({
        name: "Review: source",
        parentSessionId: "source-session",
        review: {
          sourceInstanceId: source.id,
          sourceName: source.name,
          scope: "branch",
        },
      });
      const reviewInstance = manager.instances.get(review.id);
      assert.ok(reviewInstance);

      const transcriptPath = join(manager.baseConfig.workingDirectory, "remove-review-chat.jsonl");
      writeFileSync(
        transcriptPath,
        '{"type":"message","message":{"role":"user","content":"hi"}}\n',
      );

      reviewInstance.sessionId = "review-session";
      reviewInstance.jsonlPath = transcriptPath;
      reviewInstance.providerBinding = {
        provider: "claude",
        providerSessionId: "review-session",
        resumeCursor: { sessionId: "review-session" },
        runtimePayload: {
          review: {
            sourceInstanceId: source.id,
            sourceName: source.name,
            scope: "branch",
          },
        },
        transcriptPath,
        runtimeMode: "approval-required",
      };
      manager.sessionDb.upsertManaged(
        makeManagedRow({
          instance_id: review.id,
          provider_session_id: "review-session",
          transcript_path: transcriptPath,
          working_directory: manager.baseConfig.workingDirectory,
          project_id: source.projectId,
          name: "Review: source",
          runtime_payload_json: JSON.stringify({
            review: {
              sourceInstanceId: source.id,
              sourceName: source.name,
              scope: "branch",
            },
          }),
        }),
      );

      assert.equal(manager.removeInstance(source.id), true);
      assert.equal(manager.getInstance(review.id), undefined);
      assert.equal(manager.sessionDb.getManagedByInstanceId(review.id)?.archived, 1);
    });

    it("purges a removed space chat from Relay and disk", () => {
      const project = manager.projectManager.addProject(manager.baseConfig.workingDirectory);
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Purge space",
      });
      assert.ok(space.worktreePath);

      const info = manager.createInstance({ spaceId: space.id, name: "Purge me" });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const transcriptPath = join(manager.baseConfig.workingDirectory, "purge-space-chat.jsonl");
      writeFileSync(
        transcriptPath,
        '{"type":"message","message":{"role":"user","content":"hi"}}\n',
      );

      instance.sessionId = "purge-session";
      instance.jsonlPath = transcriptPath;
      instance.providerBinding = {
        provider: "claude",
        providerSessionId: "purge-session",
        resumeCursor: { sessionId: "purge-session" },
        runtimePayload: {},
        transcriptPath,
        runtimeMode: "approval-required",
      };

      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: info.id,
            provider_session_id: "purge-session",
            transcript_path: transcriptPath,
            working_directory: space.worktreePath,
            worktree_path: space.worktreePath,
            original_directory: manager.baseConfig.workingDirectory,
            git_branch: space.gitBranch,
            space_id: space.id,
            project_id: project.id,
            name: "Purge me",
          }),
        );
        db.upsert(
          makeExternalRow({
            session_id: "purge-session",
            instance_id: info.id,
            jsonl_path: transcriptPath,
            working_directory: manager.baseConfig.workingDirectory,
            worktree_path: space.worktreePath,
            original_directory: manager.baseConfig.workingDirectory,
            git_branch: space.gitBranch,
            space_id: space.id,
            project_id: project.id,
            name: "Purge me",
          }),
        );
      } finally {
        db.close();
      }

      assert.equal(
        manager.listSpaceChats(space.id).some((chat) => chat.id === info.id),
        true,
      );
      assert.equal(manager.removeInstance(info.id, { purge: true }), true);
      assert.equal(existsSync(transcriptPath), false);
      assert.equal(
        manager.listSpaceChats(space.id).some((chat) => chat.id === info.id),
        false,
      );

      const verifyDb = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        assert.equal(verifyDb.getBySessionId("purge-session"), undefined);
        assert.equal(verifyDb.getManagedByInstanceId(info.id), undefined);
      } finally {
        verifyDb.close();
      }
    });
  });

  describe("listProjectChats", () => {
    it("dedupes managed transcript shadows after backfilling explicit space ids", () => {
      const project = manager.projectManager.addProject(manager.baseConfig.workingDirectory);
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Space",
      });
      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);

      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "managed-space-chat",
            provider_session_id: "shared-session",
            transcript_path: "/tmp/shared.jsonl",
            working_directory: space.worktreePath,
            worktree_path: space.worktreePath,
            original_directory: manager.baseConfig.workingDirectory,
            git_branch: space.gitBranch,
            space_id: space.id,
            project_id: project.id,
            name: "Managed space chat",
          }),
        );

        db.upsert(
          makeExternalRow({
            session_id: "shared-session",
            instance_id: "shadow-external",
            jsonl_path: "/tmp/shared.jsonl",
            working_directory: manager.baseConfig.workingDirectory,
            original_directory: manager.baseConfig.workingDirectory,
            worktree_path: space.worktreePath,
            git_branch: "main",
            space_id: null,
            project_id: project.id,
            name: "Shadow external",
          }),
        );

        db.upsert(
          makeExternalRow({
            session_id: "external-space-only",
            instance_id: "external-space-only",
            jsonl_path: "/tmp/external-space-only.jsonl",
            working_directory: manager.baseConfig.workingDirectory,
            original_directory: manager.baseConfig.workingDirectory,
            worktree_path: space.worktreePath,
            git_branch: "main",
            space_id: null,
            project_id: project.id,
            name: "External inferred space chat",
          }),
        );
      } finally {
        db.close();
      }

      manager.backfillMissingSpaceIds();

      const chats = manager.listProjectChats(project.id);
      assert.equal(
        chats.some((chat) => chat.id === "shadow-external"),
        false,
      );

      const inferred = chats.find((chat) => chat.id === "external-space-only");
      assert.ok(inferred);
      assert.equal(inferred.spaceId, space.id);

      const managed = chats.find((chat) => chat.id === "managed-space-chat");
      assert.ok(managed);
      assert.equal(managed.spaceId, space.id);

      const rows = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        assert.equal(rows.getByInstanceId("external-space-only")?.space_id, space.id);
      } finally {
        rows.close();
      }
    });

    it("setInstancePinned pins chats without a live instance and surfaces pinned in summaries", async () => {
      const project = manager.projectManager.addProject(manager.baseConfig.workingDirectory);
      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsert(
          makeExternalRow({
            session_id: "pinned-session",
            instance_id: "pinned-chat",
            jsonl_path: "/tmp/pinned.jsonl",
            working_directory: manager.baseConfig.workingDirectory,
            project_id: project.id,
            name: "Old chat",
          }),
        );
      } finally {
        db.close();
      }

      // No live in-memory instance — the pin must persist via the DB alone.
      assert.equal(manager.instances.has("pinned-chat"), false);
      assert.equal(await manager.setInstancePinned("pinned-chat", true), true);

      const pinned = manager.listProjectChats(project.id).find((c) => c.id === "pinned-chat");
      assert.ok(pinned);
      assert.equal(pinned.pinned, true);

      assert.equal(await manager.setInstancePinned("pinned-chat", false), true);
      const unpinned = manager.listProjectChats(project.id).find((c) => c.id === "pinned-chat");
      assert.equal(unpinned.pinned, false);

      assert.equal(await manager.setInstancePinned("missing-chat", true), false);
    });
  });

  describe("getHistory", () => {
    it("returns empty history for new instance", () => {
      const info = manager.createInstance();
      const history = manager.getHistory(info.id);
      assert.deepEqual(history, []);
    });

    it("returns transcript history for stopped managed chats without booting them", () => {
      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "managed-passive",
            provider_name: "codex",
            provider_session_id: "codex-test-session",
            working_directory: manager.baseConfig.workingDirectory,
            transcript_path: join(fixturesDir, "codex-managed-session.jsonl"),
            resume_cursor_json: JSON.stringify({ sessionId: "codex-test-session" }),
          }),
        );
      } finally {
        db.close();
      }

      manager.restoreInstances();

      const instance = manager.instances.get("managed-passive");
      assert.ok(instance);
      const originalLastActivity = instance.info.lastActivityAt;
      let bootCalls = 0;
      manager.bootManagedInstance = () => {
        bootCalls += 1;
      };

      const history = manager.getHistory("managed-passive");

      assert.ok(history.length > 0);
      assert.equal(bootCalls, 0);
      assert.equal(instance.process, null);
      assert.equal(instance.hydrated, false);
      assert.equal(instance.info.status, "stopped");
      assert.equal(instance.info.lastActivityAt, originalLastActivity);
    });

    it("refreshes hydrated chat history from transcript on passive reads", () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const transcriptPath = join(manager.baseConfig.workingDirectory, "hydrated-passive.jsonl");
      writeFileSync(transcriptPath, readFileSync(join(fixturesDir, "codex-managed-session.jsonl")));

      instance.info.provider = "codex";
      instance.info.status = "stopped";
      instance.sessionId = "hydrated-passive-session";
      instance.jsonlPath = transcriptPath;
      instance.hydrated = true;
      instance.history = [
        {
          timestamp: Date.parse("2026-05-07T23:59:00.000Z"),
          message: {
            type: "user",
            instanceId: info.id,
            text: "stale question",
          },
        },
      ];

      const history = manager.getHistory(info.id);
      const userMessages = history.filter((entry) => entry.message.type === "user");

      assert.equal(userMessages.length, 1);
      assert.equal(userMessages[0].message.text, "How do I build this?");
      assert.equal(
        instance.history.some((entry) => entry.message.text === "How do I build this?"),
        true,
      );
      assert.equal(instance.info.lastMessage?.text, "Run `npm run build`. It passes.");
    });

    it("throws for unknown instance", () => {
      assert.throws(() => manager.getHistory("nope"), /not found/);
    });
  });

  describe("broken spaces", () => {
    it("allows passive history reads for chats in broken isolated spaces", () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Broken history guard",
      });
      assert.ok(space.worktreePath);

      const info = manager.createInstance({ spaceId: space.id });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      rmSync(space.worktreePath, { recursive: true, force: true });
      instance.process = null;
      instance.info.status = "stopped";

      assert.doesNotThrow(() => manager.getHistory(info.id));
      assert.equal(instance.process, null);
      assert.equal(instance.info.status, "stopped");
    });

    it("blocks sending messages to chats in broken isolated spaces", async () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Broken send guard",
      });
      assert.ok(space.worktreePath);

      const info = manager.createInstance({ spaceId: space.id });
      rmSync(space.worktreePath, { recursive: true, force: true });

      await assert.rejects(
        () => manager.sendMessage(info.id, "hello"),
        /missing its worktree and is currently read-only/,
      );
    });
  });

  describe("queued message removal", () => {
    function attachProcessingProc(instance) {
      const fakeProc = new FakeProviderSession("codex");
      fakeProc.isProcessing = true;
      instance.process = fakeProc;
      return fakeProc;
    }

    it("removes a single queued message by id, preserving order and count", async () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      attachProcessingProc(instance);

      await manager.sendMessage(info.id, "first");
      await manager.sendMessage(info.id, "second");
      await manager.sendMessage(info.id, "third");

      const queued = manager.getPendingQueuedMessages(info.id);
      assert.equal(queued.length, 3);
      assert.ok(queued.every((m) => m.queued && m.queuedId));

      const removedEvents = [];
      manager.on("instance:queued_removed", (id, message) => removedEvents.push({ id, message }));

      await manager.removeQueuedMessage(info.id, queued[1].queuedId);

      const remaining = manager.getPendingQueuedMessages(info.id);
      assert.deepEqual(
        remaining.map((m) => m.text),
        ["first", "third"],
      );
      assert.equal(instance.info.queuedMessageCount, 2);
      assert.equal(removedEvents.length, 1);
      assert.equal(removedEvents[0].id, info.id);
      assert.deepEqual(removedEvents[0].message, {
        type: "queued_removed",
        instanceId: info.id,
        queuedId: queued[1].queuedId,
      });
    });

    it("clears queuedMessageCount when the last queued message is removed", async () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      attachProcessingProc(instance);

      await manager.sendMessage(info.id, "only one");
      const [queued] = manager.getPendingQueuedMessages(info.id);
      assert.equal(instance.info.queuedMessageCount, 1);

      await manager.removeQueuedMessage(info.id, queued.queuedId);

      assert.equal(manager.getPendingQueuedMessages(info.id).length, 0);
      assert.equal(instance.info.queuedMessageCount, undefined);
      assert.equal(instance.pendingMessages, undefined);
    });

    it("rejects removal of a message that is no longer queued", async () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      attachProcessingProc(instance);

      await assert.rejects(
        () => manager.removeQueuedMessage(info.id, "missing-id"),
        /no longer queued/,
      );

      await manager.sendMessage(info.id, "queued");
      const [queued] = manager.getPendingQueuedMessages(info.id);
      await manager.removeQueuedMessage(info.id, queued.queuedId);
      await assert.rejects(
        () => manager.removeQueuedMessage(info.id, queued.queuedId),
        /no longer queued/,
      );
    });

    it("exposes source text and attachment paths on queued messages for edit restore", async () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      attachProcessingProc(instance);

      await manager.sendMessage(info.id, "look at this", ["/tmp/shot.png"]);

      const [queued] = manager.getPendingQueuedMessages(info.id);
      assert.equal(queued.queuedSourceText, "look at this");
      assert.deepEqual(queued.images, ["/tmp/shot.png"]);
      assert.match(queued.text, /\[Image: source: \/tmp\/shot\.png\]/);
    });
  });

  describe("sendMessage guards", () => {
    it("throws for unknown instance", async () => {
      await assert.rejects(() => manager.sendMessage("nope", "hi"), /not found/);
    });

    it("folds task guidance into the first real user turn instead of sending a separate hidden turn", async () => {
      const relayDir = join(manager.baseConfig.workingDirectory, ".relay");
      mkdirSync(relayDir, { recursive: true });
      writeFileSync(
        join(relayDir, "tasks.json"),
        '{"version":1,"tasks":[{"id":"task1234","title":"Test","status":"open"}]}\n',
      );

      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const sentMessages = [];
      instance.process = {
        ...instance.process,
        isProcessing: false,
        provider: "codex",
        pid: undefined,
        stats: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        send(text) {
          sentMessages.push(text);
        },
        interrupt() {},
        close() {},
        setModel() {},

        addAllowedTool() {},
        setRuntimeMode() {},
        getRuntimeBinding() {
          return { provider: "codex" };
        },
        respondToRequest() {
          return false;
        },
      };

      await manager.sendMessage(info.id, "tell me how to run this locally");

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0], "tell me how to run this locally");
      assert.equal(
        instance.info.sessionContext?.bootstrap?.blocks.some((b) => b.kind === "task_guidance"),
        true,
      );

      const history = manager.getHistory(info.id).filter((entry) => entry.message.type === "user");
      assert.equal(history.length, 1);
      assert.equal(history[0].message.text, "tell me how to run this locally");
      assert.equal(history[0].message.internal, undefined);
    });

    it("boots a stopped managed chat only when the user sends a message", async () => {
      const db = new SessionDB(manager.baseConfig.dbPath, noopLogger);
      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "managed-send",
            provider_name: "codex",
            provider_session_id: "managed-send-session",
            working_directory: manager.baseConfig.workingDirectory,
            resume_cursor_json: JSON.stringify({ sessionId: "managed-send-session" }),
          }),
        );
      } finally {
        db.close();
      }

      manager.restoreInstances();

      const fakeProc = new FakeProviderSession("codex");
      let bootCalls = 0;
      manager.bootManagedInstance = (_id, instance) => {
        bootCalls += 1;
        instance.process = fakeProc;
        instance.providerBinding = fakeProc.getRuntimeBinding();
        instance.sessionId = "managed-send-session";
        instance.info.sessionId = "managed-send-session";
      };

      await manager.sendMessage("managed-send", "resume this stopped chat");

      const instance = manager.instances.get("managed-send");
      assert.equal(bootCalls, 1);
      assert.equal(instance.process, fakeProc);
      assert.equal(fakeProc.sent.length, 1);
      assert.match(fakeProc.sent[0], /resume this stopped chat/);
      assert.equal(instance.info.status, "processing");
    });

    it("still sends messages after a branch change while surfacing branch drift", async () => {
      const repoDir = makeRepoDir();

      const info = manager.createInstance({ workingDirectory: repoDir });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const sentMessages = [];
      instance.process = {
        ...instance.process,
        isProcessing: false,
        provider: "codex",
        pid: undefined,
        stats: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        send(text) {
          sentMessages.push(text);
        },
        interrupt() {},
        close() {},
        setModel() {},

        addAllowedTool() {},
        setRuntimeMode() {},
        getRuntimeBinding() {
          return { provider: "codex" };
        },
        respondToRequest() {
          return false;
        },
      };

      runGit(repoDir, ["checkout", "-q", "-b", "feature-branch"]);

      await manager.refreshGitBranchStateAsync(info.id, instance);
      await manager.sendMessage(info.id, "hello on the new branch");

      assert.deepEqual(instance.info.branchChanged, {
        originalBranch: "main",
        currentBranch: "feature-branch",
      });
      assert.equal(instance.info.gitInfo?.branch, "feature-branch");
      assert.deepEqual(sentMessages, ["hello on the new branch"]);
    });

    it("injects space brief contents into bootstrap context and keeps normal turns unwrapped", async () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Shared Bootstrap Context",
      });
      assert.ok(space.worktreePath);
      writeFileSync(
        join(space.worktreePath, ".relay", "space-context.md"),
        "## Status\nSibling chat is updating the API contract.\n",
      );

      const fakeProc = new FakeProviderSession("codex");
      manager.createProviderSession = (_config, options) => {
        fakeProc.bootstrapContext = options?.bootstrapContext;
        return fakeProc;
      };

      const info = manager.createInstance({ provider: "codex", spaceId: space.id });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);
      assert.equal(
        fakeProc.bootstrapContext.blocks.some((b) => b.kind === "space_context"),
        true,
      );
      const spaceBlock = fakeProc.bootstrapContext.blocks.find((b) => b.kind === "space_context");
      assert.match(spaceBlock.text, /shared Space/);
      assert.match(spaceBlock.text, /re-read it as you work/);
      // Regression guard (task b3e9f1a2): the brief's actual contents must be
      // injected, not just a pointer to the file. Regressed in commit 12fc245.
      assert.ok(spaceBlock.text.includes("Sibling chat is updating the API contract"));

      await manager.sendMessage(info.id, "continue with the backend changes");

      assert.equal(fakeProc.sent.length, 1);
      assert.equal(fakeProc.sent[0], "continue with the backend changes");
      assert.equal(
        instance.info.sessionContext.bootstrap.blocks.some((b) => b.kind === "space_context"),
        true,
      );

      const history = manager.getHistory(info.id).filter((entry) => entry.message.type === "user");
      assert.equal(history.length, 1);
      assert.equal(history[0].message.text, "continue with the backend changes");
    });

    it("does not inject seed-template-only space briefs (no real content)", async () => {
      const space = manager.getSpaceManager().createSpace(manager.baseConfig.workingDirectory, {
        name: "Pristine Brief",
      });
      assert.ok(space.worktreePath);
      // Leave the seeded template untouched — only headers + HTML-comment
      // placeholders, no authored content.
      const fakeProc = new FakeProviderSession("codex");
      manager.createProviderSession = (_config, options) => {
        fakeProc.bootstrapContext = options?.bootstrapContext;
        return fakeProc;
      };

      manager.createInstance({ provider: "codex", spaceId: space.id });

      const spaceBlock = fakeProc.bootstrapContext.blocks.find((b) => b.kind === "space_context");
      assert.ok(spaceBlock);
      assert.match(spaceBlock.text, /shared Space/);
      // Guidance only — no "Current ... contents" section for an empty template.
      assert.ok(!spaceBlock.text.includes("Current `.relay/space-context.md` contents"));
    });
  });

  describe("activity timestamps", () => {
    it("does not bump lastActivityAt for bootstrap-only provider events", async () => {
      const fakeProc = new FakeProviderSession("codex");
      manager.createProviderSession = () => fakeProc;

      const info = manager.createInstance({ provider: "codex" });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      instance.info.lastActivityAt = 424242;

      fakeProc.emit("systemEvent", {
        type: "system_event",
        event: "session_init",
        payload: { sessionId: "fake-session", cwd: manager.baseConfig.workingDirectory },
      });
      fakeProc.emit("stats", {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
      fakeProc.emit("titleUpdate", "Renamed Session");
      fakeProc.emit("providerError", "temporary bootstrap noise");
      fakeProc.emit("exit", { type: "exit", code: 0 });

      await manager.flushInstanceMutations();

      assert.equal(instance.info.lastActivityAt, 424242);
      assert.equal(instance.info.name, "Renamed Session");
      assert.equal(instance.info.status, "stopped");
    });
  });

  describe("cancelMessage guards", () => {
    it("throws for unknown instance", async () => {
      await assert.rejects(() => manager.cancelMessage("nope"), /not found/);
    });
  });

  describe("approveToolUse guards", () => {
    it("throws for unknown instance", async () => {
      await assert.rejects(() => manager.approveToolUse("nope", "Bash"), /not found/);
    });
  });

  describe("respondToRequest", () => {
    it("falls back to a normal user message for provider-neutral AskUserQuestion replies", async () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const sentMessages = [];
      instance.process = {
        ...instance.process,
        isProcessing: false,
        provider: "claude",
        pid: undefined,
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        send(text) {
          sentMessages.push(text);
        },
        interrupt() {},
        close() {},
        setModel() {},

        addAllowedTool() {},
        setRuntimeMode() {},
        getRuntimeBinding() {
          return { provider: "claude" };
        },
        respondToRequest() {
          return false;
        },
      };

      instance.info.pendingPermission = {
        requestId: "ask-1",
        kind: "user_input",
        tool: "AskUserQuestion",
        questions: [
          {
            id: "drink",
            header: "Preference",
            question: "Which do you prefer?",
            options: [
              { label: "Coffee", description: "Bolder flavor" },
              { label: "Tea", description: "Lighter flavor" },
            ],
          },
        ],
      };

      await manager.respondToRequest(info.id, "ask-1", "accept", {
        answers: {
          drink: {
            answers: ["Tea"],
          },
        },
      });

      assert.deepEqual(sentMessages, ["> Which do you prefer?\n\nTea"]);
      assert.equal(instance.info.pendingPermission, undefined);
      const lastHistory = instance.history[instance.history.length - 2];
      assert.equal(lastHistory.message.type, "activity");
      assert.equal(lastHistory.message.tool, "AskUserQuestion");
      assert.equal(lastHistory.message.resolution, "approved");
    });

    it("turns empty AskUserQuestion answers into a dismiss-style fallback reply", async () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const sentMessages = [];
      instance.process = {
        ...instance.process,
        isProcessing: false,
        provider: "claude",
        pid: undefined,
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        send(text) {
          sentMessages.push(text);
        },
        interrupt() {},
        close() {},
        setModel() {},

        addAllowedTool() {},
        setRuntimeMode() {},
        getRuntimeBinding() {
          return { provider: "claude" };
        },
        respondToRequest() {
          return false;
        },
      };

      instance.info.pendingPermission = {
        requestId: "ask-2",
        kind: "user_input",
        tool: "AskUserQuestion",
        questions: [
          {
            id: "drink",
            header: "Preference",
            question: "Which do you prefer?",
          },
        ],
      };

      await manager.respondToRequest(info.id, "ask-2", "accept", { answers: {} });

      assert.equal(
        sentMessages[0],
        "I prefer not to answer that question. Please continue without it if possible.",
      );
      const lastHistory = instance.history[instance.history.length - 2];
      assert.equal(lastHistory.message.type, "activity");
      assert.equal(lastHistory.message.resolution, "dismissed");
    });
  });

  describe("rebuildPendingInteractiveState (AskUserQuestion replay)", () => {
    // Parse real JSONL so the tool_result carries the parser's actual shape:
    // `tool: undefined` + `resolution: "approved"` (the parser only tags `tool`
    // on permission denials). This is what made the panel reappear on reload.
    const askToolUseEntry = {
      type: "assistant",
      timestamp: "2026-06-06T12:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_ask_1",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  id: "drink",
                  header: "Preference",
                  question: "Which do you prefer?",
                  options: [{ label: "Coffee" }, { label: "Tea" }],
                },
              ],
            },
          },
        ],
      },
    };
    const askToolResultEntry = {
      type: "user",
      timestamp: "2026-06-06T12:00:05.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_ask_1", is_error: false, content: "Tea" },
        ],
      },
    };

    function parseHistory(manager, entries) {
      const ctx = {
        pendingTools: new Map(),
        pendingTaskCreates: new Map(),
        tasks: new Map(),
        files: new Map(),
        stats: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      };
      const history = [];
      for (const entry of entries) {
        history.push(...manager.convertJsonlEntry(entry, ctx));
      }
      return history;
    }

    it("clears pendingPermission when an answered question is replayed", () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      instance.history = parseHistory(manager, [askToolUseEntry, askToolResultEntry]);

      // Sanity: the parsed tool_result really has the problematic shape.
      const toolResult = instance.history.find(
        (e) => e.message.type === "activity" && e.message.activity === "tool_result",
      );
      assert.ok(toolResult, "expected a parsed tool_result activity");
      assert.equal(toolResult.message.tool, undefined);
      assert.equal(toolResult.message.resolution, "approved");

      manager.rebuildPendingInteractiveState(instance);

      assert.equal(
        instance.info.pendingPermission,
        undefined,
        "an answered AskUserQuestion must not leave a pending request after replay",
      );
    });

    it("keeps pendingPermission when the question is unanswered (no tool_result)", () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      // Only the tool_use — the genuinely-waiting case (transcript ends on the question).
      instance.history = parseHistory(manager, [askToolUseEntry]);

      manager.rebuildPendingInteractiveState(instance);

      assert.equal(instance.info.pendingPermission?.kind, "user_input");
      assert.equal(instance.info.pendingPermission?.requestId, "tu_ask_1");
    });
  });

  describe("stopAll", () => {
    it("clears all instances", () => {
      manager.createInstance();
      manager.createInstance();
      manager.stopAll();
      assert.equal(manager.listInstances().length, 0);
    });
  });

  describe("status events", () => {
    it("emits instance:status on status change", (_, done) => {
      // We can't easily test processing without a real claude process,
      // but we can verify the event infrastructure works by checking
      // that createInstance sets up proper event wiring
      const info = manager.createInstance();
      assert.equal(info.status, "idle");
      done();
    });
  });

  describe("watcher dedup", () => {
    it("skips watcher entries already handled by the managed process", () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const now = Date.now();
      instance.processHandledUntil = now + 2_000;
      instance.watchState = {
        jsonlPath: "/tmp/test.jsonl",
        fileOffset: 0,
        pendingTools: new Map(),
        pendingTaskCreates: new Map(),
        stats: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
        },
      };
      instance.info.stats = { ...instance.watchState.stats };

      manager.applyWatcherEntry(info.id, instance, {
        type: "assistant",
        timestamp: new Date(now + 1_000).toISOString(),
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 40,
          },
          content: [{ type: "text", text: "duplicate output" }],
        },
      });

      assert.equal(instance.history.length, 0);
      assert.deepEqual(instance.watchState.stats, {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
      });
      assert.deepEqual(instance.info.stats, {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
      });
    });

    it("applies watcher entries newer than the managed-process watermark", () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const now = Date.now();
      instance.processHandledUntil = now + 500;
      instance.watchState = {
        jsonlPath: "/tmp/test.jsonl",
        fileOffset: 0,
        pendingTools: new Map(),
        pendingTaskCreates: new Map(),
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };
      instance.info.stats = { ...instance.watchState.stats };

      manager.applyWatcherEntry(info.id, instance, {
        type: "assistant",
        timestamp: new Date(now + 5_000).toISOString(),
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 40,
          },
          content: [{ type: "text", text: "fresh external output" }],
        },
      });

      assert.equal(instance.history.length, 2);
      assert.equal(instance.history[0].message.type, "output");
      assert.equal(instance.history[1].message.type, "output");
      assert.equal(instance.history[0].message.text, "fresh external output");
      assert.equal(instance.history[1].message.isWaiting, true);
      assert.equal(instance.watchState.stats.inputTokens, 10);
      assert.equal(instance.watchState.stats.outputTokens, 20);
      assert.equal(instance.watchState.stats.cacheCreationTokens, 30);
      assert.equal(instance.watchState.stats.cacheReadTokens, 40);
      assert.equal(instance.info.stats.inputTokens, 10);
      assert.equal(instance.info.stats.outputTokens, 20);
    });

    it("skips instance:user emit from watcher for managed instances", () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      // Simulate a managed instance (has a process object)
      instance.process = { isProcessing: false };
      instance.watchState = {
        jsonlPath: "/tmp/test.jsonl",
        fileOffset: 0,
        pendingTools: new Map(),
        pendingTaskCreates: new Map(),
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };

      const emitted = [];
      manager.on("instance:user", (id, msg) => emitted.push({ id, msg }));

      manager.applyWatcherEntry(info.id, instance, {
        type: "user",
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "hello from watcher" }],
        },
      });

      // User message should be in history (pushHistory still runs)
      const userEntries = instance.history.filter((h) => h.message.type === "user");
      assert.equal(userEntries.length, 1);

      // But instance:user should NOT have been emitted (managed instance)
      assert.equal(emitted.length, 0);
    });

    it("emits instance:user from watcher for external instances", () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      // External instance: no process
      instance.process = null;
      instance.watchState = {
        jsonlPath: "/tmp/test.jsonl",
        fileOffset: 0,
        pendingTools: new Map(),
        pendingTaskCreates: new Map(),
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };

      const emitted = [];
      manager.on("instance:user", (id, msg) => emitted.push({ id, msg }));

      manager.applyWatcherEntry(info.id, instance, {
        type: "user",
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "hello from terminal" }],
        },
      });

      // User message should be in history
      const userEntries = instance.history.filter((h) => h.message.type === "user");
      assert.equal(userEntries.length, 1);

      // instance:user SHOULD be emitted (external instance)
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].msg.text, "hello from terminal");
    });

    it("maps watcher AskUserQuestion entries into pending composer state", () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      instance.watchState = {
        jsonlPath: "/tmp/test.jsonl",
        fileOffset: 0,
        pendingTools: new Map(),
        pendingTaskCreates: new Map(),
        stats: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };

      manager.applyWatcherEntry(info.id, instance, {
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          content: [
            {
              type: "tool_use",
              id: "watch-ask-1",
              name: "AskUserQuestion",
              input: {
                // Real AskUserQuestion tool input has no `id` on questions —
                // it must be generated deterministically by index.
                questions: [
                  {
                    header: "Preference",
                    question: "Which do you prefer?",
                  },
                ],
              },
            },
          ],
        },
      });

      assert.equal(instance.info.pendingTool, undefined);
      assert.equal(instance.info.pendingPermission?.kind, "user_input");
      assert.equal(instance.info.pendingPermission?.requestId, "watch-ask-1");
      assert.equal(instance.info.pendingPermission?.questions?.[0]?.id, "q_0");
      const promptHistory = instance.history.find(
        (entry) =>
          entry.message.type === "activity" &&
          entry.message.activity === "tool_use" &&
          entry.message.tool === "AskUserQuestion",
      );
      assert.ok(promptHistory);
      assert.equal(promptHistory.message.input.requestId, "watch-ask-1");
    });
  });

  describe("model switch events", () => {
    // A minimal running process so sendMessage dispatches immediately instead
    // of queueing (isProcessing: false) or booting a real provider.
    function attachFakeProcess(instance) {
      const sent = [];
      instance.process = {
        isProcessing: false,
        provider: "claude",
        pid: undefined,
        stats: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        send(text) {
          sent.push(text);
        },
        interrupt() {},
        close() {},
        setModel() {},
        addAllowedTool() {},
        setRuntimeMode() {},
        getRuntimeBinding() {
          return { provider: "claude" };
        },
        respondToRequest() {
          return false;
        },
      };
      return sent;
    }

    it("switching the model in the UI records nothing until a message is sent", async () => {
      const config = makeConfig();
      const mgr = trackManager(new InstanceManager(config));
      const info = mgr.createInstance();
      const instance = mgr.instances.get(info.id);
      assert.ok(instance);

      const events = [];
      mgr.on("instance:system_event", (id, msg) => events.push(msg));

      // Toggle a few times without sending — like the user's screenshot.
      await mgr.setModel(info.id, "claude-sonnet-4-5");
      await mgr.setModel(info.id, "claude-opus-4-7");
      await mgr.setModel(info.id, "claude-sonnet-4-5");

      assert.equal(events.length, 0);
      const db = new SessionDB(config.dbPath, noopLogger);
      try {
        assert.equal(db.getSessionEvents(info.id).length, 0);
      } finally {
        db.close();
      }
    });

    it("records a divider at send time when the model changed since the previous turn", async () => {
      const config = makeConfig();
      const mgr = trackManager(new InstanceManager(config));
      const info = mgr.createInstance();
      const instance = mgr.instances.get(info.id);
      assert.ok(instance);
      attachFakeProcess(instance);

      const events = [];
      mgr.on("instance:system_event", (id, msg) => events.push(msg));

      // First turn establishes the baseline (sonnet) with no divider.
      await mgr.setModel(info.id, "claude-sonnet-4-5");
      await mgr.sendMessage(info.id, "first");
      assert.equal(events.length, 0);

      // Switch to opus, then send: divider sonnet → opus, above the second turn.
      await mgr.setModel(info.id, "claude-opus-4-7");
      await mgr.sendMessage(info.id, "second");

      assert.equal(events.length, 1);
      assert.equal(events[0].event, "model_switched");
      assert.equal(events[0].payload.fromModel, "claude-sonnet-4-5");
      assert.equal(events[0].payload.toModel, "claude-opus-4-7");

      // Divider sits directly above the "second" user message in history.
      const idxSwitch = instance.history.findIndex(
        (e) => e.message.type === "system_event" && e.message.event === "model_switched",
      );
      assert.ok(idxSwitch >= 0);
      const next = instance.history[idxSwitch + 1];
      assert.equal(next.message.type, "user");
      assert.equal(next.message.text, "second");

      // Persisted so hydration re-merges it after history rebuilds.
      const db = new SessionDB(config.dbPath, noopLogger);
      try {
        const rows = db.getSessionEvents(info.id);
        assert.equal(rows.length, 1);
        assert.equal(JSON.parse(rows[0].payload_json).toModel, "claude-opus-4-7");
      } finally {
        db.close();
      }
    });

    it("nets to nothing when the model is toggled and restored before sending", async () => {
      const config = makeConfig();
      const mgr = trackManager(new InstanceManager(config));
      const info = mgr.createInstance();
      const instance = mgr.instances.get(info.id);
      assert.ok(instance);
      attachFakeProcess(instance);

      const events = [];
      mgr.on("instance:system_event", (id, msg) => events.push(msg));

      // Baseline turn on the default model (opus).
      await mgr.sendMessage(info.id, "first");
      // Toggle away and back before sending again.
      await mgr.setModel(info.id, "claude-sonnet-4-5");
      await mgr.setModel(info.id, "claude-opus-5");
      await mgr.sendMessage(info.id, "second");

      // Net model is unchanged from the previous turn → no divider.
      assert.equal(events.length, 0);
      const db = new SessionDB(config.dbPath, noopLogger);
      try {
        assert.equal(db.getSessionEvents(info.id).length, 0);
      } finally {
        db.close();
      }
    });
  });

  describe("modelOptions", () => {
    it("restores modelOptions from model_options_json on managed session restore", () => {
      const config = makeConfig();
      const db = new SessionDB(config.dbPath, noopLogger);
      const modelOptions = { reasoningEffort: "high", fastMode: true };
      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "opts-1",
            working_directory: config.workingDirectory,
            provider_session_id: "session-opts-1",
            resume_cursor_json: JSON.stringify({ sessionId: "session-opts-1" }),
            preferred_model: "claude-opus-4-6",
            reasoning_budget: null,
            model_options_json: JSON.stringify(modelOptions),
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(config));
      restored.restoreInstances();
      const info = restored.getInstance("opts-1");

      assert.ok(info);
      assert.deepEqual(info.modelOptions, modelOptions);
      assert.equal(info.preferredModel, "claude-opus-4-6");
    });

    it("setModelOptions sparse-merges and null clears individual fields", async () => {
      const mgr = trackManager(new InstanceManager(makeConfig()));
      const info = mgr.createInstance();

      // Set both fields
      await mgr.setModelOptions(info.id, {
        reasoningEffort: "high",
        fastMode: true,
      });
      let updated = mgr.getInstance(info.id);
      assert.deepEqual(updated.modelOptions, {
        reasoningEffort: "high",
        fastMode: true,
      });

      // Sparse update: only change effort, leave others untouched
      await mgr.setModelOptions(info.id, { reasoningEffort: "max" });
      updated = mgr.getInstance(info.id);
      assert.equal(updated.modelOptions.reasoningEffort, "max");
      assert.equal(updated.modelOptions.fastMode, true);

      // Null clears a single field
      await mgr.setModelOptions(info.id, { fastMode: null });
      updated = mgr.getInstance(info.id);
      assert.equal(updated.modelOptions.fastMode, undefined);
      assert.equal(updated.modelOptions.reasoningEffort, "max");

      // Null-clearing all fields removes the bag entirely
      await mgr.setModelOptions(info.id, {
        reasoningEffort: null,
      });
      updated = mgr.getInstance(info.id);
      assert.equal(updated.modelOptions, undefined);
    });

    it("setModelOptions pushes to live process via setModelOptions", async () => {
      const mgr = trackManager(new InstanceManager(makeConfig()));
      const info = mgr.createInstance();
      const instance = mgr.instances.get(info.id);
      assert.ok(instance);

      const captured = [];
      instance.process = {
        ...instance.process,
        isProcessing: false,
        provider: "codex",
        pid: undefined,
        stats: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        send() {},
        interrupt() {},
        close() {},
        setModel() {},

        addAllowedTool() {},
        setRuntimeMode() {},
        setModelOptions(opts) {
          captured.push(opts);
        },
        getRuntimeBinding() {
          return { provider: "codex" };
        },
      };

      await mgr.setModelOptions(info.id, { reasoningEffort: "high", fastMode: true });
      assert.equal(captured.length, 1);
      assert.equal(captured[0].reasoningEffort, "high");
      assert.equal(captured[0].fastMode, true);
    });

    it("persists modelOptions to model_options_json in DB on create with options", () => {
      const config = makeConfig();
      const mgr = trackManager(new InstanceManager(config));
      const info = mgr.createInstance({
        modelOptions: { reasoningEffort: "high", fastMode: true },
      });

      assert.deepEqual(info.modelOptions, { reasoningEffort: "high", fastMode: true });
    });
  });

  describe("review selection", () => {
    it("preserves the active attached review in getInstance and getChatSummary", async () => {
      const mgr = trackManager(new InstanceManager(makeConfig()));
      const source = mgr.createInstance({ name: "Source Chat" });
      const olderReview = mgr.createInstance({
        name: "Review: older",
        parentSessionId: "source-session",
        review: {
          sourceInstanceId: source.id,
          sourceName: source.name,
          scope: "branch",
        },
      });
      const newerReview = mgr.createInstance({
        name: "Review: newer",
        parentSessionId: "source-session",
        review: {
          sourceInstanceId: source.id,
          sourceName: source.name,
          scope: "branch",
        },
      });

      await mgr.setReviewInstance(source.id, olderReview.id);

      const detail = mgr.getInstance(source.id);
      const summary = mgr.getChatSummary(source.id);
      const listEntry = mgr.listInstances().find((chat) => chat.id === source.id);

      assert.equal(detail?.reviewInstanceId, olderReview.id);
      assert.equal(summary?.reviewInstanceId, olderReview.id);
      assert.equal(listEntry?.reviewInstanceId, olderReview.id);
      assert.notEqual(detail?.reviewInstanceId, newerReview.id);
    });

    it("restores the persisted active attached review from managed runtime payload", () => {
      const config = makeConfig();
      const db = new SessionDB(config.dbPath, noopLogger);
      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "source-1",
            provider_session_id: "source-session",
            working_directory: config.workingDirectory,
            runtime_payload_json: JSON.stringify({
              reviewInstanceId: "review-older",
            }),
          }),
        );
        db.upsertManaged(
          makeManagedRow({
            instance_id: "review-older",
            provider_session_id: "review-session-older",
            name: 'Review the recent changes from "Source Chat".',
            working_directory: config.workingDirectory,
            parent_session_id: "source-session",
            created_at: 1100,
            last_activity_at: 2100,
            runtime_payload_json: JSON.stringify({
              review: {
                sourceInstanceId: "source-1",
                sourceSessionId: "source-session",
                sourceName: "Source Chat",
                scope: "branch",
              },
            }),
          }),
        );
        db.upsertManaged(
          makeManagedRow({
            instance_id: "review-newer",
            provider_session_id: "review-session-newer",
            name: 'Review the recent changes from "Source Chat".',
            working_directory: config.workingDirectory,
            parent_session_id: "source-session",
            created_at: 1200,
            last_activity_at: 2200,
            runtime_payload_json: JSON.stringify({
              review: {
                sourceInstanceId: "source-1",
                sourceSessionId: "source-session",
                sourceName: "Source Chat",
                scope: "branch",
              },
            }),
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(config));
      restored.restoreInstances();

      const detail = restored.getInstance("source-1");
      const summary = restored.getChatSummary("source-1");
      const listEntry = restored.listInstances().find((chat) => chat.id === "source-1");

      assert.equal(detail?.reviewInstanceId, "review-older");
      assert.equal(summary?.reviewInstanceId, "review-older");
      assert.equal(listEntry?.reviewInstanceId, "review-older");
    });

    it("does not infer review metadata from legacy review titles during restore", () => {
      const config = makeConfig();
      const db = new SessionDB(config.dbPath, noopLogger);
      try {
        db.upsertManaged(
          makeManagedRow({
            instance_id: "legacy-review",
            provider_session_id: "legacy-review-session",
            name: 'Review the recent changes from "Source Chat".',
            working_directory: config.workingDirectory,
            parent_session_id: "source-session",
          }),
        );
      } finally {
        db.close();
      }

      const restored = trackManager(new InstanceManager(config));
      restored.restoreInstances();

      const detail = restored.getInstance("legacy-review");
      assert.equal(detail?.review, undefined);
    });
  });

  describe("sendMessage auto-exits plan mode on plan approval", () => {
    it("exits plan mode when sending a message while pendingPlan is set", async () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const runtimeModeSet = [];
      const sentMessages = [];
      instance.process = {
        ...instance.process,
        isProcessing: false,
        provider: "codex",
        pid: undefined,
        stats: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        send(text) {
          sentMessages.push(text);
        },
        interrupt() {},
        close() {},
        setModel() {},

        addAllowedTool() {},
        setRuntimeMode(mode) {
          runtimeModeSet.push(mode);
        },
        getRuntimeBinding() {
          return { provider: "codex" };
        },
        respondToRequest() {
          return false;
        },
      };

      // Simulate plan mode active with a pending plan
      instance.info.runtimeMode = "plan";
      instance.info.pendingPlan = "# The Plan\nDo things";
      instance.info.status = "idle";

      // Send approval message
      await manager.sendMessage(info.id, "Yes, go ahead with this plan.");

      // Should have exited plan mode (set to approval-required, not plan)
      assert.deepEqual(runtimeModeSet, ["approval-required"]);
      assert.equal(instance.info.runtimeMode, "approval-required");
      assert.equal(instance.info.pendingPlan, undefined, "pendingPlan should be cleared");
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0], "Yes, go ahead with this plan.");
    });

    it("preserves plan mode when no pendingPlan is set", async () => {
      const info = manager.createInstance();
      const instance = manager.instances.get(info.id);
      assert.ok(instance);

      const runtimeModeSet = [];
      instance.process = {
        ...instance.process,
        isProcessing: false,
        provider: "codex",
        pid: undefined,
        stats: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        send() {},
        interrupt() {},
        close() {},
        setModel() {},

        addAllowedTool() {},
        setRuntimeMode(mode) {
          runtimeModeSet.push(mode);
        },
        getRuntimeBinding() {
          return { provider: "codex" };
        },
        respondToRequest() {
          return false;
        },
      };

      // Plan mode active but no pending plan (normal message during plan mode)
      instance.info.runtimeMode = "plan";
      instance.info.pendingPlan = undefined;
      instance.info.status = "idle";

      await manager.sendMessage(info.id, "plan this feature");

      // Should stay in plan mode
      assert.deepEqual(runtimeModeSet, []);
      assert.equal(instance.info.runtimeMode, "plan");
    });

    it("does not re-set pendingPlan when ExitPlanMode fires after plan approval", async () => {
      // Regression test: after the user approves a plan and runtimeMode switches to
      // "approval-required", a subsequent ExitPlanMode activity (model presenting
      // another plan phase) must NOT re-open the plan-review panel.
      const fakeProc = new FakeProviderSession("codex");
      manager.createProviderSession = () => fakeProc;

      const info = manager.createInstance({ provider: "codex", runtimeMode: "plan" });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);
      assert.equal(instance.info.runtimeMode, "plan");
      instance.info.status = "idle";

      // Phase 1: model presents first plan via ExitPlanMode while in plan mode
      fakeProc.emit("activity", {
        type: "activity",
        activity: "tool_use",
        tool: "ExitPlanMode",
        description: "Presenting plan",
        input: { plan: "# Plan v1\n- Step A\n- Step B" },
      });
      await manager.flushInstanceMutations();

      assert.equal(instance.info.pendingPlan, "# Plan v1\n- Step A\n- Step B");

      // Phase 2: user approves — clears pendingPlan and switches to approval-required
      await manager.sendMessage(info.id, "Yes, go ahead with this plan.");
      assert.equal(instance.info.pendingPlan, undefined);
      assert.equal(instance.info.runtimeMode, "approval-required");

      // Phase 3: model (still running in plan permissionMode at the CLI level) emits
      // another ExitPlanMode — this must NOT re-show the plan-review panel now that
      // the session is in approval-required mode.
      fakeProc.emit("activity", {
        type: "activity",
        activity: "tool_use",
        tool: "ExitPlanMode",
        description: "Presenting sub-plan",
        input: { plan: "# Plan v2\n- Step C" },
      });
      await manager.flushInstanceMutations();

      assert.equal(
        instance.info.pendingPlan,
        undefined,
        "pendingPlan must not be set after plan was already approved",
      );
      // planContent is still updated so the sidebar can display the latest plan
      assert.equal(instance.info.planContent, "# Plan v2\n- Step C");
    });

    it("does not re-set pendingPlan when ExitPlanMode fires after plan dismissal", async () => {
      // Regression test: dismissing a plan flows through the same dispatchUserMessageLocked
      // path as approval — it clears pendingPlan and flips runtimeMode to
      // "approval-required". A subsequent ExitPlanMode must NOT re-open the panel.
      // Guards against someone later special-casing dismiss separately from accept.
      const fakeProc = new FakeProviderSession("codex");
      manager.createProviderSession = () => fakeProc;

      const info = manager.createInstance({ provider: "codex", runtimeMode: "plan" });
      const instance = manager.instances.get(info.id);
      assert.ok(instance);
      assert.equal(instance.info.runtimeMode, "plan");
      instance.info.status = "idle";

      // Phase 1: model presents a plan via ExitPlanMode while in plan mode
      fakeProc.emit("activity", {
        type: "activity",
        activity: "tool_use",
        tool: "ExitPlanMode",
        description: "Presenting plan",
        input: { plan: "# Plan v1\n- Step A" },
      });
      await manager.flushInstanceMutations();

      assert.equal(instance.info.pendingPlan, "# Plan v1\n- Step A");

      // Phase 2: user dismisses — handleDismissPlan sends this internal message,
      // which clears pendingPlan and exits plan mode.
      await manager.sendMessage(info.id, "Dismiss this plan.", undefined, true);
      assert.equal(instance.info.pendingPlan, undefined);
      assert.equal(instance.info.runtimeMode, "approval-required");

      // Phase 3: a stray ExitPlanMode after dismissal must NOT re-show the panel.
      fakeProc.emit("activity", {
        type: "activity",
        activity: "tool_use",
        tool: "ExitPlanMode",
        description: "Presenting another plan",
        input: { plan: "# Plan v2\n- Step B" },
      });
      await manager.flushInstanceMutations();

      assert.equal(
        instance.info.pendingPlan,
        undefined,
        "pendingPlan must not be set after plan was dismissed",
      );
      assert.equal(instance.info.planContent, "# Plan v2\n- Step B");
    });
  });

  describe("stopAllGracefully", () => {
    it("completes shutdown even if one instance throws on close", async () => {
      const a = manager.createInstance();
      const b = manager.createInstance();
      const internalA = manager.instances.get(a.id);
      const internalB = manager.instances.get(b.id);
      // Force instance A's close to throw; give B a harmless fake process.
      internalA.process = {
        close() {
          throw new Error("boom");
        },
      };
      internalB.process = { close() {} };

      await assert.doesNotReject(() => manager.stopAllGracefully());

      // Cleanup continued past the failing instance.
      assert.equal(internalB.info.status, "stopped");
    });
  });
});
