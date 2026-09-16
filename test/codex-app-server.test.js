import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CodexAppServerSession,
  normalizeCodexSkillsSnapshot,
} from "../dist/server/core/providers/codex-app-server.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.pid = 5050;
    this.exitCode = null;
    this.killed = false;
    this.killedSignals = [];

    // Capture what's written to stdin
    this._stdinWrites = [];
    const origWrite = this.stdin.write.bind(this.stdin);
    this.stdin.write = (data) => {
      this._stdinWrites.push(data.toString());
      return origWrite(data);
    };
  }

  kill(signal = "SIGTERM") {
    this.killedSignals.push(signal);
    this.killed = true;
    return true;
  }

  getStdinMessages() {
    return this._stdinWrites.map((line) => {
      try {
        return JSON.parse(line.trim());
      } catch {
        return line;
      }
    });
  }
}

function createHarness() {
  const spawns = [];
  const children = [];

  return {
    spawns,
    children,
    spawnProcess(command, args, options) {
      const child = new FakeChildProcess();
      spawns.push({ command, args, options });
      children.push(child);
      return child;
    },
  };
}

function collectEvents(session, eventName) {
  const events = [];
  session.on(eventName, (...args) => events.push(args));
  return events;
}

function tick(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simulate the app-server responding to JSON-RPC requests on stdin by writing to stdout */
function autoRespond(child, options = {}) {
  const skipMethods = new Set(options.skipMethods ?? []);
  child.stdin.on("data", (chunk) => {
    const lines = chunk.toString().trim().split("\n");
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      // Only respond to requests (have id and method)
      if (msg.id === undefined || !msg.method) continue;
      if (skipMethods.has(msg.method)) continue;

      if (msg.method === "initialize") {
        child.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "codex-test/1.0" } }) +
            "\n",
        );
      } else if (msg.method === "mcpServerStatus/list" && options.mcpResult) {
        child.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: options.mcpResult }) + "\n",
        );
      } else if (msg.method === "thread/start") {
        child.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              thread: {
                id: "thread-001",
                cwd: msg.params?.cwd ?? "/tmp",
                status: { type: "idle" },
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: Date.now() / 1000,
                updatedAt: Date.now() / 1000,
                path: null,
                cliVersion: "1.0",
                source: "app-server",
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
              },
            },
          }) + "\n",
        );
      } else if (msg.method === "thread/resume") {
        child.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              thread: {
                id: msg.params?.threadId ?? "thread-resumed",
                cwd: msg.params?.cwd ?? "/tmp",
                status: { type: "idle" },
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: Date.now() / 1000,
                updatedAt: Date.now() / 1000,
                path: null,
                cliVersion: "1.0",
                source: "app-server",
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
              },
            },
          }) + "\n",
        );
      } else if (msg.method === "turn/start") {
        child.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {},
          }) + "\n",
        );
      } else if (msg.method === "turn/interrupt") {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      } else {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      }
    }
  });
}

