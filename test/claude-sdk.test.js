// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSdkSession,
  createSdkSessionSync,
} from "../dist/server/core/providers/claude-sdk.js";

// =============================================================================
// FakeQuery — mirrors the SDK's Query async generator + control methods
// =============================================================================

class FakeQuery {
  constructor() {
    this.queue = [];
    this.resolvers = [];
    this.done = false;
    this.interruptCalls = 0;
    this.setPermissionModeCalls = [];
    this.setModelCalls = [];
    this.closeCalls = 0;
    this.usageSnapshot = null;
  }

  emit(message) {
    if (this.done) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ done: false, value: message });
    } else {
      this.queue.push(message);
    }
  }

  finish() {
    if (this.done) return;
    this.done = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ done: true, value: undefined });
    }
  }

  async interrupt() {
    this.interruptCalls++;
  }

  async setPermissionMode(mode) {
    this.setPermissionModeCalls.push(mode);
  }

  async setModel(model) {
    this.setModelCalls.push(model);
  }

  async accountInfo() {
    return { planType: "unknown" };
  }

  async getContextUsage() {
    return { used: 0, remaining: 0, total: 0 };
  }

  async supportedModels() {
    return [];
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
    return this.usageSnapshot;
  }

  async applyFlagSettings(_settings) {}

  close() {
    this.closeCalls++;
    this.finish();
  }

  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next() {
        const queued = self.queue.shift();
        if (queued) return Promise.resolve({ done: false, value: queued });
        if (self.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          self.resolvers.push(resolve);
        });
      },
    };
  }
}

// =============================================================================
// Helpers
// =============================================================================

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeHarness() {
  const fakeQuery = new FakeQuery();
  /** @type {any} */
  let capturedPrompt;

  const queryFn = ({ prompt, options: _options }) => {
    capturedPrompt = prompt;
    return fakeQuery;
  };

  return {
    fakeQuery,
    queryFn,
    getCapturedPrompt: () => capturedPrompt,
  };
}

async function createTestSession(harness, overrides = {}) {
  return createSdkSession({
    cwd: "/test/project",
    logger: noopLogger,
    queryFn: harness.queryFn,
    ...overrides,
  });
}

/** Collect events of a given type from the session */
function collectEvents(session, eventName) {
  const events = [];
  session.on(eventName, (...args) => events.push(args));
  return events;
}

/** Wait for a short time to let async operations settle */
function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Tests
// =============================================================================

