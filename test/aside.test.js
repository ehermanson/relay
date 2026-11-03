// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Asides ("btw" chats): a read-only fork of a chat's provider session.
 *
 *  (a) createAside forks the source's session (same provider/cwd/account),
 *      read-only, mid-turn at the last completed turn, and never touches the
 *      source; refusals for chats with nothing to fork or for asides
 *  (b) aside messages are wrapped with the aside instructions, the visible
 *      user message stays unwrapped, and no worktree attribution runs
 *  (c) an aside shows only its own turns, not the forked history
 *  (d) removing the source removes its asides; asides stay out of search
 *  (e) drivers: Claude resume+forkSession(+resumeSessionAt), plan mode, denied
 *      approvals; Codex thread/fork with a read-only sandbox
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { AsideUnavailableError, InstanceManager } from "../dist/server/core/instance-manager.js";
import { getProviderDriver } from "../dist/server/core/provider-registry.js";
import {
  buildAsidePrompt,
  isInternalInjectedUserText,
  stripInjectedWrapper,
} from "../dist/server/core/internal-user-messages.js";
import { CodexAppServerSession } from "../dist/server/core/providers/codex-app-server.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

class FakeProviderSession extends EventEmitter {
  constructor(provider = "claude") {
    super();
    this.provider = provider;
    this.isProcessing = false;
    this.pid = undefined;
    this.stats = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    this.sent = [];
    this.forkCursor = undefined;
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
  getForkCursor() {
    return this.forkCursor;
  }
  getRuntimeBinding() {
    return { provider: this.provider };
  }
  respondToRequest() {
    return false;
  }
}

function setup(cleanups) {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-aside-")));
  const claudeDir = join(tempDir, ".claude");
  const projectDir = join(tempDir, "projects", "repo");
  mkdirSync(projectDir, { recursive: true });
  execSync("git init", { cwd: projectDir, stdio: "pipe" });
  const config = resolveConfig({
    password: "test",
    logger: noopLogger,
    maxProcesses: 10,
    dbPath: join(tempDir, "sessions.db"),
    providerDirs: { claude: claudeDir, codex: join(tempDir, ".codex") },
    workingDirectory: projectDir,
  });
  const manager = new InstanceManager(config);
  cleanups.push(() => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });
  manager.projectManager.addProject(projectDir);
  const calls = [];
  const sessions = [];
  manager.createProviderSession = (cfg, options) => {
    calls.push({ config: cfg, options });
    const session = new FakeProviderSession(options?.provider ?? "claude");
    sessions.push(session);
    return session;
  };
  return { manager, calls, sessions, projectDir, claudeDir };
}