describe("CodexAppServerSession", () => {
  it("spawns codex app-server with stdio transport", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "o3",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "/tmp/fake-codex",
    });

    session.send("hello");
    // spawnProcess was called by send()
    const child = harness.children[0];
    autoRespond(child, { skipMethods: ["skills/list"] });

    await tick(50);

    assert.equal(harness.spawns.length, 1);
    assert.equal(harness.spawns[0].command, "/tmp/fake-codex");
    assert.deepEqual(harness.spawns[0].args, ["app-server", "--listen", "stdio://"]);
    assert.equal(harness.spawns[0].options.cwd, "/tmp/project");

    session.close();
  });

  it("initializes, starts thread, and starts turn via JSON-RPC", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });

    session.send("hello");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    const msgs = child.getStdinMessages();
    const methods = msgs.filter((m) => m.method).map((m) => m.method);

    assert.ok(methods.includes("initialize"), "Should send initialize");
    assert.ok(methods.includes("thread/start"), "Should send thread/start");
    assert.ok(methods.includes("turn/start"), "Should send turn/start");

    // Check thread/start params
    const threadStart = msgs.find((m) => m.method === "thread/start");
    assert.equal(threadStart.params.model, "gpt-5.4");
    assert.equal(threadStart.params.cwd, "/tmp/project");

    // Check turn/start has the message
    const turnStart = msgs.find((m) => m.method === "turn/start");
    assert.equal(turnStart.params.input[0].text, "hello");
    assert.equal(turnStart.params.collaborationMode.mode, "default");
    assert.equal(turnStart.params.collaborationMode.settings.model, "gpt-5.4");

    session.close();
  });

  it("passes bootstrap instructions on thread start", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
      bootstrapContext: {
        blocks: [],
        baseInstructions: "Base relay policy",
        developerInstructions: "Developer relay policy",
      },
    });

    session.send("hello");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    const msgs = child.getStdinMessages();
    const threadStart = msgs.find((m) => m.method === "thread/start");
    assert.equal(threadStart.params.baseInstructions, "Base relay policy");
    assert.equal(threadStart.params.developerInstructions, "Developer relay policy");

    session.close();
  });

  it("normalizes startup skills from skills/list", () => {
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          normalizeCodexSkillsSnapshot(
            {
              data: [
                {
                  cwd: "/tmp/project",
                  skills: [
                    {
                      name: "review-follow-up",
                      description: "Review follow-up changes",
                      shortDescription: "Review changes",
                      enabled: true,
                      interface: {
                        displayName: "Review Follow-up",
                      },
                    },
                  ],
                },
              ],
            },
            "/tmp/project",
          ),
        ),
      ),
      [
        {
          name: "review-follow-up",
          displayName: "Review Follow-up",
          description: "Review follow-up changes",
          shortDescription: "Review changes",
          enabled: true,
          invocationPrefix: "$",
        },
      ],
    );
  });

  it("requests startup snapshots for MCP servers and apps", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });

    session.send("hello");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    const methods = child
      .getStdinMessages()
      .filter((m) => m.method)
      .map((m) => m.method);

    assert.ok(methods.includes("mcpServerStatus/list"), "Should request MCP server snapshot");
    assert.ok(methods.includes("app/list"), "Should request app snapshot");
    assert.ok(methods.includes("account/read"), "Should request account snapshot");
    assert.ok(methods.includes("account/rateLimits/read"), "Should request rate-limit snapshot");

    session.close();
  });

  it("normalizes the paginated Codex MCP startup snapshot", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("hello");
    autoRespond(harness.children[0], {
      mcpResult: {
        data: [
          {
            name: "github",
            serverInfo: { name: "GitHub" },
            tools: [{ name: "search", description: "Search repositories" }],
            authStatus: "authenticated",
          },
          {
            name: "sentry",
            serverInfo: null,
            tools: [],
            authStatus: "oAuth",
          },
        ],
        nextCursor: null,
      },
    });
    await tick(50);

    const event = systemEvents
      .map(([value]) => value)
      .find((value) => value.event === "provider_status" && value.payload.mcpServers?.length);
    assert.equal(event.payload.mcpServers[0].name, "github");
    assert.equal(event.payload.mcpServers[0].toolCount, 1);
    assert.equal(event.payload.mcpServers[0].tools[0].name, "search");
    assert.equal(event.payload.mcpServers[0].authStatus, "authenticated");
    assert.equal(event.payload.mcpServers[0].connectionState, "connected");
    assert.equal(event.payload.mcpServers[1].connectionState, "needs_auth");
    assert.deepEqual(event.payload.mcpServers[1].authentication, {
      method: "oauth",
      login: true,
      logout: false,
    });
    session.close();
  });

  it("normalizes startup account snapshots into provider status", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("hello");
    const child = harness.children[0];
    child.stdin.on("data", (chunk) => {
      const lines = chunk.toString().trim().split("\n");
      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined || !msg.method) continue;
        if (msg.method === "initialize") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { userAgent: "codex-test/1.0" },
            }) + "\n",
          );
        } else if (msg.method === "thread/start") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                thread: {
                  id: "thread-001",
                  cwd: msg.params?.cwd ?? "/tmp",
                },
              },
            }) + "\n",
          );
        } else if (msg.method === "turn/start") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
        } else if (msg.method === "account/read") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
                requiresOpenaiAuth: true,
              },
            }) + "\n",
          );
        } else if (msg.method === "account/rateLimits/read") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                rateLimits: {
                  limitId: "codex",
                  limitName: "Codex",
                  primary: { usedPercent: 82, windowDurationMins: 60, resetsAt: 1760000000 },
                  secondary: null,
                  credits: null,
                  planType: "pro",
                },
                rateLimitsByLimitId: null,
              },
            }) + "\n",
          );
        } else {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
        }
      }
    });

    await tick(50);

    const providerStatusEvents = systemEvents
      .map(([event]) => event)
      .filter((event) => event.event === "provider_status");
    assert.ok(
      providerStatusEvents.some(
        (event) =>
          event.payload.account?.email === "user@example.com" &&
          event.payload.account?.plan === "pro",
      ),
      "Should emit normalized account snapshot",
    );
    assert.ok(
      providerStatusEvents.some(
        (event) => event.payload.account?.rateLimits?.[0]?.windows?.[0]?.usedPercent === 82,
      ),
      "Should emit normalized rate-limit snapshot",
    );

    session.close();
  });

  it("normalizes snake_case startup rate-limit snapshots into provider status", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("hello");
    const child = harness.children[0];
    child.stdin.on("data", (chunk) => {
      const lines = chunk.toString().trim().split("\n");
      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined || !msg.method) continue;
        if (msg.method === "initialize") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { userAgent: "codex-test/1.0" },
            }) + "\n",
          );
        } else if (msg.method === "thread/start") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                thread: {
                  id: "thread-001",
                  cwd: msg.params?.cwd ?? "/tmp",
                },
              },
            }) + "\n",
          );
        } else if (msg.method === "turn/start") {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
        } else if (msg.method === "account/read") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
              },
            }) + "\n",
          );
        } else if (msg.method === "account/rateLimits/read") {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                rate_limits: {
                  limit_id: "codex",
                  limit_name: null,
                  primary: { used_percent: 8, window_minutes: 300, resets_at: 1760000000 },
                  secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1760600000 },
                  plan_type: "plus",
                },
              },
            }) + "\n",
          );
        } else {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
        }
      }
    });

    await tick(50);

    const providerStatusEvents = systemEvents
      .map(([event]) => event)
      .filter((event) => event.event === "provider_status");
    const rateLimitEvent = providerStatusEvents.find(
      (event) => event.payload.account?.rateLimits?.[0]?.windows?.length === 2,
    );
    assert.ok(rateLimitEvent, "Should emit normalized snake_case rate-limit snapshot");
    assert.equal(rateLimitEvent.payload.account.rateLimits[0].plan, "plus");
    assert.equal(rateLimitEvent.payload.account.rateLimits[0].windows[0].windowMinutes, 300);
    assert.equal(rateLimitEvent.payload.account.rateLimits[0].windows[1].windowMinutes, 10080);

    session.close();
  });

  it("emits a session_init system event when a thread starts", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("hello");
    autoRespond(harness.children[0]);

    await tick(50);

    assert.equal(systemEvents.length, 1);
    assert.equal(systemEvents[0][0].type, "system_event");
    assert.equal(systemEvents[0][0].event, "session_init");
    assert.equal(systemEvents[0][0].payload.sessionId, "thread-001");
    assert.equal(systemEvents[0][0].payload.cwd, "/tmp/project");

    session.close();
  });

  it("passes collaborationMode=plan when runtimeMode='plan'", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      runtimeMode: "plan",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });

    session.send("plan this change");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    const msgs = child.getStdinMessages();
    const turnStart = msgs.find((m) => m.method === "turn/start");
    assert.equal(turnStart.params.collaborationMode.mode, "plan");
    assert.equal(turnStart.params.collaborationMode.settings.model, "gpt-5.4");

    session.close();
  });

  it("plan runtime mode produces sandboxed approvals + plan collaborationMode", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      runtimeMode: "plan",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });

    session.send("plan this change");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    const msgs = child.getStdinMessages();
    const threadStart = msgs.find((m) => m.method === "thread/start");
    const turnStart = msgs.find((m) => m.method === "turn/start");
    assert.equal(threadStart.params.approvalPolicy, "on-request");
    assert.equal(threadStart.params.sandbox, "workspace-write");
    assert.equal(turnStart.params.approvalPolicy, "on-request");
    assert.equal(turnStart.params.collaborationMode.mode, "plan");

    session.close();
  });

  it("writes-only runtime mode requests approval only for writes", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      runtimeMode: "writes-only",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });

    session.send("inspect this project");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    const msgs = child.getStdinMessages();
    assert.equal(msgs.find((m) => m.method === "thread/start").params.approvalPolicy, "writes");
    assert.equal(msgs.find((m) => m.method === "turn/start").params.approvalPolicy, "writes");
    session.close();
  });

  it("resumes an existing thread when resumeSessionId is provided", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      resumeSessionId: "thread-existing",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });

    session.send("continue");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    const msgs = child.getStdinMessages();
    const methods = msgs.filter((m) => m.method).map((m) => m.method);

    assert.ok(
      methods.includes("thread/resume"),
      "Should send thread/resume instead of thread/start",
    );
    assert.ok(!methods.includes("thread/start"), "Should NOT send thread/start");

    const threadResume = msgs.find((m) => m.method === "thread/resume");
    assert.equal(threadResume.params.threadId, "thread-existing");

    session.close();
  });

  it("streams text via agentMessage/delta notifications", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const outputs = collectEvents(session, "output");

    session.send("say hello");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    // Simulate streaming text
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "thread-001",
          turn: { id: "turn-1", items: [], status: "inProgress", error: null },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId: "thread-001", turnId: "turn-1", itemId: "msg-1", delta: "Hello" },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId: "thread-001", turnId: "turn-1", itemId: "msg-1", delta: " world!" },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-001",
          turn: { id: "turn-1", items: [], status: "completed", error: null },
        },
      }) + "\n",
    );

    await tick();

    // Find the streaming deltas (skip any from auto-respond)
    const textOutputs = outputs.filter(([o]) => o.text !== "");
    assert.ok(
      textOutputs.length >= 2,
      `Expected at least 2 text outputs, got ${textOutputs.length}`,
    );
    assert.equal(textOutputs[0][0].text, "Hello");
    assert.equal(textOutputs[1][0].text, " world!");

    // Should have a final isWaiting=true output
    const waitingOutputs = outputs.filter(([o]) => o.isWaiting === true);
    assert.ok(waitingOutputs.length >= 1, "Expected at least one isWaiting output");

    assert.equal(session.isProcessing, false);
    session.close();
  });

  it("normalizes proposed_plan blocks into ExitPlanMode activity during streaming", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const outputs = collectEvents(session, "output");
    const activities = collectEvents(session, "activity");

    session.send("make a plan");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "thread-001",
          turn: { id: "turn-1", items: [], status: "inProgress", error: null },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Before plan\n<proposed_",
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "plan>\n# Ship it\n- Step 1\n</proposed_plan>\nAfter plan",
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-001",
          turn: { id: "turn-1", items: [], status: "completed", error: null },
        },
      }) + "\n",
    );

    await tick();

    const textOutputs = outputs.filter(([o]) => o.text);
    assert.deepEqual(
      textOutputs.map(([o]) => o.text),
      ["Before plan\n", "\nAfter plan"],
    );

    const planActivity = activities.find(
      ([a]) => a.activity === "tool_use" && a.tool === "ExitPlanMode",
    );
    assert.ok(planActivity, "Expected an ExitPlanMode activity for proposed_plan");
    assert.equal(planActivity[0].description, "Plan ready");
    assert.equal(planActivity[0].input.plan, "# Ship it\n- Step 1");
  });

  it("maps command execution items to tool activities", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");

    session.send("run ls");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    // Simulate command execution
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "cmd-1",
            command: "ls -la",
            cwd: "/tmp/project",
            status: "inProgress",
            commandActions: [{ type: "listFiles", command: "ls -la", path: "/tmp/project" }],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "cmd-1",
            command: "ls -la",
            cwd: "/tmp/project",
            status: "completed",
            commandActions: [{ type: "listFiles", command: "ls -la", path: "/tmp/project" }],
            aggregatedOutput: "file1.ts\nfile2.ts\n",
            exitCode: 0,
            durationMs: 50,
          },
        },
      }) + "\n",
    );

    await tick();

    const toolUse = activities.find(([a]) => a.activity === "tool_use" && a.tool === "Bash");
    assert.ok(toolUse, "Expected a tool_use activity for Bash");
    assert.equal(toolUse[0].description, "List files in /tmp/project");
    assert.equal(toolUse[0].inputDescription, "List files in /tmp/project");
    assert.equal(toolUse[0].input.command, "ls -la");

    const toolResult = activities.find(([a]) => a.activity === "tool_result" && a.tool === "Bash");
    assert.ok(toolResult, "Expected a tool_result activity for Bash");
    assert.equal(toolResult[0].description, "Command completed");
  });

  it("preserves MCP server and tool identity in activities", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");

    session.send("search GitHub");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    for (const method of ["item/started", "item/completed"]) {
      child.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          params: {
            threadId: "thread-001",
            turnId: "turn-1",
            item: {
              type: "mcpToolCall",
              id: "mcp-1",
              server: "github",
              tool: "search_repositories",
              status: method === "item/started" ? "inProgress" : "completed",
              durationMs: method === "item/completed" ? 42 : null,
            },
          },
        }) + "\n",
      );
    }

    await tick();
    assert.deepEqual(activities[0][0].mcp, {
      serverId: "codex:github",
      serverName: "github",
      toolName: "search_repositories",
      callId: "mcp-1",
      durationMs: undefined,
    });
    assert.equal(activities[1][0].mcp.durationMs, 42);
  });

  it("tracks file changes from fileChange items", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");

    session.send("edit files");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            id: "fc-1",
            changes: [
              { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "+foo\n-bar" },
              { path: "src/new.ts", kind: { type: "add" }, diff: "new file\n" },
            ],
            status: "inProgress",
          },
        },
      }) + "\n",
    );

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            id: "fc-1",
            changes: [
              { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "+foo\n-bar" },
              { path: "src/new.ts", kind: { type: "add" }, diff: "new file\n" },
            ],
            status: "completed",
          },
        },
      }) + "\n",
    );

    await tick();

    // fileChange emits one activity per file, mapped by change kind
    const editActivities = activities.filter(
      ([a]) => a.activity === "tool_use" && a.tool === "Edit",
    );
    const writeActivities = activities.filter(
      ([a]) => a.activity === "tool_use" && a.tool === "Write",
    );
    assert.equal(editActivities.length, 1, "Expected 1 Edit activity for updated file");
    assert.equal(writeActivities.length, 1, "Expected 1 Write activity for added file");

    const [first] = editActivities[0];
    assert.equal(first.input.file_path, "src/app.ts");
    assert.equal(first.input.kind, "update");
    assert.equal(first.input.additions, 1);
    assert.equal(first.input.deletions, 1);
    assert.equal(first.input.extension, "ts");
    assert.equal(first.inputDescription, "app.ts");

    const [second] = writeActivities[0];
    assert.equal(second.input.file_path, "src/new.ts");
    assert.equal(second.input.kind, "add");
    assert.equal(second.input.additions, 1);
    assert.equal(second.input.deletions, 0);
    assert.equal(second.input.extension, "ts");
    assert.equal(second.input.content, "new file\n");
    assert.equal(second.description, "Writing file");

    const fileList = activities.find(([a]) => a.activity === "file_list");
    assert.ok(fileList, "Expected a file_list activity");
    assert.equal(fileList[0].files.length, 2);

    const appTs = fileList[0].files.find((f) => f.path === "src/app.ts");
    assert.ok(appTs);
    assert.equal(appTs.type, "edited");

    const newTs = fileList[0].files.find((f) => f.path === "src/new.ts");
    assert.ok(newTs);
    assert.equal(newTs.type, "added");
  });

  it("filters file changes outside the current workspace", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");

    session.send("edit files");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            id: "fc-1",
            changes: [
              { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "+foo\n-bar" },
              {
                path: "/Users/test/.claude/plans/session-plan.md",
                kind: { type: "update", move_path: null },
                diff: "+plan\n-old",
              },
            ],
            status: "completed",
          },
        },
      }) + "\n",
    );

    await tick();

    const fileList = activities.find(([a]) => a.activity === "file_list");
    assert.ok(fileList, "Expected a file_list activity");
    assert.equal(fileList[0].files.length, 1);
    assert.equal(fileList[0].files[0].path, "src/app.ts");
  });

  it("handles token usage notifications", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const statsEvents = collectEvents(session, "stats");

    session.send("hello");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 100,
              inputTokens: 60,
              cachedInputTokens: 10,
              outputTokens: 30,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 100,
              inputTokens: 60,
              cachedInputTokens: 10,
              outputTokens: 30,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 200000,
          },
        },
      }) + "\n",
    );

    await tick();

    assert.ok(statsEvents.length >= 1, "Expected at least one stats event");
    const lastStats = statsEvents[statsEvents.length - 1][0];
    assert.equal(lastStats.model, "gpt-5.4");
    assert.equal(lastStats.inputTokens, 60);
    assert.equal(lastStats.cacheReadTokens, 10);
    assert.equal(lastStats.outputTokens, 30);
    assert.equal(lastStats.contextTokens, 100);
    assert.equal(lastStats.contextWindow, 200000);
  });

  it("accepts snake_case token usage payloads from live notifications", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const statsEvents = collectEvents(session, "stats");

    session.send("hello");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          thread_id: "thread-001",
          turn_id: "turn-1",
          token_usage: {
            total_token_usage: {
              total_tokens: 100,
              input_tokens: 60,
              cached_input_tokens: 10,
              output_tokens: 30,
              reasoning_output_tokens: 5,
            },
            last_token_usage: {
              total_tokens: 100,
              input_tokens: 60,
              cached_input_tokens: 10,
              output_tokens: 30,
              reasoning_output_tokens: 5,
            },
            model_context_window: 200000,
          },
        },
      }) + "\n",
    );

    await tick();

    assert.ok(statsEvents.length >= 1, "Expected at least one stats event");
    const lastStats = statsEvents[statsEvents.length - 1][0];
    assert.equal(lastStats.model, "gpt-5.4");
    assert.equal(lastStats.inputTokens, 60);
    assert.equal(lastStats.cacheReadTokens, 10);
    assert.equal(lastStats.outputTokens, 30);
    assert.equal(lastStats.reasoningTokens, 5);
    assert.equal(lastStats.contextTokens, 100);
    assert.equal(lastStats.contextWindow, 200000);
  });

  it("emits task_list activity for turn/plan/updated notifications", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");

    session.send("make a plan");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/plan/updated",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          explanation: "Working plan",
          plan: [
            { step: "Inspect the code", status: "completed" },
            { step: "Apply the fix", status: "inProgress" },
            { step: "Run checks", status: "pending" },
          ],
        },
      }) + "\n",
    );

    await tick();

    const taskList = activities.find(([a]) => a.activity === "task_list");
    assert.ok(taskList, "Expected a task_list activity");
    assert.equal(taskList[0].description, "Working plan");
    assert.deepEqual(taskList[0].tasks, [
      { id: "plan-0", subject: "Inspect the code", status: "completed" },
      { id: "plan-1", subject: "Apply the fix", status: "in_progress" },
      { id: "plan-2", subject: "Run checks", status: "pending" },
    ]);
  });

  it("emits permissionRequest for command approval and routes response", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const permRequests = collectEvents(session, "permissionRequest");

    session.send("run something dangerous");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    // Server sends a requestApproval
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "rm -rf /",
          cwd: "/tmp",
        },
      }) + "\n",
    );

    await tick();

    assert.equal(permRequests.length, 1);
    assert.equal(permRequests[0][0].requestId, "codex-approval-42");
    assert.equal(permRequests[0][0].tool, "Bash");
    assert.equal(permRequests[0][0].description, "rm -rf /");

    // Respond to the request
    const responded = session.respondToRequest("codex-approval-42", "accept");
    assert.equal(responded, true);

    await tick();

    // Check that the response was sent to stdin
    const msgs = child.getStdinMessages();
    const rpcResponse = msgs.find((m) => m.id === 42 && m.result !== undefined && !m.method);
    assert.ok(rpcResponse, "Expected an RPC response for the approval");
    assert.equal(rpcResponse.result.decision, "accept");
  });

  it("emits request_user_input prompts and routes structured answers", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const requests = collectEvents(session, "permissionRequest");
    const activities = collectEvents(session, "activity");

    session.send("ask me a question");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          itemId: "call-1",
          questions: [
            {
              id: "color",
              header: "Palette",
              question: "Pick a color",
              isOther: true,
              options: [
                { label: "Blue", description: "Recommended" },
                { label: "Green", description: "Alternative" },
              ],
            },
          ],
        },
      }) + "\n",
    );

    await tick();

    assert.equal(requests.length, 1);
    assert.equal(requests[0][0].kind, "user_input");
    assert.equal(requests[0][0].requestId, "codex-input-call-1");
    assert.equal(requests[0][0].questions[0].question, "Pick a color");

    const promptActivity = activities.find(([a]) => a.activity === "tool_use");
    assert.ok(promptActivity, "Expected a tool_use activity for request_user_input");
    assert.equal(promptActivity[0].tool, "AskUserQuestion");
    assert.equal(promptActivity[0].input.requestId, "codex-input-call-1");

    const responded = session.respondToRequest("codex-input-call-1", "accept", {
      answers: {
        color: {
          answers: ["Blue"],
        },
      },
    });
    assert.equal(responded, true);

    await tick();

    const msgs = child.getStdinMessages();
    const rpcResponse = msgs.find((m) => m.id === 7 && m.result !== undefined && !m.method);
    assert.ok(rpcResponse, "Expected an RPC response for request_user_input");
    assert.deepEqual(rpcResponse.result, {
      answers: {
        color: {
          answers: ["Blue"],
        },
      },
    });

    const resolution = activities.find(
      ([a]) => a.activity === "tool_result" && a.tool === "AskUserQuestion",
    );
    assert.ok(resolution, "Expected a tool_result activity for request_user_input");
    assert.equal(resolution[0].resolution, "approved");
  });

  it("routes request_user_input free-text replies as an answer", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");

    session.send("ask me a question");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          itemId: "call-1",
          questions: [
            {
              id: "color",
              header: "Palette",
              question: "Pick a color",
              isOther: true,
              options: [
                { label: "Blue", description: "Recommended" },
                { label: "Green", description: "Alternative" },
              ],
            },
          ],
        },
      }) + "\n",
    );

    await tick();

    const responded = session.respondToRequest("codex-input-call-1", "accept", {
      answers: {},
      text: "Use purple instead.",
    });
    assert.equal(responded, true);

    await tick();

    const msgs = child.getStdinMessages();
    const rpcResponse = msgs.find((m) => m.id === 7 && m.result !== undefined && !m.method);
    assert.ok(rpcResponse, "Expected an RPC response for request_user_input");
    assert.deepEqual(rpcResponse.result, {
      answers: {
        color: {
          answers: ["Use purple instead."],
        },
      },
    });

    const resolution = activities.find(
      ([a]) => a.activity === "tool_result" && a.tool === "AskUserQuestion",
    );
    assert.ok(resolution, "Expected a tool_result activity for request_user_input");
    assert.equal(resolution[0].resolution, "approved");
  });

  it("maps generic permission approvals into Relay approval categories", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const requests = collectEvents(session, "permissionRequest");

    session.send("use provider permission");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 88,
        method: "item/permissions/requestApproval",
        params: {
          tool: "network",
          reason: "Needs network access",
          command: "curl https://example.com",
          cwd: "/tmp/project",
        },
      }) + "\n",
    );

    await tick();

    assert.equal(requests.length, 1);
    assert.equal(requests[0][0].kind, "approval");
    assert.equal(requests[0][0].category, "generic");
    assert.equal(requests[0][0].source, "provider");
    assert.equal(requests[0][0].command, "curl https://example.com");
  });

  it("maps MCP elicitation requests into user_input requests", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const requests = collectEvents(session, "permissionRequest");

    session.send("use MCP");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 91,
        method: "mcpServer/elicitation/request",
        params: {
          server: "github",
          prompt: "Pick a repository",
          questions: [
            {
              id: "repo",
              header: "Repository",
              question: "Which repository?",
              options: [{ label: "relay", description: "Current repo" }],
            },
          ],
        },
      }) + "\n",
    );

    await tick();

    assert.equal(requests.length, 1);
    assert.equal(requests[0][0].kind, "user_input");
    assert.equal(requests[0][0].source, "mcp");
    assert.equal(requests[0][0].tool, "MCP");
    assert.equal(requests[0][0].server, "github");
  });

  it("maps plain-text MCP elicitation into synthesized user_input", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const requests = collectEvents(session, "permissionRequest");

    session.send("use MCP");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 92,
        method: "mcpServer/elicitation/request",
        params: {
          server: "github",
          prompt: "Enter repository name",
        },
      }) + "\n",
    );

    await tick();

    assert.equal(requests.length, 1);
    assert.equal(requests[0][0].kind, "user_input");
    assert.equal(requests[0][0].source, "mcp");
    assert.equal(requests[0][0].questions?.length, 1);
    assert.equal(requests[0][0].questions?.[0]?.question, "Enter repository name");
    assert.equal(requests[0][0].questions?.[0]?.isOther, true);
  });

  it("maps terminal interaction requests into terminal_input requests", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const requests = collectEvents(session, "permissionRequest");

    session.send("run prompting command");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/commandExecution/terminalInteraction",
        params: {
          itemId: "cmd-44",
          command: "pnpm db:migrate",
          cwd: "/tmp/project",
          prompt: "Proceed with migration? [y/N]",
        },
      }) + "\n",
    );

    await tick();

    assert.equal(requests.length, 1);
    assert.equal(requests[0][0].kind, "terminal_input");
    assert.equal(requests[0][0].category, "command");
    assert.equal(requests[0][0].source, "command");
    assert.equal(requests[0][0].prompt, "Proceed with migration? [y/N]");
  });

  it("ignores empty terminal interaction notifications", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const requests = collectEvents(session, "permissionRequest");

    session.send("run command");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/commandExecution/terminalInteraction",
        params: {
          itemId: "cmd-45",
          command: "pnpm typecheck",
          cwd: "/tmp/project",
        },
      }) + "\n",
    );

    await tick();

    assert.equal(requests.length, 0);
  });

  it("emits explicit provider status for MCP, account, and live diff updates", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("status updates");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "mcpServerStatus/list",
        params: {
          servers: [
            { name: "github", status: "connected", authStatus: "authenticated", connected: true },
          ],
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "account/rateLimits/updated",
        params: {
          account: {
            label: "Plus",
            email: "user@example.com",
            rateLimits: [{ name: "gpt-5.4", remaining: 42, limit: 100 }],
          },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/diff/updated",
        params: {
          status: "inProgress",
          changedFiles: 3,
          summary: "3 files changed",
        },
      }) + "\n",
    );

    await tick();

    const providerStatusEvents = systemEvents
      .map(([event]) => event)
      .filter((event) => event.event === "provider_status");
    assert.ok(providerStatusEvents.length >= 3);
    assert.deepEqual(providerStatusEvents[0].payload.mcpServers, [
      {
        id: "codex:github",
        name: "github",
        provider: "codex",
        scope: "global",
        source: "provider",
        configured: true,
        connectionState: "connected",
        authentication: { method: "unknown", login: true, logout: true },
        tools: undefined,
        status: "connected",
        authStatus: "authenticated",
        connected: true,
        toolCount: undefined,
        detail: undefined,
      },
    ]);
    assert.equal(providerStatusEvents[1].payload.account.label, "Plus");
    assert.equal(providerStatusEvents[1].payload.account.rateLimits[0].windows[0].remaining, 42);
    assert.equal(providerStatusEvents[2].payload.diff.changedFiles, 3);
  });

  it("normalizes snake_case live rate-limit updates into window entries", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("status updates");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "account/rateLimits/updated",
        params: {
          account: {
            label: "Plus",
            email: "user@example.com",
          },
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 8, window_minutes: 300, resets_at: 1760000000 },
            secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1760600000 },
            plan_type: "plus",
          },
        },
      }) + "\n",
    );

    await tick();

    const providerStatusEvents = systemEvents
      .map(([event]) => event)
      .filter((event) => event.event === "provider_status");
    const rateLimitEvent = providerStatusEvents.find(
      (event) => event.payload.account?.rateLimits?.[0]?.windows?.length === 2,
    );
    assert.ok(rateLimitEvent, "Expected normalized live rate-limit windows");
    assert.equal(rateLimitEvent.payload.account.label, "Plus");
    assert.equal(rateLimitEvent.payload.account.rateLimits[0].plan, "plus");
    assert.equal(rateLimitEvent.payload.account.rateLimits[0].windows[0].windowMinutes, 300);
    assert.equal(rateLimitEvent.payload.account.rateLimits[0].windows[1].windowMinutes, 10080);
  });

  it("emits reroute and notice system events with normalized payloads", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4-mini",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("reroute me");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "model/rerouted",
        params: {
          requestedModel: "gpt-5.4-mini",
          effectiveModel: "gpt-5.4",
          message: "Fallback applied",
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "configWarning",
        params: {
          message: "GitHub MCP requires re-authentication",
          detail: "Reconnect to continue using GitHub tools.",
        },
      }) + "\n",
    );

    await tick();

    const reroute = systemEvents
      .map(([event]) => event)
      .find((event) => event.event === "model_rerouted");
    assert.ok(reroute);
    assert.equal(reroute.payload.requestedModel, "gpt-5.4-mini");
    assert.equal(reroute.payload.effectiveModel, "gpt-5.4");

    const notice = systemEvents
      .map(([event]) => event)
      .find((event) => event.event === "provider_notice");
    assert.ok(notice);
    assert.equal(notice.payload.message, "GitHub MCP requires re-authentication");
    assert.equal(notice.payload.scope, "global");
  });

  it("auto-approves when runtimeMode is full-access", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      runtimeMode: "full-access",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const permRequests = collectEvents(session, "permissionRequest");

    session.send("run something");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    // Server sends a requestApproval
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "dangerous-cmd",
        },
      }) + "\n",
    );

    await tick();

    // Should NOT emit permissionRequest (auto-approved)
    assert.equal(
      permRequests.length,
      0,
      "Should not emit permissionRequest when bypass is enabled",
    );

    // Check that the approval was sent automatically
    const msgs = child.getStdinMessages();
    const rpcResponse = msgs.find((m) => m.id === 99 && m.result !== undefined && !m.method);
    assert.ok(rpcResponse, "Expected an auto-approval RPC response");
    assert.equal(rpcResponse.result.decision, "accept");
  });

  it("auto-approves a pending approval when bypass is enabled mid-turn", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const permRequests = collectEvents(session, "permissionRequest");

    session.send("run something");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-001",
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "dangerous-cmd",
        },
      }) + "\n",
    );

    await tick();

    assert.equal(permRequests.length, 1);

    session.setRuntimeMode("full-access");

    await tick();

    const msgs = child.getStdinMessages();
    const rpcResponse = msgs.find((m) => m.id === 101 && m.result !== undefined && !m.method);
    assert.ok(rpcResponse, "Expected a pending approval to be auto-approved");
    assert.equal(rpcResponse.result.decision, "accept");
  });

  it("reuses persistent connection for multiple turns", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });

    session.send("first message");
    const child = harness.children[0];
    autoRespond(child);

    await tick(50);

    // Complete the first turn
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-001",
          turn: { id: "turn-1", items: [], status: "completed", error: null },
        },
      }) + "\n",
    );

    await tick();

    assert.equal(session.isProcessing, false);

    // Send second message — should NOT spawn a new process
    session.send("second message");

    await tick(50);

    assert.equal(harness.spawns.length, 1, "Should reuse same process, not spawn another");

    // Check that a second turn/start was sent
    const msgs = child.getStdinMessages();
    const turnStarts = msgs.filter((m) => m.method === "turn/start");
    assert.equal(turnStarts.length, 2, "Expected two turn/start messages");
    assert.equal(turnStarts[1].params.input[0].text, "second message");

    session.close();
  });

  it("keeps a long-running turn alive while the app-server is still streaming activity", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
      processTimeout: 40,
    });

    session.send("slow task");
    const child = harness.children[0];
    autoRespond(child);

    await tick(15);

    for (let i = 0; i < 3; i += 1) {
      child.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { delta: `chunk-${i}` },
        }) + "\n",
      );
      await tick(25);
      assert.equal(child.killed, false, "Expected streamed activity to refresh the timeout");
    }

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: { id: "turn-1", items: [], status: "completed", error: null },
        },
      }) + "\n",
    );

    await tick(10);

    assert.equal(session.isProcessing, false);
    assert.equal(child.killed, false);

    session.close();
  });

  it("times out an idle turn when the app-server stops responding", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
      processTimeout: 30,
    });

    session.send("stall");
    const child = harness.children[0];
    autoRespond(child);

    await tick(140);

    assert.equal(child.killed, true, "Expected idle turn to be closed after the timeout");
    child.emit("close", 137, "SIGKILL");
    await tick(10);
    assert.equal(session.isProcessing, false);
  });

  it("accumulates item/plan/delta into ExitPlanMode activity on turn complete", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      runtimeMode: "plan",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");
    const outputs = collectEvents(session, "output");

    session.send("plan this");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    // Simulate plan deltas
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: { delta: "# Step 1\n" },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: { delta: "Do the thing\n" },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: { delta: "# Step 2\nDo the other thing" },
      }) + "\n",
    );

    // Plan deltas should NOT emit output (accumulate silently)
    const textOutputsBefore = outputs.filter(([o]) => o.text && o.text.includes("Step 1"));
    assert.equal(textOutputsBefore.length, 0, "Plan deltas should not stream as output");

    // Complete the turn
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", items: [], status: "completed", error: null } },
      }) + "\n",
    );

    await tick();

    // Should have emitted an ExitPlanMode activity
    const exitPlan = activities.filter(([a]) => a.tool === "ExitPlanMode");
    assert.equal(exitPlan.length, 1, "Should emit one ExitPlanMode activity");
    assert.ok(exitPlan[0][0].input.plan.includes("Step 1"));
    assert.ok(exitPlan[0][0].input.plan.includes("Step 2"));

    session.close();
  });

  it("deduplicates identical plan content across turns", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      runtimeMode: "plan",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");

    session.send("plan this");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    const planText = "# The Plan\nDo all the things";

    // First turn: emit plan
    child.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "item/plan/delta", params: { delta: planText } }) +
        "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", items: [], status: "completed", error: null } },
      }) + "\n",
    );
    await tick();

    assert.equal(
      activities.filter(([a]) => a.tool === "ExitPlanMode").length,
      1,
      "First turn should emit ExitPlanMode",
    );

    // Second turn: same plan content again (Codex re-emitting after approval)
    session.send("go ahead");
    await tick(50);

    child.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "item/plan/delta", params: { delta: planText } }) +
        "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-2", items: [], status: "completed", error: null } },
      }) + "\n",
    );
    await tick();

    // Should NOT emit a second ExitPlanMode since plan is identical
    assert.equal(
      activities.filter(([a]) => a.tool === "ExitPlanMode").length,
      1,
      "Duplicate plan should not emit another ExitPlanMode",
    );

    session.close();
  });

  it("queues messages sent while processing and flushes after turn", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });

    session.send("first");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    // Session is now processing. Send a second message — should be queued, not dropped.
    session.send("second");

    // Complete first turn
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", items: [], status: "completed", error: null } },
      }) + "\n",
    );
    await tick(50);

    // The queued message should have triggered a second turn/start
    const msgs = child.getStdinMessages();
    const turnStarts = msgs.filter((m) => m.method === "turn/start");
    assert.equal(turnStarts.length, 2, "Queued message should trigger second turn");
    assert.equal(turnStarts[1].params.input[0].text, "second");

    session.close();
  });

  it("clears plan delta buffer when starting a new turn", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      runtimeMode: "plan",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");

    session.send("plan this");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    // First turn with plan deltas, but turn completes without plan content
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { delta: "Let me think about this..." },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", items: [], status: "completed", error: null } },
      }) + "\n",
    );
    await tick();

    // No plan deltas → no ExitPlanMode
    assert.equal(
      activities.filter(([a]) => a.tool === "ExitPlanMode").length,
      0,
      "No plan deltas means no ExitPlanMode",
    );

    // Second turn with actual plan deltas
    session.send("now plan it");
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: { delta: "# Actual Plan" },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-2", items: [], status: "completed", error: null } },
      }) + "\n",
    );
    await tick();

    // Should only have the second turn's plan
    const exitPlans = activities.filter(([a]) => a.tool === "ExitPlanMode");
    assert.equal(exitPlans.length, 1);
    assert.ok(exitPlans[0][0].input.plan.includes("Actual Plan"));
    assert.ok(!exitPlans[0][0].input.plan.includes("think about"));

    session.close();
  });

  it("emits a compact boundary system event for raw compaction items", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("/compact");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-compact", status: "inProgress" } },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-001",
          turnId: "turn-compact",
          item: {
            type: "compaction",
            encrypted_content: "opaque",
          },
        },
      }) + "\n",
    );
    await tick();

    const compactEvents = systemEvents
      .map(([event]) => event)
      .filter((event) => event.event === "compact_boundary");
    assert.equal(compactEvents.length, 1);
    assert.equal(compactEvents[0].type, "system_event");
    assert.equal(compactEvents[0].event, "compact_boundary");
    assert.equal(compactEvents[0].payload.turnId, "turn-compact");

    session.close();
  });

  it("dedupes thread/compacted when raw compaction already arrived", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const systemEvents = collectEvents(session, "systemEvent");

    session.send("/compact");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-compact", status: "inProgress" } },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-001",
          turnId: "turn-compact",
          item: {
            type: "compaction",
            encrypted_content: "opaque",
          },
        },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/compacted",
        params: {
          threadId: "thread-001",
          turnId: "turn-compact",
        },
      }) + "\n",
    );
    await tick();

    const compactEvents = systemEvents
      .map(([event]) => event)
      .filter((event) => event.event === "compact_boundary");
    assert.equal(compactEvents.length, 1);
    assert.equal(compactEvents[0].event, "compact_boundary");

    session.close();
  });

  it("starts native thread compaction over RPC", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
      resumeSessionId: "thread-compactable",
    });

    session.send("hello");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", items: [], status: "completed", error: null } },
      }) + "\n",
    );
    await tick(50);

    session.compactThread();
    await tick(50);

    const msgs = child.getStdinMessages();
    const compactStart = msgs.find((m) => m.method === "thread/compact/start");
    assert.ok(compactStart, "Should send thread/compact/start");
    assert.equal(compactStart.params.threadId, "thread-compactable");

    session.close();
  });

  it("respawns and resumes before native compaction when the app-server stdin is no longer writable", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
      resumeSessionId: "thread-compactable",
    });

    session.send("hello");
    const firstChild = harness.children[0];
    autoRespond(firstChild);
    await tick(50);

    firstChild.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", items: [], status: "completed", error: null } },
      }) + "\n",
    );
    await tick(50);

    firstChild.stdin.end();
    await tick();

    session.compactThread();
    const secondChild = harness.children[1];
    autoRespond(secondChild);
    await tick(50);

    assert.equal(harness.spawns.length, 2);
    const methods = secondChild
      .getStdinMessages()
      .filter((m) => m.method)
      .map((m) => m.method);

    const initializeIndex = methods.indexOf("initialize");
    const initializedIndex = methods.indexOf("initialized");
    const resumeIndex = methods.indexOf("thread/resume");
    const compactIndex = methods.indexOf("thread/compact/start");
    assert.ok(initializeIndex !== -1);
    assert.ok(initializedIndex > initializeIndex);
    assert.ok(resumeIndex > initializedIndex);
    assert.ok(compactIndex > resumeIndex);

    const compactStart = secondChild
      .getStdinMessages()
      .find((m) => m.method === "thread/compact/start");
    assert.ok(compactStart, "Should send thread/compact/start after respawn");
    assert.equal(compactStart.params.threadId, "thread-compactable");

    session.close();
  });
});