describe("ClaudeSdkSession", () => {
  describe("creation", () => {
    it("creates a session with injected queryFn", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      assert.ok(session);
      assert.equal(session.isProcessing, false);
      assert.equal(session.pid, undefined);
      assert.equal(session.sessionId, undefined);
      session.close();
    });

    it("passes cwd and model to SDK options", async () => {
      let capturedOptions;
      const fakeQuery = new FakeQuery();
      const session = await createSdkSession({
        cwd: "/my/project",
        model: "claude-opus-4-6",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          capturedOptions = options;
          return fakeQuery;
        },
      });
      assert.equal(capturedOptions.cwd, "/my/project");
      assert.equal(capturedOptions.model, "claude-opus-4-6");
      assert.equal(capturedOptions.includePartialMessages, true);
      session.close();
    });

    it("passes resume option when resumeSessionId is set", async () => {
      let capturedOptions;
      const fakeQuery = new FakeQuery();
      const session = await createSdkSession({
        cwd: "/test",
        resumeSessionId: "abc-123",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          capturedOptions = options;
          return fakeQuery;
        },
      });
      assert.equal(capturedOptions.resume, "abc-123");
      session.close();
    });

    it("always sets canUseTool for runtime toggle support", async () => {
      let capturedOptions;
      const fakeQuery = new FakeQuery();
      const session = await createSdkSession({
        cwd: "/test",
        runtimeMode: "full-access",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          capturedOptions = options;
          return fakeQuery;
        },
      });
      // canUseTool is always set (auto-approves when bypass is on)
      assert.ok(typeof capturedOptions.canUseTool === "function");
      assert.equal(capturedOptions.permissionMode, "bypassPermissions");
      session.close();
    });

    it("passes plan permission mode when runtimeMode is 'plan'", async () => {
      let capturedOptions;
      const fakeQuery = new FakeQuery();
      const session = await createSdkSession({
        cwd: "/test",
        runtimeMode: "plan",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          capturedOptions = options;
          return fakeQuery;
        },
      });
      assert.equal(capturedOptions.permissionMode, "plan");
      session.close();
    });

    it("passes auto permission mode when runtimeMode is 'auto'", async () => {
      let capturedOptions;
      const fakeQuery = new FakeQuery();
      const session = await createSdkSession({
        cwd: "/test",
        runtimeMode: "auto",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          capturedOptions = options;
          return fakeQuery;
        },
      });
      assert.equal(capturedOptions.permissionMode, "auto");
      session.close();
    });

    it("sets canUseTool when runtimeMode defaults to approval-required", async () => {
      let capturedOptions;
      const fakeQuery = new FakeQuery();
      const session = await createSdkSession({
        cwd: "/test",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          capturedOptions = options;
          return fakeQuery;
        },
      });
      assert.ok(typeof capturedOptions.canUseTool === "function");
      session.close();
    });

    it("passes pre-approved allowedTools", async () => {
      let capturedOptions;
      const fakeQuery = new FakeQuery();
      const session = await createSdkSession({
        cwd: "/test",
        allowedTools: ["Bash", "Edit"],
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          capturedOptions = options;
          return fakeQuery;
        },
      });
      assert.deepEqual(capturedOptions.allowedTools, ["Bash", "Edit"]);
      session.close();
    });

    it("passes bootstrap context through the Claude system prompt", async () => {
      let capturedOptions;
      const fakeQuery = new FakeQuery();
      const session = await createSdkSession({
        cwd: "/test",
        logger: noopLogger,
        bootstrapContext: {
          blocks: [],
          baseInstructions: "Base relay policy",
          developerInstructions: "Developer relay policy",
        },
        queryFn: ({ _prompt, options }) => {
          capturedOptions = options;
          return fakeQuery;
        },
      });
      assert.deepEqual(capturedOptions.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "Base relay policy\n\nDeveloper relay policy",
      });
      session.close();
    });
  });

  describe("send()", () => {
    it("pushes a user message to the prompt queue", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);

      session.send("Hello Claude");
      assert.equal(session.isProcessing, true);

      // Read from the prompt queue
      const prompt = harness.getCapturedPrompt();
      const iter = prompt[Symbol.asyncIterator]();
      const { value } = await iter.next();
      assert.equal(value.type, "user");
      assert.equal(value.message.content[0].text, "Hello Claude");

      session.close();
    });

    it("rejects sends while processing", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);

      session.send("First");
      assert.equal(session.isProcessing, true);

      // Second send should be ignored
      session.send("Second");
      // Still processing from first
      assert.equal(session.isProcessing, true);

      session.close();
    });
  });

  describe("stream handling", () => {
    it("captures session ID from system init", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);

      harness.fakeQuery.emit({
        type: "system",
        subtype: "init",
        session_id: "sess-abc-123",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: ["Read", "Write"],
      });

      await tick();
      assert.equal(session.sessionId, "sess-abc-123");
      session.close();
    });

    it("emits a session_init system event from Claude init messages", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const systemEvents = collectEvents(session, "systemEvent");

      harness.fakeQuery.emit({
        type: "system",
        subtype: "init",
        session_id: "sess-init-1",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: ["Read", "Write"],
      });

      await tick();
      assert.equal(systemEvents.length, 1);
      assert.equal(systemEvents[0][0].type, "system_event");
      assert.equal(systemEvents[0][0].event, "session_init");
      assert.equal(systemEvents[0][0].payload.sessionId, "sess-init-1");
      assert.deepEqual(systemEvents[0][0].payload.tools, ["Read", "Write"]);
      session.close();
    });

    it("emits a compact boundary system event from Claude compact_boundary messages", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const systemEvents = collectEvents(session, "systemEvent");

      harness.fakeQuery.emit({
        type: "system",
        subtype: "init",
        session_id: "sess-compact-1",
        model: "claude-sonnet-4-6",
        cwd: "/test",
        tools: ["Read", "Write"],
      });
      harness.fakeQuery.emit({
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess-compact-1",
      });

      await tick();
      const compactEvent = systemEvents
        .map(([event]) => event)
        .find((event) => event.event === "compact_boundary");
      assert.ok(compactEvent);
      assert.equal(compactEvent.type, "system_event");
      assert.equal(compactEvent.event, "compact_boundary");
      assert.equal(compactEvent.payload.sessionId, "sess-compact-1");
      session.close();
    });

    it("emits provider status from the experimental usage snapshot", async () => {
      const harness = makeHarness();
      harness.fakeQuery.usageSnapshot = {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 42,
            resets_at: "2026-06-09T21:30:00.000Z",
          },
          seven_day_sonnet: {
            utilization: 75.5,
            resets_at: "2026-06-15T12:00:00.000Z",
          },
        },
      };
      const session = createSdkSessionSync(
        {
          cwd: "/test/project",
          logger: noopLogger,
        },
        harness.queryFn,
      );
      const systemEvents = collectEvents(session, "systemEvent");

      await tick();

      const providerStatus = systemEvents
        .map(([event]) => event)
        .find((event) => event.event === "provider_status");
      assert.ok(providerStatus, "Expected provider_status from usage snapshot");

      const rateLimits = providerStatus.payload.account.rateLimits;
      assert.equal(rateLimits.length, 2);
      assert.equal(rateLimits[0].scope, "five_hour");
      assert.equal(rateLimits[0].windows[0].usedPercent, 42);
      assert.equal(rateLimits[0].windows[0].remaining, 58);
      assert.equal(rateLimits[0].windows[0].windowMinutes, 300);
      assert.equal(rateLimits[0].windows[0].resetAt, "2026-06-09T21:30:00.000Z");
      assert.equal(rateLimits[1].scope, "seven_day_sonnet");
      assert.equal(rateLimits[1].windows[0].usedPercent, 75.5);
      assert.equal(rateLimits[1].windows[0].remaining, 25);
      assert.equal(rateLimits[1].windows[0].windowMinutes, 10080);

      assert.deepEqual(session.getRateLimitSnapshot(), rateLimits);
      session.close();
    });

    it("surfaces per-model weekly windows from the model_scoped snapshot array", async () => {
      const harness = makeHarness();
      harness.fakeQuery.usageSnapshot = {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 10,
            resets_at: "2026-06-09T21:30:00.000Z",
          },
          model_scoped: [
            { display_name: "Fable", utilization: 60, resets_at: "2026-06-15T12:00:00.000Z" },
            // null utilization / null resets_at must degrade gracefully, not throw.
            { display_name: "Claude Sonnet 4.5", utilization: null, resets_at: null },
            // Malformed entries are dropped: empty name, missing name, non-object.
            { display_name: "", utilization: 5, resets_at: "2026-06-15T12:00:00.000Z" },
            { utilization: 5, resets_at: "2026-06-15T12:00:00.000Z" },
            null,
          ],
        },
      };
      const session = createSdkSessionSync(
        {
          cwd: "/test/project",
          logger: noopLogger,
        },
        harness.queryFn,
      );
      const systemEvents = collectEvents(session, "systemEvent");

      await tick();

      const providerStatus = systemEvents
        .map(([event]) => event)
        .find((event) => event.event === "provider_status");
      assert.ok(providerStatus, "Expected provider_status from usage snapshot");
      const rateLimits = providerStatus.payload.account.rateLimits;

      // five_hour + two valid model_scoped entries; three malformed ones dropped.
      assert.equal(rateLimits.length, 3);

      const fable = rateLimits.find((l) => l.scope === "model_scoped/Fable");
      assert.ok(fable, "Expected a model_scoped/Fable window");
      // name is the bare display name so the UI renders it as the qualifier ("Weekly · Fable").
      assert.equal(fable.name, "Fable");
      assert.equal(fable.windows[0].usedPercent, 60);
      assert.equal(fable.windows[0].remaining, 40);
      assert.equal(fable.windows[0].windowMinutes, 10080);
      assert.equal(fable.windows[0].resetAt, "2026-06-15T12:00:00.000Z");

      const sonnet = rateLimits.find((l) => l.scope === "model_scoped/Claude Sonnet 4.5");
      assert.ok(sonnet, "Expected a model_scoped/Claude Sonnet 4.5 window");
      assert.equal(sonnet.name, "Claude Sonnet 4.5");
      // null utilization / resets_at → undefined fields, but still a weekly window.
      assert.equal(sonnet.windows[0].usedPercent, undefined);
      assert.equal(sonnet.windows[0].remaining, undefined);
      assert.equal(sonnet.windows[0].resetAt, undefined);
      assert.equal(sonnet.windows[0].windowMinutes, 10080);

      session.close();
    });

    it("preserves snapshot utilization when an allowed event carries none", async () => {
      const harness = makeHarness();
      harness.fakeQuery.usageSnapshot = {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 42,
            resets_at: "2026-06-09T21:30:00.000Z",
          },
        },
      };
      const session = createSdkSessionSync(
        { cwd: "/test/project", logger: noopLogger },
        harness.queryFn,
      );
      const systemEvents = collectEvents(session, "systemEvent");

      await tick();

      // Live `allowed` events carry no utilization — must not wipe the 42%.
      harness.fakeQuery.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          status: "allowed",
          resetsAt: 1781200000,
        },
      });

      await tick();

      const statuses = systemEvents
        .map(([event]) => event)
        .filter((event) => event.event === "provider_status");
      assert.ok(statuses.length >= 2, "Expected snapshot + event provider_status");
      const last = statuses[statuses.length - 1];
      const fiveHour = last.payload.account.rateLimits.find((l) => l.scope === "five_hour");
      assert.ok(fiveHour);
      assert.equal(fiveHour.windows[0].usedPercent, 42);
      assert.equal(fiveHour.windows[0].status, "allowed");
      assert.equal(fiveHour.windows[0].resetAt, new Date(1781200000 * 1000).toISOString());
      session.close();
    });

    it("snapshot fills utilization and clears stale rejected on event-occupied windows", async () => {
      const harness = makeHarness();
      // Defer the snapshot so the live event lands first (the real-world
      // ordering: the CLI replays cached rate-limit status at session start).
      let resolveSnapshot;
      harness.fakeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        });
      const session = createSdkSessionSync(
        { cwd: "/test/project", logger: noopLogger },
        harness.queryFn,
      );
      const systemEvents = collectEvents(session, "systemEvent");

      harness.fakeQuery.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          status: "rejected",
          resetsAt: 1781200000,
        },
      });
      await tick();

      resolveSnapshot({
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 42,
            resets_at: "2026-06-09T21:30:00.000Z",
          },
        },
      });
      await tick();

      const statuses = systemEvents
        .map(([event]) => event)
        .filter((event) => event.event === "provider_status");
      const last = statuses[statuses.length - 1];
      const fiveHour = last.payload.account.rateLimits.find((l) => l.scope === "five_hour");
      assert.ok(fiveHour);
      // Snapshot utilization fills the event-occupied window...
      assert.equal(fiveHour.windows[0].usedPercent, 42);
      // ...and below-100% utilization clears the stale rejected status.
      assert.equal(fiveHour.windows[0].status, undefined);
      session.close();
    });

    it("emits output from assistant text blocks", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [{ type: "text", text: "Hello! How can I help?" }],
        },
      });

      await tick();
      assert.ok(outputs.length >= 1);
      const textOutputs = outputs.filter(([o]) => o.text && !o.isWaiting);
      assert.ok(textOutputs.length >= 1);
      assert.equal(textOutputs[0][0].text, "Hello! How can I help?");
      session.close();
    });

    it("emits thinking activity from thinking blocks", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [{ type: "thinking", thinking: "Let me think about this..." }],
        },
      });

      await tick();
      const thinkingActs = activities.filter(([a]) => a.activity === "thinking");
      assert.ok(thinkingActs.length >= 1);
      assert.ok(thinkingActs[0][0].detail.includes("Let me think"));
      session.close();
    });

    it("emits tool_use activity for regular tools", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              id: "tu-1",
              input: { file_path: "/test/file.ts" },
            },
          ],
        },
      });

      await tick();
      const toolActs = activities.filter(([a]) => a.activity === "tool_use");
      assert.ok(toolActs.length >= 1);
      assert.equal(toolActs[0][0].tool, "Read");
      assert.equal(toolActs[0][0].detail, "/test/file.ts");
      assert.equal(toolActs[0][0].toolUseId, "tu-1");
      harness.fakeQuery.emit({
        type: "user",
        session_id: "sess-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-1",
              content: [{ type: "text", text: "const x = 1;" }],
            },
          ],
        },
      });
      await tick();
      const readResult = activities.find(([a]) => a.activity === "tool_result")?.[0];
      assert.equal(readResult?.toolUseId, "tu-1");
      assert.equal(readResult?.detail, "const x = 1;");
      session.close();
    });

    it("tags replayed AskUserQuestion activity with its request id", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [
            {
              type: "tool_use",
              name: "AskUserQuestion",
              id: "tu-ask-1",
              input: {
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
              },
            },
          ],
        },
      });

      await tick();

      const promptActs = activities.filter(
        ([a]) => a.activity === "tool_use" && a.tool === "AskUserQuestion",
      );
      assert.equal(promptActs.length, 1);
      assert.equal(promptActs[0][0].input.requestId, "tu-ask-1");

      session.close();
    });

    it("emits assistant text even when the same message also contains tool use", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [
            { type: "text", text: "Let me inspect that for you." },
            {
              type: "tool_use",
              name: "Read",
              id: "tu-1",
              input: { file_path: "/test/file.ts" },
            },
          ],
        },
      });

      await tick();
      const textOutputs = outputs.filter(([o]) => o.text && !o.isWaiting);
      const toolActs = activities.filter(([a]) => a.activity === "tool_use");
      assert.equal(textOutputs.length, 1);
      assert.equal(textOutputs[0][0].text, "Let me inspect that for you.");
      assert.equal(toolActs.length, 1);
      session.close();
    });

    it("tracks file changes from Edit/Write tools", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              id: "tu-1",
              input: { file_path: "/test/project/foo.ts" },
            },
          ],
        },
      });

      await tick();
      const fileActs = activities.filter(([a]) => a.activity === "file_list");
      assert.ok(fileActs.length >= 1);
      assert.equal(fileActs[0][0].files[0].path, "/test/project/foo.ts");
      assert.equal(fileActs[0][0].files[0].type, "edited");
      session.close();
    });

    it("ignores file changes outside the current workspace", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              id: "tu-1",
              input: { file_path: "/Users/test/.claude/plans/session-plan.md" },
            },
          ],
        },
      });

      await tick();
      const fileActs = activities.filter(([a]) => a.activity === "file_list");
      assert.equal(fileActs.length, 0);
      session.close();
    });

    it("suppresses task tools from chat and emits task_list", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [
            {
              type: "tool_use",
              name: "TodoWrite",
              id: "tu-1",
              input: {
                todos: [
                  { content: "Fix bug", status: "pending" },
                  { content: "Write tests", status: "in_progress" },
                ],
              },
            },
          ],
        },
      });

      await tick();
      // Should get a task_list, not a tool_use
      const taskActs = activities.filter(([a]) => a.activity === "task_list");
      const toolActs = activities.filter(
        ([a]) => a.activity === "tool_use" && a.tool === "TodoWrite",
      );
      assert.ok(taskActs.length >= 1);
      assert.equal(toolActs.length, 0);
      assert.equal(taskActs[0][0].tasks.length, 2);
      assert.equal(taskActs[0][0].tasks[0].subject, "Fix bug");
      session.close();
    });

    it("emits isWaiting output and goes idle on result", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");

      session.send("hello");
      assert.equal(session.isProcessing, true);

      harness.fakeQuery.emit({
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        is_error: false,
        result: "Done",
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      });

      await tick();
      const waitingOutputs = outputs.filter(([o]) => o.isWaiting);
      assert.ok(waitingOutputs.length >= 1);
      assert.equal(session.isProcessing, false);
      session.close();
    });

    it("accumulates stats from result modelUsage", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const statsEvents = collectEvents(session, "stats");

      harness.fakeQuery.emit({
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        is_error: false,
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 5,
          },
        },
      });

      await tick();
      assert.ok(statsEvents.length >= 1);
      const lastStats = statsEvents[statsEvents.length - 1][0];
      assert.equal(lastStats.inputTokens, 100);
      assert.equal(lastStats.outputTokens, 50);
      assert.equal(lastStats.model, "claude-sonnet-4-6");
      session.close();
    });

    it("emits exit on error result", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const exits = collectEvents(session, "exit");

      harness.fakeQuery.emit({
        type: "result",
        subtype: "error_during_execution",
        session_id: "sess-1",
        is_error: true,
        errors: ["Something went wrong"],
        modelUsage: {},
      });

      await tick();
      assert.ok(exits.length >= 1);
      assert.equal(exits[0][0].code, 1);
      assert.ok(exits[0][0].stderr.includes("Something went wrong"));
      session.close();
    });

    it("auto-continues when a turn ends mid-tool-loop", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);

      session.send("do the thing");
      // Assistant ends a partial turn with a regular tool_use block.
      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [{ type: "tool_use", name: "Read", id: "tu-1", input: {} }],
        },
      });
      harness.fakeQuery.emit({
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        is_error: false,
        stop_reason: "tool_use",
        modelUsage: {},
      });

      await tick();
      // Auto-continue fired - the turn stays active rather than going idle.
      assert.equal(session.isProcessing, true);
      session.close();
    });

    it("does NOT auto-continue after ExitPlanMode - turn goes idle awaiting approval", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness, { runtimeMode: "plan" });

      session.send("plan the work");
      // In plan mode the model presents its plan via ExitPlanMode and the turn
      // ends. This is a deliberate stop awaiting user approval - auto-continue
      // must NOT inject a "Continue." prompt and start executing the plan.
      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        message: {
          content: [
            {
              type: "tool_use",
              name: "ExitPlanMode",
              id: "tu-plan-1",
              input: { plan: "1. Do X\n2. Do Y" },
            },
          ],
        },
      });
      harness.fakeQuery.emit({
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        is_error: false,
        stop_reason: "tool_use",
        modelUsage: {},
      });

      await tick();
      // Turn went idle - the plan-review flow takes over and waits for the user.
      assert.equal(session.isProcessing, false);
      session.close();
    });
  });

  describe("permissions", () => {
    it("setRuntimeMode forwards supported permission modes to the SDK", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness, {
        runtimeMode: "full-access",
      });

      session.setRuntimeMode("plan");
      session.setRuntimeMode("full-access");
      session.setRuntimeMode("auto");

      assert.deepEqual(harness.fakeQuery.setPermissionModeCalls, [
        "plan",
        "bypassPermissions",
        "auto",
      ]);
      session.close();
    });

    it("auto-allows pre-approved tools via canUseTool", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness, {
        allowedTools: ["Bash"],
      });

      // Simulate the SDK calling canUseTool for an approved tool
      const fakeQuery = new FakeQuery();
      let canUseToolFn;
      const session2 = await createSdkSession({
        cwd: "/test",
        allowedTools: ["Bash"],
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          canUseToolFn = options.canUseTool;
          return fakeQuery;
        },
      });

      const result = await canUseToolFn(
        "Bash",
        { command: "ls" },
        {
          signal: new AbortController().signal,
          toolUseID: "tu-1",
        },
      );
      assert.equal(result.behavior, "allow");
      assert.deepEqual(result.updatedInput, { command: "ls" });
      session.close();
      session2.close();
    });

    it("emits permissionRequest and blocks on unapproved tools", async () => {
      const fakeQuery = new FakeQuery();
      let canUseToolFn;
      const session = await createSdkSession({
        cwd: "/test",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          canUseToolFn = options.canUseTool;
          return fakeQuery;
        },
      });

      const requests = collectEvents(session, "permissionRequest");

      // Call canUseTool for an unapproved tool — should block
      const resultPromise = canUseToolFn(
        "Bash",
        { command: "rm -rf /" },
        {
          signal: new AbortController().signal,
          toolUseID: "tu-1",
        },
      );

      await tick();

      // Should have emitted a permissionRequest event (not an activity)
      assert.ok(requests.length >= 1);
      assert.equal(requests[0][0].tool, "Bash");

      // Approve the permission
      const approved = session.approvePermission("Bash");
      assert.ok(approved);

      const result = await resultPromise;
      assert.equal(result.behavior, "allow");
      assert.deepEqual(result.updatedInput, { command: "rm -rf /" });

      session.close();
    });

    it("emits AskUserQuestion as a user_input request with isOther freeform enabled", async () => {
      const fakeQuery = new FakeQuery();
      let canUseToolFn;
      const session = await createSdkSession({
        cwd: "/test",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          canUseToolFn = options.canUseTool;
          return fakeQuery;
        },
      });

      const requests = collectEvents(session, "permissionRequest");

      // AskUserQuestion always blocks for user input. The Claude harness lets the
      // user write their own answer ("Other") even when options are offered, so
      // every question must be flagged isOther to enable the freeform composer.
      const resultPromise = canUseToolFn(
        "AskUserQuestion",
        {
          questions: [
            { question: "Which do you prefer?", options: [{ label: "Coffee" }, { label: "Tea" }] },
            {
              id: "fixed",
              question: "Pick a number",
              options: [{ label: "1" }],
              multiSelect: true,
            },
          ],
        },
        { signal: new AbortController().signal, toolUseID: "tu-ask-1" },
      );

      await tick();

      assert.ok(requests.length >= 1);
      const request = requests[0][0];
      assert.equal(request.kind, "user_input");
      assert.equal(request.tool, "AskUserQuestion");
      assert.equal(request.questions.length, 2);
      assert.ok(
        request.questions.every((q) => q.isOther === true),
        "every question should be flagged isOther",
      );
      // Generated ids by index where absent, preserved where present.
      assert.equal(request.questions[0].id, "q_0");
      assert.equal(request.questions[1].id, "fixed");
      // multiSelect survives the mapper and is normalized to a boolean.
      assert.equal(request.questions[0].multiSelect, false);
      assert.equal(request.questions[1].multiSelect, true);

      session.close();
      await resultPromise.catch(() => {});
    });

    it("suppresses stale stream-closed permission errors after auto-approving via bypass", async () => {
      const fakeQuery = new FakeQuery();
      let canUseToolFn;
      const session = await createSdkSession({
        cwd: "/test",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          canUseToolFn = options.canUseTool;
          return fakeQuery;
        },
      });
      const activities = collectEvents(session, "activity");

      const resultPromise = canUseToolFn(
        "Bash",
        { command: "rm -rf /" },
        {
          signal: new AbortController().signal,
          toolUseID: "tu-stale-1",
        },
      );

      await tick();

      session.setRuntimeMode("full-access");
      const result = await resultPromise;
      assert.equal(result.behavior, "allow");

      fakeQuery.emit({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-stale-1",
              is_error: true,
              content: "Tool permission request failed: Error: Stream closed",
            },
          ],
        },
      });

      await tick();

      assert.equal(
        activities.some(
          ([activity]) =>
            activity.activity === "tool_result" && activity.description === "Tool error",
        ),
        false,
      );
      session.close();
    });

    it("denies permission when signal is aborted", async () => {
      const fakeQuery = new FakeQuery();
      let canUseToolFn;
      const session = await createSdkSession({
        cwd: "/test",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          canUseToolFn = options.canUseTool;
          return fakeQuery;
        },
      });

      const abortController = new AbortController();
      const resultPromise = canUseToolFn(
        "Bash",
        { command: "ls" },
        {
          signal: abortController.signal,
          toolUseID: "tu-1",
        },
      );

      await tick();
      abortController.abort();

      const result = await resultPromise;
      assert.equal(result.behavior, "deny");

      session.close();
    });

    it("groups file-write tool approvals", async () => {
      const fakeQuery = new FakeQuery();
      let canUseToolFn;
      const session = await createSdkSession({
        cwd: "/test",
        allowedTools: ["Edit"],
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          canUseToolFn = options.canUseTool;
          return fakeQuery;
        },
      });

      // Write should be auto-approved since Edit is in the allowed set
      const result = await canUseToolFn(
        "Write",
        { file_path: "/test/f.ts" },
        {
          signal: new AbortController().signal,
          toolUseID: "tu-1",
        },
      );
      assert.equal(result.behavior, "allow");
      assert.deepEqual(result.updatedInput, { file_path: "/test/f.ts" });

      session.close();
    });

    it("resolves AskUserQuestion answers keyed by question text, not synthetic ids", async () => {
      const fakeQuery = new FakeQuery();
      let canUseToolFn;
      const session = await createSdkSession({
        cwd: "/test",
        logger: noopLogger,
        queryFn: ({ _prompt, options }) => {
          canUseToolFn = options.canUseTool;
          return fakeQuery;
        },
      });
      const requests = collectEvents(session, "permissionRequest");

      // AskUserQuestion tool input has NO question ids (matches real SDK input).
      const resultPromise = canUseToolFn(
        "AskUserQuestion",
        {
          questions: [
            { header: "Access", question: "How is it obtainable?" },
            { header: "Fire-all", question: "How should fire-all behave?" },
          ],
        },
        { signal: new AbortController().signal, toolUseID: "tu-ask-9" },
      );

      await tick();

      // The emitted request should carry generated q_<index> ids.
      assert.equal(requests.length, 1);
      assert.equal(requests[0][0].kind, "user_input");
      assert.deepEqual(
        requests[0][0].questions.map((q) => q.id),
        ["q_0", "q_1"],
      );

      // Answer using Relay's q_<index>-keyed format.
      const handled = session.respondToRequest("tu-ask-9", "accept", {
        answers: {
          q_0: { answers: ["Admin devtool toggle"] },
          q_1: { answers: ["All weapons, ignore heat/cooldown"] },
        },
      });
      assert.equal(handled, true);

      const result = await resultPromise;
      assert.equal(result.behavior, "allow");
      // SDK's built-in handler keys answers by question TEXT.
      assert.deepEqual(result.updatedInput.answers, {
        "How is it obtainable?": "Admin devtool toggle",
        "How should fire-all behave?": "All weapons, ignore heat/cooldown",
      });

      session.close();
    });
  });

  describe("control methods", () => {
    it("interrupt() calls query.interrupt()", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);

      session.interrupt();
      await tick();
      assert.equal(harness.fakeQuery.interruptCalls, 1);
      session.close();
    });

    it("setModel() calls query.setModel()", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);

      session.setModel("claude-opus-4-6");
      await tick();
      assert.deepEqual(harness.fakeQuery.setModelCalls, ["claude-opus-4-6"]);

      session.setModel(null);
      await tick();
      assert.deepEqual(harness.fakeQuery.setModelCalls, ["claude-opus-4-6", undefined]);
      session.close();
    });

    it("close() terminates the session", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);

      session.close();
      await tick();
      assert.equal(harness.fakeQuery.closeCalls, 1);
    });
  });

  describe("runtime mode", () => {
    it("setRuntimeMode() forwards plan/default permission modes to the SDK", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);

      session.setRuntimeMode("plan");
      session.setRuntimeMode("approval-required");

      await tick();

      assert.deepEqual(harness.fakeQuery.setPermissionModeCalls, ["plan", "default"]);
      session.close();
    });
  });

  describe("stream_event (partial messages)", () => {
    it("buffers text deltas and emits them on message_stop for text-only messages", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "message_start",
        },
      });

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello " },
        },
      });

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "world!" },
        },
      });

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "message_stop",
        },
      });

      await tick();
      const textOutputs = outputs.filter(([o]) => o.text && !o.isWaiting);
      assert.equal(textOutputs.length, 1);
      assert.equal(textOutputs[0][0].text, "Hello world!");
      session.close();
    });

    it("emits buffered text even when the assistant message also contains tool use", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "message_start",
        },
      });

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Let me check that." },
        },
      });

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu-1", name: "Read", input: {} },
        },
      });

      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        event: {
          type: "message_stop",
        },
      });

      await tick();
      const textOutputs = outputs.filter(([o]) => o.text && !o.isWaiting);
      assert.equal(textOutputs.length, 1);
      assert.equal(textOutputs[0][0].text, "Let me check that.");
      session.close();
    });
  });

  describe("createSdkSessionSync", () => {
    it("creates a session synchronously with a pre-resolved queryFn", () => {
      const harness = makeHarness();
      const session = createSdkSessionSync(
        {
          cwd: "/test/project",
          logger: noopLogger,
          queryFn: harness.queryFn,
        },
        harness.queryFn,
      );

      assert.ok(session);
      assert.equal(session.isProcessing, false);
      assert.equal(typeof session.send, "function");
      assert.equal(typeof session.interrupt, "function");
      assert.equal(typeof session.close, "function");
      assert.equal(typeof session.approvePermission, "function");
      session.close();
    });

    it("works identically to the async createSdkSession", async () => {
      const harness = makeHarness();
      const session = createSdkSessionSync(
        { cwd: "/test/project", logger: noopLogger },
        harness.queryFn,
      );
      const outputs = collectEvents(session, "output");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-sync",
        message: { content: [{ type: "text", text: "sync works" }] },
      });
      await tick();

      assert.equal(session.sessionId, "sess-sync");
      const textOutputs = outputs.filter(([o]) => !o.isWaiting);
      assert.equal(textOutputs[0][0].text, "sync works");
      session.close();
    });
  });

  // ===========================================================================
  // Delegated agents (subagents) — attribution, isolation, lifecycle
  // ===========================================================================

  describe("delegated agents", () => {
    const CHILD_A = "toolu_agent_a";
    const CHILD_B = "toolu_agent_b";

    function streamEvent(harness, event, parentToolUseId = null) {
      harness.fakeQuery.emit({
        type: "stream_event",
        session_id: "sess-1",
        parent_tool_use_id: parentToolUseId,
        event,
      });
    }

    function textDelta(harness, text, parentToolUseId = null, index = 0) {
      streamEvent(
        harness,
        { type: "content_block_delta", index, delta: { type: "text_delta", text } },
        parentToolUseId,
      );
    }

    it("enables forwardSubagentText so child prose reaches the nested transcript", async () => {
      let captured;
      const harness = makeHarness();
      const session = await createSdkSession({
        cwd: "/test/project",
        logger: noopLogger,
        queryFn: ({ options }) => {
          captured = options;
          return harness.fakeQuery;
        },
      });
      assert.equal(captured.forwardSubagentText, true);
      session.close();
    });

    it("keeps interleaved root and child streams isolated and attributes child output", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");

      streamEvent(harness, { type: "message_start" });
      streamEvent(harness, { type: "message_start" }, CHILD_A);
      streamEvent(harness, { type: "message_start" }, CHILD_B);
      textDelta(harness, "Root ");
      textDelta(harness, "child A says ", CHILD_A);
      textDelta(harness, "child B says ", CHILD_B);
      textDelta(harness, "hi", CHILD_A);
      textDelta(harness, "text", null);
      textDelta(harness, "yo", CHILD_B);
      // Child A finishes first; root and B are still streaming.
      streamEvent(harness, { type: "message_stop" }, CHILD_A);
      // A new child-A message must not reset root or B.
      streamEvent(harness, { type: "message_start" }, CHILD_A);
      textDelta(harness, "second", CHILD_A);
      streamEvent(harness, { type: "message_stop" }, CHILD_B);
      streamEvent(harness, { type: "message_stop" });
      streamEvent(harness, { type: "message_stop" }, CHILD_A);
      await tick();

      const texts = outputs.filter(([o]) => o.text && !o.isWaiting).map(([o]) => o);
      assert.deepEqual(
        texts.map((o) => [o.agentId, o.text]),
        [
          [CHILD_A, "child A says hi"],
          [CHILD_B, "child B says yo"],
          [undefined, "Root text"],
          [CHILD_A, "second"],
        ],
      );
      session.close();
    });

    it("does not double-emit child text when the full assistant frame follows a stream", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");

      streamEvent(harness, { type: "message_start" }, CHILD_A);
      textDelta(harness, "streamed", CHILD_A);
      streamEvent(harness, { type: "message_stop" }, CHILD_A);
      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        parent_tool_use_id: CHILD_A,
        message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "streamed" }] },
      });
      // A root assistant frame with no stream still emits (fallback path), unattributed.
      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        parent_tool_use_id: null,
        message: { model: "claude-opus-4-8", content: [{ type: "text", text: "root fallback" }] },
      });
      await tick();

      const texts = outputs
        .filter(([o]) => o.text && !o.isWaiting)
        .map(([o]) => [o.agentId, o.text]);
      assert.deepEqual(texts, [
        [CHILD_A, "streamed"],
        [undefined, "root fallback"],
      ]);
      session.close();
    });

    it("announces Agent tool calls, tracks the child model, and attributes child tools", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const updateEvents = collectEvents(session, "agentUpdate");
      const updates = () => updateEvents.map(([u]) => u);
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-8",
          content: [
            {
              type: "tool_use",
              id: CHILD_A,
              name: "Agent",
              input: {
                description: "Find sidebar code",
                subagent_type: "Explore",
                name: "sidebar-hunter",
                model: "sonnet",
                prompt: "Locate the sidebar components.",
              },
            },
          ],
        },
      });
      // Child frames: its own tool use and thinking, plus a TodoWrite that must
      // not touch the chat's task list.
      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        parent_tool_use_id: CHILD_A,
        message: {
          model: "claude-sonnet-4-6",
          content: [
            { type: "thinking", thinking: "Let me look." },
            {
              type: "tool_use",
              id: "toolu_child_grep",
              name: "Grep",
              input: { pattern: "Sidebar" },
            },
            {
              type: "tool_use",
              id: "toolu_child_todo",
              name: "TodoWrite",
              input: { todos: [{ content: "x", status: "pending" }] },
            },
          ],
        },
      });
      harness.fakeQuery.emit({
        type: "user",
        session_id: "sess-1",
        parent_tool_use_id: CHILD_A,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_child_grep", content: "3 matches" }],
        },
      });
      await tick();

      const spawn = updates().find(
        (u) => u.agent.agentId === CHILD_A && u.agent.status === "pending",
      );
      assert.ok(spawn, "spawn update emitted");
      assert.equal(spawn.agent.originToolUseId, CHILD_A);
      assert.equal(spawn.agent.relation, "child");
      assert.equal(spawn.agent.name, "sidebar-hunter");
      assert.equal(spawn.agent.role, "Explore");
      assert.equal(spawn.agent.description, "Find sidebar code");
      assert.equal(spawn.agent.assignment, "Locate the sidebar components.");
      assert.equal(spawn.agent.model, "sonnet", "alias kept verbatim, not resolved");
      assert.ok(typeof spawn.agent.startedAt === "number");

      const modelUpdate = updates().find((u) => u.agent.model === "claude-sonnet-4-6");
      assert.ok(modelUpdate, "child model reported from its assistant frame");
      assert.equal(modelUpdate.agent.agentId, CHILD_A);

      const rootToolUse = activities.find(([a]) => a.activity === "tool_use" && a.tool === "Agent");
      assert.ok(rootToolUse, "delegation tool_use still emitted for the orchestrator");
      assert.equal(rootToolUse[0].agentId, undefined);
      assert.equal(rootToolUse[0].toolUseId, CHILD_A);

      const childActivities = activities.map(([a]) => a).filter((a) => a.agentId === CHILD_A);
      assert.ok(childActivities.some((a) => a.activity === "thinking"));
      assert.ok(childActivities.some((a) => a.activity === "tool_use" && a.tool === "Grep"));
      assert.ok(childActivities.some((a) => a.activity === "tool_result"));
      assert.ok(childActivities.some((a) => a.activity === "tool_use" && a.tool === "TodoWrite"));
      assert.ok(
        !activities.some(([a]) => a.activity === "task_list"),
        "child TodoWrite does not rewrite the chat task list",
      );
      session.close();
    });

    it("maps sync and async Agent results from tool_use_result", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const updateEvents = collectEvents(session, "agentUpdate");
      const updates = () => updateEvents.map(([u]) => u);
      const activities = collectEvents(session, "activity");

      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-8",
          content: [
            {
              type: "tool_use",
              id: CHILD_A,
              name: "Agent",
              input: { prompt: "a", run_in_background: true },
            },
            {
              type: "tool_use",
              id: CHILD_B,
              name: "Task",
              input: { prompt: "b", description: "Sync one" },
            },
          ],
        },
      });
      harness.fakeQuery.emit({
        type: "user",
        session_id: "sess-1",
        parent_tool_use_id: null,
        tool_use_result: {
          isAsync: true,
          status: "async_launched",
          agentId: "a056f6543c6a3e362",
          description: "Background one",
          resolvedModel: "claude-opus-4-8",
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: CHILD_A,
              content: [{ type: "text", text: "Async agent launched successfully." }],
            },
          ],
        },
      });
      harness.fakeQuery.emit({
        type: "user",
        session_id: "sess-1",
        parent_tool_use_id: null,
        tool_use_result: {
          status: "completed",
          agentId: "ae9f3794b10b24b3c",
          agentType: "Explore",
          content: [{ type: "text", text: "Findings: all good." }],
          resolvedModel: "claude-sonnet-4-6",
          totalDurationMs: 1000,
          totalTokens: 200,
          totalToolUseCount: 3,
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: CHILD_B,
              content: [{ type: "text", text: "Findings: all good." }],
            },
          ],
        },
      });
      await tick();

      const launched = updates().find(
        (u) => u.agent.agentId === CHILD_A && u.agent.status === "running",
      );
      assert.ok(launched, "async launch → running");
      assert.equal(launched.agent.providerAgentId, "a056f6543c6a3e362");
      assert.equal(launched.agent.model, "claude-opus-4-8");
      assert.equal(launched.agent.description, "Background one");

      const done = updates().find(
        (u) => u.agent.agentId === CHILD_B && u.agent.status === "completed",
      );
      assert.ok(done, "sync completion → completed");
      assert.equal(done.agent.providerAgentId, "ae9f3794b10b24b3c");
      assert.equal(done.agent.result, "Findings: all good.");
      assert.deepEqual(done.agent.usage, { totalTokens: 200, toolUses: 3, durationMs: 1000 });
      assert.ok(typeof done.agent.endedAt === "number");
      // The tool_use_result is not duplicated onto the update; only provenance.
      assert.deepEqual(done.raw, { tool: "Task", toolUseId: CHILD_B });
      const spawnB = updates().find(
        (u) => u.agent.agentId === CHILD_B && u.agent.status === "pending",
      );
      assert.deepEqual(spawnB.raw, { tool: "Task", toolUseId: CHILD_B });

      // The orchestrator still sees both tool_results.
      const results = activities.map(([a]) => a).filter((a) => a.activity === "tool_result");
      assert.deepEqual(results.map((a) => a.toolUseId).sort(), [CHILD_A, CHILD_B].sort());
      assert.ok(results.every((a) => a.agentId === undefined));
      session.close();
    });

    it("maps task_* system events onto the agent keyed by tool_use_id, then by task_id", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const updateEvents = collectEvents(session, "agentUpdate");
      const updates = () => updateEvents.map(([u]) => u);

      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_started",
        session_id: "sess-1",
        task_id: "task-1",
        tool_use_id: CHILD_A,
        description: "Index the repo",
        subagent_type: "general-purpose",
        prompt: "Index everything.",
      });
      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_progress",
        session_id: "sess-1",
        task_id: "task-1",
        description: "Index the repo",
        last_tool_name: "Grep",
        usage: { total_tokens: 500, tool_uses: 4, duration_ms: 2000 },
      });
      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_updated",
        session_id: "sess-1",
        task_id: "task-1",
        patch: { status: "paused" },
      });
      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_notification",
        session_id: "sess-1",
        task_id: "task-1",
        status: "failed",
        output_file: "/nonexistent/task-1.output",
        summary: 'Agent "Index the repo" failed',
        usage: { total_tokens: 900, tool_uses: 9, duration_ms: 9000 },
      });
      await tick();

      const forA = updates()
        .filter((u) => u.agent.agentId === CHILD_A)
        .map((u) => u.agent);
      assert.equal(forA.length, 4, "all four events resolve to the same Relay key");
      assert.equal(forA[0].status, "running");
      assert.equal(forA[0].providerAgentId, "task-1");
      assert.equal(forA[0].originToolUseId, CHILD_A);
      assert.equal(forA[0].description, "Index the repo");
      assert.equal(forA[0].role, "general-purpose");
      assert.equal(forA[0].assignment, "Index everything.");
      assert.equal(forA[1].lastActivity, "Grep");
      assert.deepEqual(forA[1].usage, { totalTokens: 500, toolUses: 4, durationMs: 2000 });
      assert.equal(forA[2].status, "waiting");
      assert.equal(forA[3].status, "failed");
      assert.equal(forA[3].resultIsError, true);
      assert.equal(forA[3].result, 'Agent "Index the repo" failed');
      assert.equal(
        forA[3].historyAvailable,
        undefined,
        "availability is the history route's 404, not a flag",
      );
      // raw is a provenance stub, never the provider payload.
      assert.deepEqual(
        updates()
          .filter((u) => u.agent.agentId === CHILD_A)
          .map((u) => u.raw),
        [
          { subtype: "task_started" },
          { subtype: "task_progress" },
          { subtype: "task_updated" },
          { subtype: "task_notification" },
        ],
      );
      session.close();
    });

    it("does not turn background Bash tasks into agents", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const updateEvents = collectEvents(session, "agentUpdate");

      // A `local_bash` task carries the Bash tool_use id — not an agent key.
      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_started",
        session_id: "sess-1",
        task_id: "bash-task-1",
        tool_use_id: "toolu_bash_01",
        task_type: "local_bash",
        description: "pnpm test",
      });
      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_progress",
        session_id: "sess-1",
        task_id: "bash-task-1",
        description: "pnpm test",
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 100 },
      });
      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_notification",
        session_id: "sess-1",
        task_id: "bash-task-1",
        tool_use_id: "toolu_bash_01",
        status: "completed",
        output_file: "/nonexistent/bash-task-1.output",
        summary: "Background command finished",
      });
      // The same shape arriving as a user-envelope notification is dropped too.
      harness.fakeQuery.emit({
        type: "user",
        session_id: "sess-1",
        parent_tool_use_id: null,
        origin: { kind: "task-notification" },
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>bash-task-1</task-id>\n<tool-use-id>toolu_bash_01</tool-use-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>",
        },
      });
      // An agent-shaped task without a tool_use_id and no known task id is
      // also not keyed by its bare task id.
      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_progress",
        session_id: "sess-1",
        task_id: "orphan-task",
        subagent_type: "Explore",
        description: "Orphan",
        usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
      });
      await tick();

      assert.equal(
        updateEvents.length,
        0,
        "no agent_update for a Bash task or an unresolvable task",
      );
      session.close();
    });

    it("keys a task by its tool_use_id when the event says it is an agent", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const updateEvents = collectEvents(session, "agentUpdate");
      const updates = () => updateEvents.map(([u]) => u);

      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_started",
        session_id: "sess-1",
        task_id: "wf-1",
        tool_use_id: "toolu_workflow",
        task_type: "local_workflow",
        workflow_name: "spec",
        description: "Run the spec workflow",
      });
      await tick();

      assert.equal(updates().length, 1);
      assert.equal(updates()[0].agent.agentId, "toolu_workflow");
      assert.equal(updates()[0].agent.providerAgentId, "wf-1");
      session.close();
    });

    it("emits every child message when child text arrives only as assistant frames", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");

      const childFrame = (text) =>
        harness.fakeQuery.emit({
          type: "assistant",
          session_id: "sess-1",
          parent_tool_use_id: CHILD_A,
          message: { model: "claude-haiku-4-5", content: [{ type: "text", text }] },
        });

      // Root streams; child A only ever sends full frames; child B streams.
      streamEvent(harness, { type: "message_start" });
      textDelta(harness, "Root ");
      childFrame("child first");
      streamEvent(harness, { type: "message_start" }, CHILD_B);
      textDelta(harness, "B streamed", CHILD_B);
      childFrame("child second");
      streamEvent(harness, { type: "message_stop" }, CHILD_B);
      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        parent_tool_use_id: CHILD_B,
        message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "B streamed" }] },
      });
      textDelta(harness, "text");
      streamEvent(harness, { type: "message_stop" });
      harness.fakeQuery.emit({
        type: "assistant",
        session_id: "sess-1",
        parent_tool_use_id: null,
        message: { model: "claude-opus-4-8", content: [{ type: "text", text: "Root text" }] },
      });
      childFrame("child third");
      await tick();

      const texts = outputs
        .filter(([o]) => o.text && !o.isWaiting)
        .map(([o]) => [o.agentId, o.text]);
      assert.deepEqual(texts, [
        [CHILD_A, "child first"],
        [CHILD_A, "child second"],
        [CHILD_B, "B streamed"],
        [undefined, "Root text"],
        [CHILD_A, "child third"],
      ]);
      session.close();
    });

    it("keeps an in-flight background child stream across the user's next send()", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const outputs = collectEvents(session, "output");

      streamEvent(harness, { type: "message_start" }, CHILD_A);
      textDelta(harness, "half ", CHILD_A);
      await tick();
      session.send("next question");
      textDelta(harness, "done", CHILD_A);
      streamEvent(harness, { type: "message_stop" }, CHILD_A);
      await tick();

      const texts = outputs
        .filter(([o]) => o.text && !o.isWaiting)
        .map(([o]) => [o.agentId, o.text]);
      assert.deepEqual(texts, [[CHILD_A, "half done"]]);
      session.close();
    });

    it("ignores replayed user frames on resume until the first send", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness, { resumeSessionId: "abc-123" });
      const userMessageEvents = collectEvents(session, "userMessage");
      const updateEvents = collectEvents(session, "agentUpdate");

      const peerFrame = () =>
        harness.fakeQuery.emit({
          type: "user",
          session_id: "abc-123",
          parent_tool_use_id: null,
          origin: { kind: "peer", name: "worker", body: "Report from before." },
          message: {
            role: "user",
            content: '<agent-message from="worker">Report from before.</agent-message>',
          },
        });
      // Replayed during resume: already in history, must not re-emit.
      peerFrame();
      harness.fakeQuery.emit({
        type: "user",
        session_id: "abc-123",
        parent_tool_use_id: null,
        origin: { kind: "task-notification" },
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>t-old</task-id>\n<tool-use-id>" +
            CHILD_A +
            "</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>",
        },
      });
      await tick();
      assert.equal(userMessageEvents.length, 0);
      assert.equal(updateEvents.length, 0);

      // After the first send the session is live again.
      session.send("continue");
      peerFrame();
      await tick();
      assert.equal(userMessageEvents.length, 1);
      assert.equal(userMessageEvents[0][0].text, "Report from before.");
      session.close();
    });

    it("surfaces peer envelopes as agent-authored user messages and hides the wrapper", async () => {
      const harness = makeHarness();
      const session = await createTestSession(harness);
      const userMessageEvents = collectEvents(session, "userMessage");
      const userMessages = () => userMessageEvents.map(([m]) => m);
      const updateEvents = collectEvents(session, "agentUpdate");
      const updates = () => updateEvents.map(([u]) => u);

      // Learn the sender: task-1 is the provider id behind CHILD_A.
      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_started",
        session_id: "sess-1",
        task_id: "a4320b8ef6db9c5c7",
        tool_use_id: CHILD_A,
        subagent_type: "Explore",
        description: "Discover region",
      });
      harness.fakeQuery.emit({
        type: "user",
        session_id: "sess-1",
        parent_tool_use_id: null,
        origin: {
          kind: "peer",
          from: "discover-region",
          name: "discover-region",
          senderTaskId: "a4320b8ef6db9c5c7",
          body: "Heads up: the build is broken.",
        },
        message: {
          role: "user",
          content:
            'Another Claude session sent a message:\n<agent-message from="discover-region">\nHeads up: the build is broken.\n</agent-message>\n\nThat "other Claude session" is an agent — that\'s permission laundering.',
        },
      });
      // A plain human-shaped frame echoed by the SDK produces nothing (Relay
      // already recorded the human's send).
      harness.fakeQuery.emit({
        type: "user",
        session_id: "sess-1",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "hello from the human" }] },
      });
      // Task notification arriving as a user frame → agent_update, not a bubble.
      harness.fakeQuery.emit({
        type: "user",
        session_id: "sess-1",
        parent_tool_use_id: null,
        origin: { kind: "task-notification" },
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>a4320b8ef6db9c5c7</task-id>\n<tool-use-id>" +
            CHILD_A +
            "</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>Region found.</result>\n</task-notification>",
        },
      });
      await tick();

      assert.equal(userMessages().length, 1);
      assert.equal(userMessages()[0].text, "Heads up: the build is broken.");
      assert.deepEqual(userMessages()[0].author, {
        kind: "agent",
        name: "discover-region",
        agentId: CHILD_A,
      });

      const completed = updates().find(
        (u) => u.agent.agentId === CHILD_A && u.agent.status === "completed",
      );
      assert.ok(completed, "task notification mapped to the agent");
      assert.equal(completed.agent.result, "Region found.");
      assert.equal(completed.agent.historyAvailable, undefined);
      assert.deepEqual(completed.raw, { subtype: "task_notification" });
      session.close();
    });

    it("maps permission requests from a known child to its Relay key", async () => {
      const harness = makeHarness();
      let canUseTool;
      const session = await createSdkSession({
        cwd: "/test/project",
        logger: noopLogger,
        queryFn: ({ options }) => {
          canUseTool = options.canUseTool;
          return harness.fakeQuery;
        },
      });
      const requestEvents = collectEvents(session, "permissionRequest");
      const requests = () => requestEvents.map(([r]) => r);

      harness.fakeQuery.emit({
        type: "system",
        subtype: "task_started",
        session_id: "sess-1",
        task_id: "agent-native-id",
        tool_use_id: CHILD_A,
        task_type: "local_agent",
        description: "Worker",
      });
      await tick();

      const controller = new AbortController();
      void canUseTool(
        "Bash",
        { command: "rm -rf build" },
        {
          signal: controller.signal,
          toolUseID: "toolu_perm",
          agentID: "agent-native-id",
        },
      );
      await tick();

      assert.equal(requests().length, 1);
      assert.equal(requests()[0].agentId, "agent-native-id");
      assert.equal(requests()[0].relayAgentId, CHILD_A);
      controller.abort();
      session.close();
    });
  });
});
