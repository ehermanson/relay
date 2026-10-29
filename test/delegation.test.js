import "./test-env.js";
/**
 * Relay-delegated tasks (`delegate_task`): child chats, the parent's agent
 * card state, completion wakes, and the stop/done/delete cascades.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import {
  buildTaskWakeMessage,
  lastAssistantText,
  parseRelayAgentMessage,
  resolveChildRuntimeMode,
  TASK_WAKE_RESULT_BUDGET,
  titleFromTask,
} from "../dist/server/core/orchestration/delegation.js";
import { handleMcpPayload } from "../dist/server/core/orchestration/mcp-protocol.js";
import { createRelayMcpServer } from "../dist/server/core/orchestration/tools.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe("delegation rules", () => {
  it("inherits the parent's mode, narrows on request, and never escalates", () => {
    const codexModes = ["approval-required", "writes-only", "full-access"];
    assert.deepEqual(resolveChildRuntimeMode("full-access", undefined, codexModes), {
      ok: true,
      mode: "full-access",
    });
    assert.deepEqual(resolveChildRuntimeMode("full-access", "approval-required", codexModes), {
      ok: true,
      mode: "approval-required",
    });
    assert.equal(
      resolveChildRuntimeMode("approval-required", "full-access", codexModes).code,
      "mode_escalation_denied",
    );
    assert.equal(
      resolveChildRuntimeMode("full-access", "plan", codexModes).code,
      "runtime_mode_unavailable",
    );
    // Claude `auto` isn't a Codex mode: step down to the broadest one within reach.
    assert.deepEqual(resolveChildRuntimeMode("auto", undefined, codexModes), {
      ok: true,
      mode: "writes-only",
    });
    assert.equal(
      resolveChildRuntimeMode("plan", undefined, ["approval-required"]).code,
      "runtime_mode_unavailable",
    );
  });

  it("builds a wake that round-trips to an agent note and respects the budget", () => {
    const base = { parentInstanceId: "p", task: "t", createdAt: 1 };
    const wake = buildTaskWakeMessage([
      {
        ...base,
        id: "t1",
        childInstanceId: "c1",
        title: "Review",
        status: "completed",
        result: "LGTM",
      },
      {
        ...base,
        id: "t2",
        childInstanceId: "c2",
        title: "Port",
        status: "failed",
        statusDetail: "boom",
        result: "x".repeat(TASK_WAKE_RESULT_BUDGET + 1),
      },
    ]);
    assert.match(wake, /relay:\/\/chat\/c1, task t1\) completed/);
    assert.match(wake, /Result:\nLGTM/);
    assert.match(wake, /failed: boom/);
    assert.match(wake, /read it with task_status t2/);
    const parsed = parseRelayAgentMessage(wake);
    assert.equal(parsed.name, "2 delegated tasks");
    assert.ok(parsed.body.startsWith('Delegated task "Review"'));
    assert.equal(parseRelayAgentMessage("hello"), null);
  });

  it("takes the child's trailing reply as the result", () => {
    const history = [
      { message: { type: "user", text: "do it" } },
      { message: { type: "output", text: "Looking." } },
      { message: { type: "activity", activity: "tool_use", tool: "Read" } },
      { message: { type: "output", text: "Part one." } },
      { message: { type: "output", text: "child note", agentId: "a" } },
      { message: { type: "activity", activity: "file_list" } },
      { message: { type: "output", text: "Part two." } },
    ];
    assert.equal(lastAssistantText(history), "Part one.\n\nPart two.");
    assert.equal(lastAssistantText([{ message: { type: "user", text: "x" } }]), undefined);
    assert.equal(titleFromTask("  Fix the parser\nmore"), "Fix the parser");
    assert.ok(titleFromTask("y".repeat(100)).length <= 60);
  });
});

// ---------------------------------------------------------------------------
// InstanceManager
// ---------------------------------------------------------------------------

class FakeProviderSession extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.isProcessing = false;
    this.sent = [];
    this.closed = false;
    this.stats = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }
  send(text) {
    this.sent.push(text);
    this.isProcessing = true;
  }
  interrupt() {}
  close() {
    this.closed = true;
  }
  setModel() {}
  addAllowedTool() {}
  setRuntimeMode() {}
  setSessionId() {}
  getRuntimeBinding() {
    return { provider: this.provider, providerSessionId: `fake-${this.sent.length}` };
  }
  respondToRequest() {
    return false;
  }
}

async function waitFor(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("delegated tasks", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  function setup({ maxProcesses = 6 } = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-delegation-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const manager = new InstanceManager(
      resolveConfig({
        logger: noopLogger,
        maxProcesses,
        dbPath: join(dir, "sessions.db"),
        providerDirs: { claude: join(dir, ".claude"), codex: join(dir, ".codex") },
        workingDirectory: repo,
      }),
    );
    cleanups.unshift(() => {
      try {
        manager.stopAll();
      } catch {
        // already stopped
      }
    });
    const sessions = new Map();
    manager.createProviderSession = (_config, options) => {
      const proc = new FakeProviderSession(options.provider ?? "claude");
      sessions.set(options.instanceId, proc);
      return proc;
    };
    const events = { agentUpdates: [], users: [] };
    manager.on("instance:agent_update", (id, m) => events.agentUpdates.push([id, m.agent]));
    manager.on("instance:user", (id, m) => events.users.push([id, m]));
    const parent = manager.createInstance({
      provider: "claude",
      workingDirectory: repo,
      runtimeMode: "approval-required",
    });
    return { manager, sessions, parent, repo, events };
  }

  async function endTurn(manager, proc, id, text) {
    proc.isProcessing = false;
    if (text) proc.emit("output", { type: "output", text, isWaiting: false });
    proc.emit("output", { type: "output", text: "", isWaiting: true });
    await manager.worktreeReconcileIdle(id);
  }

  it("starts a child, shows it on the parent, and wakes the idle parent with the result", async () => {
    const { manager, sessions, parent, events } = setup();
    const task = await manager.delegateTask(parent.id, {
      task: "Review the diff",
      title: "Review",
      provider: "codex",
    });
    const child = manager.getInstance(task.childInstanceId);
    assert.equal(child.provider, "codex");
    assert.deepEqual(child.delegation, { parentInstanceId: parent.id, taskId: task.id });
    assert.equal(child.runtimeMode, "approval-required");
    assert.deepEqual(sessions.get(child.id).sent, ["Review the diff"]);

    const [updateFor, agent] = events.agentUpdates.at(-1);
    assert.equal(updateFor, parent.id);
    assert.equal(agent.agentId, `relay-task:${task.id}`);
    assert.equal(agent.origin, "relay");
    assert.equal(agent.childInstanceId, child.id);
    assert.equal(agent.childProvider, "codex");
    assert.equal(agent.status, "running");

    await endTurn(manager, sessions.get(child.id), child.id, "All good.");
    assert.equal(manager.getDelegatedTask(task.id).status, "completed");
    assert.equal(manager.getDelegatedTask(task.id).result, "All good.");
    assert.equal(events.agentUpdates.at(-1)[1].status, "completed");

    const parentProc = sessions.get(parent.id);
    await waitFor(() => parentProc.sent.length === 1, "the wake");
    assert.match(parentProc.sent[0], /^\[Relay task update\] Review/);
    const note = events.users.filter(([id]) => id === parent.id).at(-1)[1];
    assert.deepEqual(note.author, { kind: "agent", name: "Review" });
    assert.ok(!note.text.startsWith("[Relay"));
    await waitFor(() => manager.getDelegatedTask(task.id).deliveredAt, "delivery");

    // The child's later, user-driven turns never republish or re-wake.
    await manager.sendMessage(child.id, "one more thing");
    await endTurn(manager, sessions.get(child.id), child.id, "Different answer.");
    assert.equal(manager.getDelegatedTask(task.id).result, "All good.");
  });

  it("queues one wake behind a busy parent and folds later results into it", async () => {
    const { manager, sessions, parent, events } = setup();
    const parentProc = sessions.get(parent.id);
    const a = await manager.delegateTask(parent.id, { task: "A" });
    const b = await manager.delegateTask(parent.id, { task: "B" });
    await manager.sendMessage(parent.id, "keep going");
    assert.equal(parentProc.isProcessing, true);

    await endTurn(manager, sessions.get(a.childInstanceId), a.childInstanceId, "done A");
    await waitFor(() => manager.getInstance(parent.id).queuedMessageCount === 1, "queued wake");
    await endTurn(manager, sessions.get(b.childInstanceId), b.childInstanceId, "done B");
    await waitFor(
      () =>
        events.users.some(
          ([id, m]) => id === parent.id && m.queued && /done A[\s\S]*done B/.test(m.text),
        ),
      "rewritten wake",
    );
    assert.equal(manager.getInstance(parent.id).queuedMessageCount, 1, "never two wakes");
    assert.equal(
      manager.getDelegatedTask(a.id).deliveredAt,
      undefined,
      "not delivered while queued",
    );

    await endTurn(manager, parentProc, parent.id, "ok");
    await waitFor(() => parentProc.sent.length === 2, "the wake after the turn");
    assert.match(parentProc.sent[1], /done A[\s\S]*done B/);
    assert.ok(manager.getDelegatedTask(a.id).deliveredAt);
    assert.ok(manager.getDelegatedTask(b.id).deliveredAt);
  });

  it("anchors the card to the delegate_task call, once per call", async () => {
    const { manager, sessions, parent } = setup();
    const proc = sessions.get(parent.id);
    proc.emit("activity", {
      type: "activity",
      activity: "tool_use",
      tool: "delegate_task",
      toolUseId: "codex-call-1",
      mcp: { serverId: "codex:relay", serverName: "relay", toolName: "delegate_task" },
    });
    proc.emit("activity", {
      type: "activity",
      activity: "tool_use",
      tool: "mcp__relay__delegate_task",
      toolUseId: "claude-call-2",
    });
    const second = await manager.delegateTask(parent.id, { task: "b" });
    const first = await manager.delegateTask(parent.id, { task: "a" });
    const third = await manager.delegateTask(parent.id, { task: "c" });
    assert.equal(second.originToolUseId, "claude-call-2", "the newest unanchored call");
    assert.equal(first.originToolUseId, "codex-call-1");
    assert.equal(third.originToolUseId, undefined, "no call left: the reducer inserts a card");
  });

  it("returns the result inline in wait mode, without a wake", async () => {
    const { manager, sessions, parent } = setup();
    const task = await manager.delegateTask(parent.id, { task: "quick" });
    const waiting = manager.waitForDelegatedTask(task.id, 5000);
    await endTurn(manager, sessions.get(task.childInstanceId), task.childInstanceId, "42");
    const settled = await waiting;
    assert.equal(settled.result, "42");
    assert.ok(settled.deliveredAt, "an inline result counts as delivered");

    const timedOut = await manager.delegateTask(parent.id, { task: "slow" });
    assert.equal((await manager.waitForDelegatedTask(timedOut.id, 20)).status, "running");
  });

  it("refuses escalation, dedupes retries, and serves the child's history", async () => {
    const { manager, parent } = setup();
    await assert.rejects(
      manager.delegateTask(parent.id, { task: "x", runtimeMode: "full-access" }),
      (err) => err.code === "mode_escalation_denied",
    );
    const first = await manager.delegateTask(parent.id, { task: "x", clientRequestId: "r1" });
    const again = await manager.delegateTask(parent.id, { task: "x", clientRequestId: "r1" });
    assert.equal(again.id, first.id);

    const history = await manager.readAgentHistory(parent.id, `relay-task:${first.id}`);
    assert.ok(history.some((e) => e.message.type === "user" && e.message.text === "x"));
    assert.equal(await manager.readAgentHistory("other", `relay-task:${first.id}`), null);
  });

  it("never dispatches a wake into a parent waiting on the user, and re-offers it later", async () => {
    const { manager, sessions, parent } = setup();
    const parentProc = sessions.get(parent.id);
    const task = await manager.delegateTask(parent.id, { task: "x" });
    const live = manager.instances.get(parent.id);
    live.info.pendingPlan = { content: "the plan" };
    await endTurn(manager, sessions.get(task.childInstanceId), task.childInstanceId, "done");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(parentProc.sent, [], "a pending plan is never answered by a wake");
    assert.equal(manager.getDelegatedTask(task.id).deliveredAt, undefined);

    live.info.pendingPlan = undefined;
    await manager.sendMessage(parent.id, "go ahead");
    await endTurn(manager, parentProc, parent.id, "ok");
    await waitFor(() => parentProc.sent.length === 2, "the re-offered wake");
    assert.match(parentProc.sent[1], /^\[Relay task update\]/);
  });

  it("a queued wake never drains into a plan the turn just proposed", async () => {
    const { manager, sessions, parent } = setup();
    const parentProc = sessions.get(parent.id);
    const task = await manager.delegateTask(parent.id, { task: "x" });
    await manager.sendMessage(parent.id, "make a plan");
    await endTurn(manager, sessions.get(task.childInstanceId), task.childInstanceId, "done");
    await waitFor(() => manager.queuedTaskWakes.get(parent.id), "queued wake");
    // The turn ends having proposed a plan (Codex sets this while streaming).
    manager.instances.get(parent.id).info.pendingPlan = "the plan";
    await endTurn(manager, parentProc, parent.id, "Here is the plan.");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(parentProc.sent.length, 1, "only the user's message");
    assert.equal(manager.getInstance(parent.id).pendingPlan, "the plan");
    assert.equal(manager.getDelegatedTask(task.id).deliveredAt, undefined, "still owed");
  });

  it("a wait whose caller hung up leaves the result to the wake", async () => {
    const { manager, sessions, parent } = setup();
    const task = await manager.delegateTask(parent.id, { task: "x" });
    const controller = new AbortController();
    const waiting = manager.waitForDelegatedTask(task.id, 5000, controller.signal);
    controller.abort();
    assert.equal((await waiting).status, "running");
    await endTurn(manager, sessions.get(task.childInstanceId), task.childInstanceId, "late");
    await waitFor(() => sessions.get(parent.id).sent.length === 1, "the wake");
  });

  it("concurrent retries with one clientRequestId start one child", async () => {
    const { manager, parent } = setup();
    const before = manager.listInstances().length;
    const [a, b] = await Promise.all([
      manager.delegateTask(parent.id, { task: "x", clientRequestId: "same" }),
      manager.delegateTask(parent.id, { task: "x", clientRequestId: "same" }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(manager.listInstances().length, before + 1);
  });

  it("a stop that stops nothing cancels nothing", async () => {
    const { manager, parent } = setup();
    const task = await manager.delegateTask(parent.id, { task: "x" });
    manager.instances.get(parent.id).process = null;
    assert.equal(manager.stopInstance(parent.id), false);
    assert.equal(manager.getDelegatedTask(task.id).status, "running");
  });

  it("removing a queued wake dismisses it; an exit that drops the queue keeps it owed", async () => {
    const { manager, sessions, parent } = setup();
    const parentProc = sessions.get(parent.id);
    const a = await manager.delegateTask(parent.id, { task: "A" });
    await manager.sendMessage(parent.id, "busy");
    await endTurn(manager, sessions.get(a.childInstanceId), a.childInstanceId, "done A");
    await waitFor(() => manager.queuedTaskWakes.get(parent.id), "queued wake");
    await manager.removeQueuedMessage(parent.id, manager.queuedTaskWakes.get(parent.id).queuedId);
    assert.ok(manager.getDelegatedTask(a.id).deliveredAt, "dismissed");

    const b = await manager.delegateTask(parent.id, { task: "B" });
    await endTurn(manager, sessions.get(b.childInstanceId), b.childInstanceId, "done B");
    await waitFor(() => manager.queuedTaskWakes.get(parent.id), "second queued wake");
    parentProc.isProcessing = false;
    parentProc.emit("exit", { type: "exit", code: 1 });
    await manager.worktreeReconcileIdle(parent.id);
    assert.equal(manager.queuedTaskWakes.get(parent.id), undefined);
    // An errored parent isn't woken (its transport may be dead); still owed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(manager.getDelegatedTask(b.id).deliveredAt, undefined);
    assert.ok(!parentProc.sent.some((t) => /done B/.test(t)));
    // Its next completed turn re-offers it.
    await manager.sendMessage(parent.id, "recovered?");
    await endTurn(manager, parentProc, parent.id, "yes");
    await waitFor(() => parentProc.sent.some((t) => /done B/.test(t)), "re-offered wake");
  });

  it("restart recovery fails tasks whose child will never finish", async () => {
    const { manager, parent } = setup();
    const gone = await manager.delegateTask(parent.id, { task: "gone" });
    const idle = await manager.delegateTask(parent.id, { task: "idle" });
    const continued = await manager.delegateTask(parent.id, { task: "continued" });
    manager.instances.delete(gone.childInstanceId);
    manager.instances.get(idle.childInstanceId).process = null;
    manager.instances.get(continued.childInstanceId).process = null;
    manager.restartContinuedIds = new Set([continued.childInstanceId]);
    manager.recoverDelegatedTasks();
    assert.equal(manager.getDelegatedTask(gone.id).status, "failed");
    assert.equal(manager.getDelegatedTask(idle.id).status, "failed");
    assert.match(manager.getDelegatedTask(idle.id).statusDetail, /restart/);
    assert.equal(manager.getDelegatedTask(continued.id).status, "running");
  });

  it("reports capacity as a typed failure", async () => {
    const { manager, parent } = setup({ maxProcesses: 1 });
    await assert.rejects(
      manager.delegateTask(parent.id, { task: "x" }),
      (err) => err.code === "capacity",
    );
  });

  it("marking the parent done cancels its children, depth first, without waking it", async () => {
    const { manager, sessions, parent } = setup();
    const child = await manager.delegateTask(parent.id, { task: "child" });
    const grandchild = await manager.delegateTask(child.childInstanceId, { task: "grandchild" });

    await manager.setInstanceDone(parent.id, true);
    for (const task of [child, grandchild]) {
      const current = manager.getDelegatedTask(task.id);
      assert.equal(current.status, "cancelled");
      assert.ok(current.deliveredAt, "dropped, not owed");
      assert.equal(sessions.get(task.childInstanceId).closed, true);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(sessions.get(parent.id).sent, [], "a done parent is never woken");
  });

  it("a user stopping the child from its card still tells the parent", async () => {
    const { manager, sessions, parent } = setup();
    const task = await manager.delegateTask(parent.id, { task: "x" });
    manager.cancelDelegatedTask(task.id, "stopped by the user", { notifyParent: true });
    assert.equal(manager.getDelegatedTask(task.id).status, "cancelled");
    const parentProc = sessions.get(parent.id);
    await waitFor(() => parentProc.sent.length === 1, "the cancel wake");
    assert.match(parentProc.sent[0], /was cancelled: stopped by the user/);
  });

  it("deleting the parent deletes its children recursively", async () => {
    const { manager, parent } = setup();
    const child = await manager.delegateTask(parent.id, { task: "child" });
    const grandchild = await manager.delegateTask(child.childInstanceId, { task: "grandchild" });
    manager.removeInstance(parent.id);
    assert.ok(!manager.getInstance(child.childInstanceId));
    assert.ok(!manager.getInstance(grandchild.childInstanceId));
    assert.equal(manager.getDelegatedTask(child.id), undefined);
  });

  it("replays task cards and wake notes into the parent's history", async () => {
    const { manager, parent } = setup();
    const task = await manager.delegateTask(parent.id, { task: "x", title: "Probe" });
    const wake = buildTaskWakeMessage([
      { ...manager.getDelegatedTask(task.id), status: "completed", result: "r" },
    ]);
    const merged = manager.mergeSessionEvents(parent.id, [
      { timestamp: task.createdAt - 10, message: { type: "user", text: "please delegate" } },
      { timestamp: task.createdAt + 10, message: { type: "user", text: wake } },
    ]);
    assert.deepEqual(
      merged.map((e) => e.message.type),
      ["user", "agent_update", "user"],
    );
    assert.equal(merged[1].message.agent.origin, "relay");
    assert.deepEqual(merged[2].message.author, { kind: "agent", name: "Probe" });
  });

  it("serves the tools over MCP for the calling chat", async () => {
    const { manager, sessions, parent } = setup();
    const server = createRelayMcpServer("test");
    const ctx = { host: manager.getOrchestrationHost(), callerId: parent.id };
    const call = async (name, args) => {
      const response = await handleMcpPayload(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        server,
        ctx,
      );
      return response.result;
    };
    const started = await call("delegate_task", {
      task: "Summarize",
      target: { provider: "codex" },
    });
    assert.equal(started.isError, undefined);
    assert.equal(started.structuredContent.status, "running");
    assert.match(started.structuredContent.next, /end your turn/);
    const taskId = started.structuredContent.taskId;
    assert.equal(started.structuredContent.chat.delegatedBy, `relay://chat/${parent.id}`);

    const childId = started.structuredContent.chat.id;
    await endTurn(manager, sessions.get(childId), childId, "Summary.");
    const status = await call("task_status", { taskId });
    assert.equal(status.structuredContent.status, "completed");
    assert.equal(status.structuredContent.result, "Summary.");

    const other = await call("task_status", { taskId: "nope" });
    assert.equal(other.structuredContent.error.code, "task_not_found");

    const childCtx = { host: ctx.host, callerId: childId };
    const notOwner = await handleMcpPayload(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "task_cancel", arguments: { taskId } },
      },
      server,
      childCtx,
    );
    assert.equal(notOwner.result.structuredContent.error.code, "not_task_owner");
  });

  function mcpCaller(manager, callerId) {
    const server = createRelayMcpServer("test");
    const ctx = { host: manager.getOrchestrationHost(), callerId };
    return async (name, args, signal) => {
      const response = await handleMcpPayload(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        server,
        { ...ctx, signal },
      );
      return response.result.structuredContent;
    };
  }

  it("chat_send delivers an agent note to an idle chat; chat_wait returns its reply", async () => {
    const { manager, sessions, parent, repo, events } = setup();
    const other = manager.createInstance({
      provider: "codex",
      workingDirectory: repo,
      runtimeMode: "approval-required",
    });
    const call = mcpCaller(manager, parent.id);
    const sent = await call("chat_send", {
      chatId: `relay://chat/${other.id}`,
      message: "Which tests cover the parser?",
    });
    assert.equal(sent.sent, true);
    const proc = sessions.get(other.id);
    assert.equal(proc.sent.length, 1);
    assert.match(proc.sent[0], /^\[Relay message\] /);
    assert.match(proc.sent[0], new RegExp(`relay://chat/${parent.id}`));
    assert.match(proc.sent[0], /Which tests cover the parser\?$/);
    const note = events.users.find(([id, m]) => id === other.id && !m.queued);
    assert.equal(note[1].author?.kind, "agent");
    assert.equal(note[1].text.includes("[Relay message]"), false);

    const waiting = call("chat_wait", { chatId: other.id, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await endTurn(manager, proc, other.id, "parser.test.js");
    const result = await waiting;
    assert.equal(result.outcome, "finished");
    assert.equal(result.lastReply, "parser.test.js");

    // Replay re-attributes it like a wake.
    const merged = manager.mergeSessionEvents(other.id, [
      { timestamp: 1, message: { type: "user", text: proc.sent[0] } },
    ]);
    assert.equal(merged[0].message.author?.kind, "agent");
  });

  it("chat_send refuses busy, waiting, broader, self and unknown targets", async () => {
    const { manager, sessions, parent, repo } = setup();
    const call = mcpCaller(manager, parent.id);
    const broader = manager.createInstance({
      provider: "claude",
      workingDirectory: repo,
      runtimeMode: "full-access",
    });
    const refused = await call("chat_send", { chatId: broader.id, message: "x" });
    assert.equal(refused.error.code, "mode_escalation_denied");
    assert.equal(sessions.get(broader.id).sent.length, 0);

    const peer = manager.createInstance({
      provider: "claude",
      workingDirectory: repo,
      runtimeMode: "plan",
    });
    await call("chat_send", { chatId: peer.id, message: "first" });
    assert.equal(
      (await call("chat_send", { chatId: peer.id, message: "x" })).error.code,
      "chat_busy",
    );
    await endTurn(manager, sessions.get(peer.id), peer.id, "ok");
    manager.instances.get(peer.id).info.pendingPlan = "a plan";
    assert.equal(
      (await call("chat_send", { chatId: peer.id, message: "x" })).error.code,
      "chat_needs_input",
    );
    assert.equal(sessions.get(peer.id).sent.length, 1);

    assert.equal(
      (await call("chat_send", { chatId: parent.id, message: "x" })).error.code,
      "chat_not_sendable",
    );
    assert.equal(
      (await call("chat_send", { chatId: "nope", message: "x" })).error.code,
      "chat_not_found",
    );
  });

  it("chat_wait settles at once, on input needed, on timeout and on hang-up", async () => {
    const { manager, sessions, parent, repo } = setup();
    const call = mcpCaller(manager, parent.id);
    const other = manager.createInstance({
      provider: "claude",
      workingDirectory: repo,
      runtimeMode: "approval-required",
    });
    assert.equal((await call("chat_wait", { chatId: other.id })).outcome, "finished");

    await manager.sendMessage(other.id, "go");
    const timedOut = await call("chat_wait", { chatId: other.id, timeoutMs: 1000 });
    assert.equal(timedOut.outcome, "timeout");
    assert.equal(timedOut.lastReply, undefined);

    const controller = new AbortController();
    const hungUp = call("chat_wait", { chatId: other.id }, controller.signal);
    controller.abort();
    assert.equal((await hungUp).outcome, "timeout");

    const waiting = call("chat_wait", { chatId: other.id, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const live = manager.instances.get(other.id);
    sessions.get(other.id).isProcessing = false;
    live.info.pendingPermission = { requestId: "r", toolName: "Bash", input: {} };
    manager.emitInstanceStatus(live);
    assert.equal((await waiting).outcome, "needs_input");
  });

  it("chat_send never revives a done chat, never reaches external ones, and never names the chat", async () => {
    const { manager, sessions, parent, repo } = setup();
    const call = mcpCaller(manager, parent.id);
    const fresh = manager.createInstance({
      provider: "claude",
      workingDirectory: repo,
      runtimeMode: "approval-required",
    });
    const before = manager.getInstance(fresh.id).name;
    await call("chat_send", { chatId: fresh.id, message: "hello" });
    assert.equal(
      manager.getInstance(fresh.id).name,
      before,
      "an agent note doesn't title the chat",
    );
    await endTurn(manager, sessions.get(fresh.id), fresh.id, "hi");
    await manager.sendMessage(fresh.id, "Fix the flaky parser test");
    assert.match(manager.getInstance(fresh.id).name, /flaky parser/);
    await endTurn(manager, sessions.get(fresh.id), fresh.id, "ok");

    await manager.setInstanceDone(fresh.id, true);
    const done = await call("chat_send", { chatId: fresh.id, message: "x" });
    assert.equal(done.error.code, "chat_not_sendable");

    const external = manager.createInstance({ provider: "claude", workingDirectory: repo });
    manager.instances.get(external.id).info.external = true;
    assert.equal(
      (await call("chat_send", { chatId: external.id, message: "x" })).error.code,
      "chat_not_sendable",
    );
  });

  it("chat_wait reports a failed turn and a deleted chat", async () => {
    const { manager, sessions, parent, repo } = setup();
    const call = mcpCaller(manager, parent.id);
    const other = manager.createInstance({ provider: "claude", workingDirectory: repo });
    await manager.sendMessage(other.id, "go");
    const failing = call("chat_wait", { chatId: other.id, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const proc = sessions.get(other.id);
    proc.isProcessing = false;
    proc.emit("exit", { type: "exit", code: 1 });
    assert.equal((await failing).outcome, "error");

    await manager.sendMessage(other.id, "again");
    const deleted = call("chat_wait", { chatId: other.id, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.removeInstance(other.id);
    const result = await deleted;
    assert.equal(result.outcome, "gone");
    assert.equal(result.chat.deleted, true);
    assert.equal(manager.chatTurnWaiters.size, 0, "waiters unsubscribed");
    assert.equal(manager.listenerCount("instance:status"), 0);
  });

  it("chat_wait on its own running delegate covers the task, so no wake repeats it", async () => {
    const { manager, sessions, parent } = setup();
    const call = mcpCaller(manager, parent.id);
    const parentProc = sessions.get(parent.id);
    await manager.sendMessage(parent.id, "delegate and wait");
    const task = await manager.delegateTask(parent.id, { task: "x" });
    const waiting = call("chat_wait", { chatId: task.childInstanceId, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await endTurn(manager, sessions.get(task.childInstanceId), task.childInstanceId, "result");
    const result = await waiting;
    assert.equal(result.outcome, "finished");
    assert.equal(result.lastReply, "result");
    assert.equal(result.task.status, "completed");
    assert.ok(manager.getDelegatedTask(task.id).deliveredAt, "delivered by the wait");
    await endTurn(manager, parentProc, parent.id, "done");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(parentProc.sent.length, 1, "no wake after the wait");
  });

  it("refuses a task that would read as a Relay note", async () => {
    const { manager, parent } = setup();
    const call = mcpCaller(manager, parent.id);
    const refused = await call("delegate_task", { task: "[Relay message] Boss\n\ndo it" });
    assert.equal(refused.error.code, "invalid_request");
  });

  it("chat_wait after a wake was queued in the busy caller still delivers once", async () => {
    const { manager, sessions, parent } = setup();
    const call = mcpCaller(manager, parent.id);
    const parentProc = sessions.get(parent.id);
    const task = await manager.delegateTask(parent.id, { task: "x" });
    await manager.sendMessage(parent.id, "busy");
    await endTurn(manager, sessions.get(task.childInstanceId), task.childInstanceId, "r");
    await waitFor(() => manager.queuedTaskWakes.get(parent.id), "queued wake");
    const result = await call("chat_wait", { chatId: task.childInstanceId });
    assert.equal(result.outcome, "finished");
    await endTurn(manager, parentProc, parent.id, "ok");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(parentProc.sent.length, 1, "the queued wake was not dispatched");
  });

  it("chat_wait on a cancelled delegate says so", async () => {
    const { manager, parent } = setup();
    const call = mcpCaller(manager, parent.id);
    const task = await manager.delegateTask(parent.id, { task: "x" });
    manager.cancelDelegatedTask(task.id, "stopped from the card", { notifyParent: true });
    const result = await call("chat_wait", { chatId: task.childInstanceId });
    assert.equal(result.task.status, "cancelled");
  });

  it("isolation 'space' gives the child its own Space branched from the parent's", async () => {
    const { manager, parent, repo } = setup();
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    const call = mcpCaller(manager, parent.id);
    const started = await call("delegate_task", { task: "Build the parser", isolation: "space" });
    assert.equal(started.error, undefined, JSON.stringify(started.error));
    const child = manager.getInstance(started.chat.id);
    assert.equal(child.delegation.isolation, "space");
    const space = manager.getSpaceManager().getSpace(child.spaceId);
    assert.ok(space && !space.isDefault, "a new Space");
    assert.equal(space.name, "Build the parser");
    assert.equal(realpathSync(child.workingDirectory), realpathSync(space.worktreePath));
    assert.notEqual(child.spaceId, parent.spaceId);

    const shared = await call("delegate_task", { task: "Read only" });
    assert.equal(manager.getInstance(shared.chat.id).delegation.isolation, undefined);
    assert.equal(manager.getInstance(shared.chat.id).spaceId, parent.spaceId);

    const bad = await call("delegate_task", { task: "x", isolation: "elsewhere" });
    assert.equal(bad.error.code, "invalid_request");
  });

  it("concurrent retries share one isolated attempt", async () => {
    const { manager, parent, repo } = setup();
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    const request = { task: "x", isolation: "space", clientRequestId: "once" };
    const [a, b] = await Promise.all([
      manager.delegateTask(parent.id, request),
      manager.delegateTask(parent.id, request),
    ]);
    assert.equal(a.id, b.id);
    const spaces = manager
      .getSpaceManager()
      .listSpaces(
        manager.getSpaceManager().getSpace(manager.getInstance(a.childInstanceId).spaceId)
          .projectDirectory,
      )
      .filter((space) => !space.isDefault);
    assert.equal(spaces.length, 1);
  });

  function commitAll(repo) {
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
  }

  it("isolation 'space' refuses Space parents, non-git chats, and leaves nothing at the cap", async () => {
    const { manager, parent, repo } = setup({ maxProcesses: 1 });
    commitAll(repo);
    const spaces = manager.getSpaceManager();
    const capped = await manager
      .delegateTask(parent.id, { task: "x", isolation: "space" })
      .catch((err) => err);
    assert.equal(capped.code, "capacity");
    assert.deepEqual(
      spaces.listAllSpaces(repo).filter((space) => !space.isDefault),
      [],
      "no worktree built, nothing archived",
    );

    const parentSpace = await spaces.createSpace(repo, { name: "parent work" });
    manager.instances.get(parent.id).info.spaceId = parentSpace.id;
    manager.resolveMaxProcesses = () => 10;
    const fromSpace = await manager
      .delegateTask(parent.id, { task: "x", isolation: "space" })
      .catch((err) => err);
    assert.equal(fromSpace.code, "space_unavailable");
  });

  it("discards an isolated child's Space when the child can't start", async () => {
    const { manager, parent, repo } = setup();
    commitAll(repo);
    const original = manager.createInstance.bind(manager);
    manager.createInstance = (options) => {
      if (options.delegation) throw new Error("boom");
      return original(options);
    };
    await assert.rejects(
      manager.delegateTask(parent.id, { task: "x", isolation: "space" }),
      /boom/,
    );
    await waitFor(
      () =>
        manager
          .getSpaceManager()
          .listAllSpaces(repo)
          .every((space) => space.isDefault),
      "the unused Space removed",
    );
  });

  it("keeps a child's isolation through restore", async () => {
    const { getDelegationFromRuntimePayload } =
      await import("../dist/server/core/session-context.js");
    assert.deepEqual(
      getDelegationFromRuntimePayload({
        delegation: { parentInstanceId: "p", taskId: "t", isolation: "space" },
      }),
      { parentInstanceId: "p", taskId: "t", isolation: "space" },
    );
    assert.equal(
      getDelegationFromRuntimePayload({
        delegation: { parentInstanceId: "p", taskId: "t", isolation: "nope" },
      }).isolation,
      undefined,
    );
  });
});