describe("code-mode tool activities", () => {
  it("preserves dynamic exec input and output", async () => {
    const harness = createHarness();
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      spawnProcess: harness.spawnProcess,
      codexPath: "codex",
    });
    const activities = collectEvents(session, "activity");
    session.send("inspect files");
    const child = harness.children[0];
    autoRespond(child);
    await tick(50);
    const code = 'text(await tools.exec_command({cmd: "ls"}));';
    for (const method of ["item/started", "item/completed"]) {
      child.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          params: {
            threadId: "thread-001",
            turnId: "turn-1",
            item: {
              type: "dynamicToolCall",
              id: "exec-1",
              tool: "exec",
              arguments: code,
              status: method === "item/started" ? "inProgress" : "completed",
              contentItems: [{ type: "text", text: "file.ts" }],
              success: true,
            },
          },
        }) + "\n",
      );
    }
    await tick();
    const use = activities.find(([a]) => a.activity === "tool_use")?.[0];
    const result = activities.find(([a]) => a.activity === "tool_result")?.[0];
    assert.equal(use?.tool, "ExecuteCode");
    assert.deepEqual(use?.input, { code });
    assert.equal(result?.toolUseId, use?.toolUseId);
    assert.equal(result?.detail, "file.ts");
    session.close();
  });
});