/** A source chat that has a provider session to fork. */
function createSource(manager, sessionId = "source-session") {
  const info = manager.createInstance({ provider: "claude" });
  const instance = manager.instances.get(info.id);
  instance.sessionId = sessionId;
  instance.info.sessionId = sessionId;
  return { info, instance };
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

describe("asides", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("forks the source session read-only without touching the source", () => {
    const { manager, calls } = setup(cleanups);
    const { info: source } = createSource(manager);
    const before = JSON.stringify(manager.instances.get(source.id).info);

    const aside = manager.createAside(source.id);
    const call = calls.at(-1);
    assert.deepEqual(call.options.forkFrom, { sessionId: "source-session", cursor: undefined });
    assert.equal(call.options.readOnly, true);
    assert.equal(call.options.provider, "claude");
    assert.equal(aside.workingDirectory, source.workingDirectory);
    assert.equal(aside.aside.sourceInstanceId, source.id);
    assert.equal(aside.aside.sourceSessionId, "source-session");
    assert.equal(typeof aside.aside.forkedAt, "number");
    // parentSessionId marks plan continuations — never set on asides.
    assert.equal(aside.parentSessionId, undefined);
    assert.equal(JSON.stringify(manager.instances.get(source.id).info), before);
  });

  it("mid-turn, forks at the end of the last completed turn", () => {
    const { manager, calls } = setup(cleanups);
    const { info: source, instance } = createSource(manager);
    instance.process.isProcessing = true;
    instance.process.forkCursor = "uuid-end-of-turn-2";
    manager.createAside(source.id);
    assert.equal(calls.at(-1).options.forkFrom.cursor, "uuid-end-of-turn-2");

    // Idle: fork everything on disk, even if a cursor is known.
    instance.process.isProcessing = false;
    manager.createAside(source.id);
    assert.equal(calls.at(-1).options.forkFrom.cursor, undefined);
  });

  it("refuses chats with nothing to fork and asides of asides", () => {
    const { manager } = setup(cleanups);
    const fresh = manager.createInstance({ provider: "claude" });
    assert.throws(() => manager.createAside(fresh.id), AsideUnavailableError);
    const { info: source } = createSource(manager);
    const aside = manager.createAside(source.id);
    assert.throws(() => manager.createAside(aside.id), AsideUnavailableError);
    assert.throws(() => manager.createAside("missing"), AsideUnavailableError);
  });

  it("wraps aside messages for the provider but shows the plain question", async () => {
    const { manager, sessions } = setup(cleanups);
    const { info: source } = createSource(manager);
    const aside = manager.createAside(source.id);
    const userMessages = [];
    manager.on("instance:user", (_id, message) => userMessages.push(message));

    await manager.sendMessage(aside.id, "why is this slow?");
    const sent = sessions.at(-1).sent.at(-1);
    assert.ok(sent.startsWith("<aside>"), sent);
    assert.ok(sent.endsWith("User request:\nwhy is this slow?"));
    assert.equal(manager.instances.get(aside.id).turnWorktreeBaseline, null);
    const history = manager.instances.get(aside.id).history;
    const user = history.find((entry) => entry.message.type === "user");
    assert.equal(user.message.text, "why is this slow?");
    assert.equal(manager.instances.get(aside.id).info.name, "why is this slow?");
  });

  it("re-forks from the source's current state on the first message", async () => {
    const { manager, calls, sessions } = setup(cleanups);
    const { info: source, instance: sourceInstance } = createSource(manager);
    const aside = manager.createAside(source.id);
    const opened = sessions.at(-1);
    const openedAt = manager.instances.get(aside.id).info.aside.forkedAt;

    // The source moves on while the composer is open.
    sourceInstance.process.isProcessing = true;
    sourceInstance.process.forkCursor = "uuid-later";
    await tick(5);
    await manager.sendMessage(aside.id, "first");

    const refork = calls.at(-1).options;
    assert.deepEqual(refork.forkFrom, { sessionId: "source-session", cursor: "uuid-later" });
    assert.equal(refork.readOnly, true);
    const live = manager.instances.get(aside.id);
    assert.notEqual(live.process, opened);
    assert.equal(live.process.sent.at(-1).endsWith("User request:\nfirst"), true);
    assert.ok(live.info.aside.forkedAt >= openedAt);

    // Later messages continue the aside's own session.
    const count = calls.length;
    await manager.sendMessage(aside.id, "second");
    assert.equal(calls.length, count);
  });

  it("opening a new aside discards unused ones but keeps used ones", async () => {
    const { manager } = setup(cleanups);
    const { info: source } = createSource(manager);
    const unused = manager.createAside(source.id);
    const used = manager.createAside(source.id);
    assert.equal(manager.instances.has(unused.id), false);
    await manager.sendMessage(used.id, "hi");
    const next = manager.createAside(source.id);
    assert.equal(manager.instances.has(used.id), true);
    assert.equal(manager.instances.has(next.id), true);
  });

  it("an aside's history hides the turns it forked", () => {
    const { manager, claudeDir, projectDir } = setup(cleanups);
    const { info: source } = createSource(manager);
    const aside = manager.createAside(source.id);
    const forkedAt = aside.aside.forkedAt;
    const dir = join(claudeDir, "projects", projectDir.replace(/[^A-Za-z0-9_-]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "aside-session.jsonl");
    const entry = (uuid, type, text, ts) =>
      JSON.stringify({
        type,
        uuid,
        sessionId: "aside-session",
        cwd: projectDir,
        timestamp: new Date(ts).toISOString(),
        message:
          type === "user"
            ? { role: "user", content: text }
            : { role: "assistant", content: [{ type: "text", text }], model: "claude-x" },
      });
    writeFileSync(
      path,
      [
        entry("u1", "user", "inherited question", forkedAt - 60_000),
        entry("a1", "assistant", "inherited answer", forkedAt - 59_000),
        entry("u2", "user", "the aside question", forkedAt + 1_000),
        entry("a2", "assistant", "the aside answer", forkedAt + 2_000),
      ].join("\n") + "\n",
    );
    const instance = manager.instances.get(aside.id);
    instance.jsonlPath = path;
    const texts = manager
      .getHistory(aside.id)
      .map((e) => e.message.text)
      .filter(Boolean);
    assert.ok(texts.includes("the aside question"), texts.join(" | "));
    assert.ok(texts.includes("the aside answer"));
    assert.ok(!texts.some((t) => t.startsWith("inherited")), texts.join(" | "));
  });

  it("goes with its source and stays out of search", () => {
    const { manager } = setup(cleanups);
    const { info: source } = createSource(manager);
    const aside = manager.createAside(source.id);
    // Persist both with a bound session, as after their first turns.
    manager.dbSave(manager.instances.get(source.id));
    const asideInstance = manager.instances.get(aside.id);
    asideInstance.sessionId = "aside-session";
    asideInstance.info.sessionId = "aside-session";
    manager.dbSave(asideInstance);
    const db = manager.sessionDb;
    db.syncSearchIndexForInstance(source.id);
    db.syncSearchIndexForInstance(aside.id);
    const recent = db.recentChats({ limit: 50 }).map((r) => r.instanceId ?? r.instance_id);
    assert.ok(recent.includes(source.id), "the source chat is indexed");
    assert.ok(!recent.includes(aside.id));

    manager.removeInstance(source.id);
    assert.equal(manager.instances.has(aside.id), false);
  });
});

describe("aside prompt wrapper", () => {
  it("round-trips through the injected-wrapper stripping replay uses", () => {
    const wrapped = buildAsidePrompt("what does X do?");
    assert.equal(isInternalInjectedUserText(wrapped), true);
    assert.equal(stripInjectedWrapper(wrapped), "what does X do?");
  });
});

/** A `query()` stub that records the SDK options and stays silent. */
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

describe("aside provider sessions", () => {
  it("Claude: resume + forkSession at the cursor, default mode, approvals denied", async () => {
    const captured = [];
    const driver = getProviderDriver("claude");
    const session = driver.createSession(
      {
        workingDirectory: "/tmp/project",
        logger: noopLogger,
        providerDirs: { claude: "/tmp/.claude", codex: "/tmp/.codex" },
        defaultRuntimeMode: "approval-required",
      },
      { forkFrom: { sessionId: "src", cursor: "uuid-9" }, readOnly: true },
      { providerDirs: {}, logger: noopLogger, sdkQueryFn: stubSdkQuery(captured) },
    );
    try {
      const options = captured[0];
      assert.equal(options.resume, "src");
      assert.equal(options.forkSession, true);
      assert.equal(options.resumeSessionAt, "uuid-9");
      // Never plan mode: its workflow prompt contradicts the aside instructions.
      assert.equal(options.permissionMode, undefined);
      for (const tool of ["Edit", "Write", "ExitPlanMode", "Agent", "mcp__relay__delegate_task"]) {
        assert.ok(options.disallowedTools.includes(tool), tool);
      }
      const decision = await options.canUseTool(
        "Bash",
        { command: "rm -rf x" },
        {
          signal: new AbortController().signal,
          toolUseID: "t1",
        },
      );
      assert.equal(decision.behavior, "deny");
    } finally {
      session.close();
    }
  });

  it("Codex: thread/fork with lastTurnId and a read-only sandbox", async () => {
    const children = [];
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      codexPath: "codex",
      forkFrom: { sessionId: "source-thread", cursor: "turn-3" },
      readOnly: true,
      spawnProcess() {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.exitCode = null;
        child.killed = false;
        child.kill = () => true;
        child.sent = [];
        child.stdin.on("data", (chunk) => {
          for (const line of chunk.toString().trim().split("\n")) {
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            child.sent.push(msg);
            if (msg.id === undefined || !msg.method) continue;
            const result =
              msg.method === "thread/fork"
                ? { thread: { id: "aside-thread", path: null, turns: [] } }
                : msg.method === "turn/start"
                  ? { turn: { id: "turn-a1", status: "inProgress", items: [] } }
                  : {};
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
          }
        });
        children.push(child);
        return child;
      },
    });
    try {
      session.send("btw?");
      await tick(60);
      const sent = children[0].sent;
      const fork = sent.find((m) => m.method === "thread/fork");
      assert.ok(fork, sent.map((m) => m.method).join(","));
      assert.equal(fork.params.threadId, "source-thread");
      assert.equal(fork.params.lastTurnId, "turn-3");
      assert.equal(fork.params.sandbox, "read-only");
      assert.equal(fork.params.approvalPolicy, "never");
      assert.ok(!sent.some((m) => m.method === "thread/start"));
      assert.equal(session.getRuntimeBinding().providerSessionId, "aside-thread");
      // Read-only can't be escalated away.
      session.setRuntimeMode("full-access");
      session.send("again");
      assert.equal(session.getRuntimeBinding().runtimeMode, "approval-required");
    } finally {
      session.close();
    }
  });
});

describe("aside persistence", () => {
  it("survives the runtime-payload round trip used by save and restore", async () => {
    const { buildPersistedRuntimePayload } =
      await import("../dist/server/core/managed-session-identity.js");
    const { getAsideSessionFromRuntimePayload } =
      await import("../dist/server/core/session-context.js");
    const aside = {
      sourceInstanceId: "src",
      sourceSessionId: "s",
      sourceName: "Chat",
      forkedAt: 5,
    };
    const payload = buildPersistedRuntimePayload({ cwd: "/x" }, { aside });
    assert.deepEqual(getAsideSessionFromRuntimePayload(JSON.parse(JSON.stringify(payload))), aside);
    assert.equal(getAsideSessionFromRuntimePayload({ aside: { sourceName: "no id" } }), undefined);
  });
});
