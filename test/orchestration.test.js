// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Relay orchestration (cross-chat MCP tools), phase 1:
 *  - the transport-agnostic MCP JSON-RPC handler
 *  - per-chat bearer credentials
 *  - the bounded chat timeline `chat_read` returns
 *  - tool policy (account/project scoping) against a fake host
 *  - provider injection (Claude SDK options, Codex argv/env/instructions)
 *  - the `/mcp` HTTP route and the manager's caller resolution
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import {
  handleMcpPayload,
  McpToolError,
  MCP_LATEST_PROTOCOL_VERSION,
} from "../dist/server/core/orchestration/mcp-protocol.js";
import {
  OrchestrationCredentials,
  parseBearerToken,
} from "../dist/server/core/orchestration/credentials.js";
import {
  buildChatView,
  CHAT_VIEW_ITEM_MAX_CHARS,
  CHAT_VIEW_PAGE_MAX_CHARS,
} from "../dist/server/core/orchestration/chat-view.js";
import {
  createRelayMcpServer,
  parseChatReference,
} from "../dist/server/core/orchestration/tools.js";
import {
  RELAY_MCP_TOKEN_ENV,
  RELAY_ORCHESTRATION_INSTRUCTIONS,
  withoutRelayMcpServer,
} from "../dist/server/core/orchestration/instructions.js";
import {
  buildCodexAppServerArgs,
  CodexAppServerSession,
} from "../dist/server/core/providers/codex-app-server.js";
import {
  getProviderCapabilities,
  getProviderDriver,
} from "../dist/server/core/provider-registry.js";
import { registerMcpRoutes } from "../dist/server/routes/mcp.js";
import { relayMcpUrl } from "../dist/server/index.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import { noopLogger } from "../dist/server/core/logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function chat(overrides = {}) {
  return {
    id: "chat-a",
    provider: "claude",
    name: "Chat A",
    workingDirectory: "/repo",
    status: "idle",
    createdAt: 1_000,
    lastActivityAt: 2_000,
    projectId: "proj-1",
    ...overrides,
  };
}

function fakeHost({ chats, projects, histories = {}, providers = [], accounts = ["default"] }) {
  const byId = new Map(chats.map((c) => [c.id, c]));
  return {
    getChat: (id) => byId.get(id),
    listProjectChats: (projectId) => chats.filter((c) => c.projectId === projectId),
    getProject: (id) => projects.find((p) => p.id === id),
    getHistory: (id) => {
      if (!histories[id]) throw new Error("not found");
      return histories[id];
    },
    accountIdOf: (c) => (c.accountId && accounts.includes(c.accountId) ? c.accountId : "default"),
    listProviders: async () => providers,
  };
}

const server = createRelayMcpServer("test");

async function call(ctx, name, args = {}) {
  const response = await handleMcpPayload(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    server,
    ctx,
  );
  return response.result;
}

const user = (text, extra = {}) => ({ timestamp: 1, message: { type: "user", text, ...extra } });
const assistant = (text, extra = {}) => ({
  timestamp: 2,
  message: { type: "output", text, isWaiting: false, ...extra },
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

describe("MCP protocol", () => {
  it("negotiates the protocol version and advertises tools + instructions", async () => {
    const known = await handleMcpPayload(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      server,
      {},
    );
    assert.equal(known.result.protocolVersion, "2025-06-18");
    assert.equal(known.result.serverInfo.name, "relay");
    assert.ok(known.result.capabilities.tools);
    assert.ok(known.result.instructions);

    const unknown = await handleMcpPayload(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      server,
      {},
    );
    assert.equal(unknown.result.protocolVersion, MCP_LATEST_PROTOCOL_VERSION);
  });

  it("lists read-only tools with schemas", async () => {
    const res = await handleMcpPayload({ jsonrpc: "2.0", id: 1, method: "tools/list" }, server, {});
    const names = res.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["relay_capabilities", "chat_list", "chat_read"]);
    for (const tool of res.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.annotations.readOnlyHint, true);
    }
  });

  it("answers notifications with nothing and rejects garbage and unknown methods", async () => {
    assert.equal(
      await handleMcpPayload({ jsonrpc: "2.0", method: "notifications/initialized" }, server, {}),
      null,
    );
    assert.equal(await handleMcpPayload([{ jsonrpc: "2.0", method: "x" }], server, {}), null);
    assert.equal((await handleMcpPayload({ hello: 1 }, server, {})).error.code, -32600);
    assert.equal(
      (await handleMcpPayload({ jsonrpc: "2.0", id: 3, method: "nope" }, server, {})).error.code,
      -32601,
    );
    const badTool = await handleMcpPayload(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "missing" } },
      server,
      {},
    );
    assert.equal(badTool.error.code, -32602);
  });

  it("returns expected tool failures as typed isError results, and hides unexpected ones", async () => {
    const tools = [
      {
        name: "typed",
        description: "",
        inputSchema: { type: "object" },
        handler() {
          throw new McpToolError("chat_not_found", "nope");
        },
      },
      {
        name: "boom",
        description: "",
        inputSchema: { type: "object" },
        handler() {
          throw new Error("secret internals");
        },
      },
    ];
    const def = { name: "t", version: "1", tools };
    const errors = [];
    const typed = await handleMcpPayload(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "typed" } },
      def,
      {},
    );
    assert.equal(typed.result.isError, true);
    assert.deepEqual(typed.result.structuredContent.error, {
      code: "chat_not_found",
      message: "nope",
    });
    const boom = await handleMcpPayload(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "boom" } },
      def,
      {},
      (e) => errors.push(e),
    );
    assert.equal(boom.result.isError, true);
    assert.equal(boom.result.structuredContent.error.code, "orchestration_error");
    assert.doesNotMatch(boom.result.content[0].text, /secret internals/);
    assert.equal(errors.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("orchestration credentials", () => {
  it("issues one token per chat; reissuing or revoking invalidates the old one", () => {
    const creds = new OrchestrationCredentials();
    const first = creds.issue("chat-a");
    assert.equal(creds.resolve(first), "chat-a");
    const second = creds.issue("chat-a");
    assert.notEqual(first, second);
    assert.equal(creds.resolve(first), undefined);
    assert.equal(creds.resolve(second), "chat-a");
    creds.issue("chat-b");
    assert.equal(creds.size, 2);
    creds.revoke("chat-a");
    assert.equal(creds.resolve(second), undefined);
    creds.revokeAll();
    assert.equal(creds.size, 0);
    assert.equal(creds.resolve(undefined), undefined);
  });

  it("parses bearer headers strictly", () => {
    assert.equal(parseBearerToken("Bearer abc"), "abc");
    assert.equal(parseBearerToken("bearer abc "), "abc");
    assert.equal(parseBearerToken("Basic abc"), undefined);
    assert.equal(parseBearerToken("Bearer a b"), undefined);
    assert.equal(parseBearerToken(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// Chat view
// ---------------------------------------------------------------------------

describe("chat view", () => {
  it("keeps the conversation and drops injections, child-agent lines, and queue placeholders", () => {
    const history = [
      user("Codebase and user instructions are shown below. blah\n\nUser request:\nreal ask"),
      user("hidden", { internal: true }),
      user("queued", { queued: true }),
      user("child assignment", { agentId: "agent-1" }),
      {
        timestamp: 3,
        message: { type: "activity", activity: "tool_use", tool: "Read", description: "Read a.ts" },
      },
      assistant("child prose", { agentId: "agent-1" }),
      assistant("answer"),
      user("report", { author: { kind: "agent", name: "reviewer" } }),
    ];
    const view = buildChatView(history);
    assert.deepEqual(
      view.items.map((i) => [i.cursor, i.role, i.text, i.author]),
      [
        ["1.0", "user", "real ask", undefined],
        ["2.1", "assistant", "answer", undefined],
        ["1.4", "agent", "report", "reviewer"],
      ],
    );
    const activity = buildChatView(history, { view: "activity" });
    assert.ok(activity.items.some((i) => i.role === "tool" && i.text === "Read: Read a.ts"));
  });

  it("pages from the end by default and incrementally with a cursor", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      timestamp: 100 + i,
      message: { type: "output", text: `m${i}`, isWaiting: false },
    }));
    const tail = buildChatView(history, { limit: 3 });
    assert.deepEqual(
      tail.items.map((i) => i.text),
      ["m7", "m8", "m9"],
    );
    assert.equal(tail.hasEarlier, true);
    assert.equal(tail.nextCursor, "109.0");

    const forward = buildChatView(history, { after: "102.0", limit: 3 });
    assert.deepEqual(
      forward.items.map((i) => i.text),
      ["m3", "m4", "m5"],
    );
    assert.equal(forward.hasMore, true);
    assert.equal(forward.nextCursor, "105.0");

    const caughtUp = buildChatView(history, { after: "109.0" });
    assert.deepEqual(caughtUp.items, []);
    assert.equal(caughtUp.nextCursor, "109.0", "an empty incremental read keeps the cursor");

    assert.throws(() => buildChatView(history, { after: "nope" }), /Invalid chat cursor/);
  });

  it("keeps cursors valid when old history is trimmed", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      timestamp: 100 + i,
      message: { type: "output", text: `m${i}`, isWaiting: false },
    }));
    const page = buildChatView(history, { after: "104.0", limit: 2 });
    assert.deepEqual(
      page.items.map((i) => i.text),
      ["m5", "m6"],
    );
    // The in-memory ring drops its oldest entries; the cursor still resumes at m7.
    const trimmed = history.slice(6);
    const next = buildChatView(trimmed, { after: page.nextCursor, limit: 2 });
    assert.deepEqual(
      next.items.map((i) => i.text),
      ["m7", "m8"],
    );
    // A cursor whose own entry was trimmed resumes at the next newer item.
    const gone = buildChatView(trimmed, { after: "103.0", limit: 1 });
    assert.deepEqual(
      gone.items.map((i) => i.text),
      ["m6"],
    );
  });

  it("disambiguates entries that share a timestamp", () => {
    const history = [assistant("a"), assistant("b"), assistant("c")];
    const page = buildChatView(history, { after: "2.0" });
    assert.deepEqual(
      page.items.map((i) => [i.cursor, i.text]),
      [
        ["2.1", "b"],
        ["2.2", "c"],
      ],
    );
  });

  it("truncates long items and caps a page's total text", () => {
    const long = "x".repeat(CHAT_VIEW_ITEM_MAX_CHARS + 50);
    const view = buildChatView([assistant(long)]);
    assert.equal(view.items[0].truncated, true);
    assert.ok(view.items[0].text.length <= CHAT_VIEW_ITEM_MAX_CHARS + 1);

    const many = Array.from({ length: 40 }, () => assistant(long));
    const page = buildChatView(many, { limit: 40 });
    const total = page.items.reduce((sum, i) => sum + i.text.length, 0);
    assert.ok(total <= CHAT_VIEW_PAGE_MAX_CHARS);
    assert.equal(page.hasEarlier, true, "dropped items stay reachable");
    assert.equal(page.items.at(-1).cursor, "2.39", "the newest items survive a tail read");
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe("orchestration tools", () => {
  const projects = [
    { id: "proj-1", name: "Relay", accountIds: ["default"] },
    { id: "proj-2", name: "Other", accountIds: ["default"] },
    { id: "proj-work", name: "Work", accountIds: ["work"] },
  ];
  const chats = [
    chat({ id: "caller", name: "Caller", lastActivityAt: 5_000 }),
    chat({ id: "older", name: "Older chat", lastActivityAt: 1_000 }),
    chat({ id: "done", name: "Done chat", lastActivityAt: 1_500, doneAt: 1_500 }),
    chat({ id: "work-chat", name: "Work secret", accountId: "work", lastActivityAt: 9_000 }),
    chat({ id: "elsewhere", name: "Elsewhere", projectId: "proj-2" }),
    chat({ id: "work-project-chat", projectId: "proj-work", accountId: "work" }),
  ];
  const host = fakeHost({
    chats,
    projects,
    accounts: ["default", "work"],
    histories: { older: [user("hi"), assistant("hello")] },
    providers: [
      {
        provider: "claude",
        label: "Claude",
        available: true,
        models: Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, label: `M${i}` })),
      },
      {
        provider: "codex",
        label: "Codex",
        available: false,
        unavailableReason: "No login",
        models: [],
      },
    ],
  });
  const ctx = { host, callerId: "caller" };

  it("chat_list lists the caller's project in its account only, newest first, without done chats", async () => {
    const result = (await call(ctx, "chat_list")).structuredContent;
    assert.deepEqual(
      result.chats.map((c) => c.id),
      ["caller", "older"],
    );
    assert.equal(result.chats[0].isCaller, true);
    assert.equal(result.chats[0].link, "relay://chat/caller");

    const withDone = (await call(ctx, "chat_list", { includeDone: true })).structuredContent;
    assert.ok(withDone.chats.some((c) => c.id === "done" && c.done));

    const filtered = (await call(ctx, "chat_list", { query: "OLDER" })).structuredContent;
    assert.deepEqual(
      filtered.chats.map((c) => c.id),
      ["older"],
    );

    const other = (await call(ctx, "chat_list", { projectId: "proj-2" })).structuredContent;
    assert.deepEqual(
      other.chats.map((c) => c.id),
      ["elsewhere"],
    );
  });

  it("chat_list refuses a project outside the caller's account", async () => {
    const result = await call(ctx, "chat_list", { projectId: "proj-work" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "project_not_found");
  });

  it("chat_read accepts ids and links, and treats other accounts' chats as missing", async () => {
    const byLink = (await call(ctx, "chat_read", { chatId: "relay://chat/older" }))
      .structuredContent;
    assert.equal(byLink.chat.id, "older");
    assert.deepEqual(
      byLink.items.map((i) => i.text),
      ["hi", "hello"],
    );

    const foreign = await call(ctx, "chat_read", { chatId: "work-chat" });
    assert.equal(foreign.structuredContent.error.code, "chat_not_found");

    const missing = await call(ctx, "chat_read", { chatId: "caller" });
    assert.equal(missing.structuredContent.error.code, "chat_not_found", "no readable history");

    const bad = await call(ctx, "chat_read", { chatId: "older", view: "everything" });
    assert.equal(bad.structuredContent.error.code, "invalid_request");
  });

  it("relay_capabilities describes the caller and caps each provider's model list", async () => {
    const result = (await call(ctx, "relay_capabilities")).structuredContent;
    assert.equal(result.caller.id, "caller");
    assert.equal(result.project.name, "Relay");
    const claude = result.providers.find((p) => p.provider === "claude");
    assert.equal(claude.models.length, 12);
    assert.equal(claude.omittedModels, 3);
    const codex = result.providers.find((p) => p.provider === "codex");
    assert.equal(codex.available, false);
    assert.equal(codex.unavailableReason, "No login");
  });

  it("fails cleanly when the calling chat is gone", async () => {
    const result = await call({ host, callerId: "deleted" }, "chat_list");
    assert.equal(result.structuredContent.error.code, "caller_not_found");
  });

  it("parses chat references", () => {
    assert.equal(parseChatReference("relay://chat/abc"), "abc");
    assert.equal(parseChatReference("<relay://chat/abc>"), "abc");
    assert.equal(parseChatReference(" abc "), "abc");
  });
});

// ---------------------------------------------------------------------------
// Provider injection
// ---------------------------------------------------------------------------

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

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.pid = 1;
    this.exitCode = null;
    this.writes = [];
    const write = this.stdin.write.bind(this.stdin);
    this.stdin.write = (data) => {
      this.writes.push(data.toString());
      return write(data);
    };
  }
  kill() {
    return true;
  }
}

describe("provider injection", () => {
  const relayMcp = { url: "http://127.0.0.1:4321/mcp", token: "tok-123" };
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("both drivers advertise the capability", () => {
    assert.equal(getProviderCapabilities("claude").supportsRelayOrchestration, true);
    assert.equal(getProviderCapabilities("codex").supportsRelayOrchestration, true);
  });

  it("Claude sessions get the HTTP server, an env-referenced token, and the guidance — resumes included", () => {
    const captured = [];
    const context = {
      providerDirs: { claude: "/tmp/c", codex: "/tmp/x" },
      logger: noopLogger,
      sdkQueryFn: stubSdkQuery(captured),
    };
    const config = resolveConfig({ logger: noopLogger, workingDirectory: "/tmp" });
    const driver = getProviderDriver("claude");

    const fresh = driver.createSession(config, { relayMcp }, context);
    cleanups.push(() => fresh.close());
    assert.deepEqual(captured[0].mcpServers, {
      relay: {
        type: "http",
        url: relayMcp.url,
        headers: { Authorization: "Bearer ${RELAY_MCP_TOKEN}" },
      },
    });
    // mcpServers becomes `--mcp-config` argv; the token itself rides in the env.
    assert.ok(!JSON.stringify(captured[0].mcpServers).includes("tok-123"));
    assert.equal(captured[0].env.RELAY_MCP_TOKEN, "tok-123");
    assert.match(captured[0].systemPrompt.append, /## Relay orchestration/);
    assert.match(captured[0].systemPrompt.append, /ToolSearch/);

    const resumed = driver.createSession(config, { relayMcp, resumeSessionId: "s-1" }, context);
    cleanups.push(() => resumed.close());
    assert.ok(captured[1].mcpServers.relay);
    assert.match(captured[1].systemPrompt.append, /## Relay orchestration/);

    const plain = driver.createSession(config, {}, context);
    cleanups.push(() => plain.close());
    assert.equal(captured[2].mcpServers, undefined);
    assert.equal(captured[2].systemPrompt, undefined);
  });

  it("Claude auto-allows Relay tools without a permission prompt", async () => {
    const captured = [];
    const context = {
      providerDirs: { claude: "/tmp/c", codex: "/tmp/x" },
      logger: noopLogger,
      sdkQueryFn: stubSdkQuery(captured),
    };
    const config = resolveConfig({ logger: noopLogger, workingDirectory: "/tmp" });
    const session = getProviderDriver("claude").createSession(config, { relayMcp }, context);
    cleanups.push(() => session.close());
    const decision = await captured[0].canUseTool(
      "mcp__relay__chat_list",
      {},
      { signal: new AbortController().signal, toolUseID: "t1" },
    );
    assert.equal(decision.behavior, "allow");
  });

  it("Codex argv carries the URL and env var name but never the token", () => {
    assert.deepEqual(buildCodexAppServerArgs(), ["app-server", "--listen", "stdio://"]);
    const args = buildCodexAppServerArgs(relayMcp);
    assert.deepEqual(args, [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'mcp_servers.relay.url="http://127.0.0.1:4321/mcp"',
      "-c",
      `mcp_servers.relay.bearer_token_env_var="${RELAY_MCP_TOKEN_ENV}"`,
    ]);
    assert.ok(!args.join(" ").includes("tok-123"));
  });

  it("Codex sessions put the token in the env and the guidance in a new thread's instructions", async () => {
    const spawns = [];
    const session = new CodexAppServerSession({
      cwd: "/tmp/project",
      logger: noopLogger,
      codexPath: "/tmp/fake-codex",
      relayMcp,
      bootstrapContext: { blocks: [], developerInstructions: "Project rules." },
      spawnProcess(command, args, options) {
        const child = new FakeChild();
        spawns.push({ args, options, child });
        child.stdin.on("data", (chunk) => {
          for (const line of chunk.toString().trim().split("\n")) {
            const msg = JSON.parse(line);
            if (msg.id === undefined || !msg.method) continue;
            const result =
              msg.method === "thread/start"
                ? {
                    thread: { id: "thread-1", cwd: "/tmp/project", status: { type: "idle" } },
                    model: "gpt",
                  }
                : {};
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
          }
        });
        return child;
      },
    });
    cleanups.push(() => session.close());
    session.send("hello");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(spawns[0].options.env[RELAY_MCP_TOKEN_ENV], "tok-123");
    assert.ok(spawns[0].args.includes('mcp_servers.relay.url="http://127.0.0.1:4321/mcp"'));
    const start = spawns[0].child.writes
      .map((w) => JSON.parse(w.trim()))
      .find((m) => m.method === "thread/start");
    assert.match(start.params.developerInstructions, /^Project rules\.\n\n## Relay orchestration/);
    assert.ok(start.params.developerInstructions.endsWith(RELAY_ORCHESTRATION_INSTRUCTIONS));
  });

  it("drops Relay's own server from session MCP status lists", () => {
    assert.deepEqual(withoutRelayMcpServer([{ name: "relay" }, { name: "github" }]), [
      { name: "github" },
    ]);
    assert.equal(withoutRelayMcpServer(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// Endpoint, route, and manager wiring
// ---------------------------------------------------------------------------

describe("/mcp endpoint", () => {
  it("builds the loopback URL from the bind host", () => {
    assert.equal(relayMcpUrl(undefined, 3000), "http://127.0.0.1:3000/mcp");
    assert.equal(relayMcpUrl("0.0.0.0", 3000), "http://127.0.0.1:3000/mcp");
    assert.equal(relayMcpUrl("::", 3000), "http://127.0.0.1:3000/mcp");
    assert.equal(relayMcpUrl("localhost", 3000), "http://localhost:3000/mcp");
    assert.equal(relayMcpUrl("::1", 3000), "http://[::1]:3000/mcp");
  });

  function app(callerFor) {
    const instanceManager = {
      resolveOrchestrationCaller: (token) => callerFor(token),
      getOrchestrationHost: () =>
        fakeHost({
          chats: [chat({ id: "caller" })],
          projects: [{ id: "proj-1", name: "Relay", accountIds: ["default"] }],
        }),
    };
    const hono = new Hono();
    registerMcpRoutes(hono, {
      instanceManager,
      packageVersion: "test",
      config: { logger: noopLogger },
    });
    return hono;
  }

  const post = (hono, body, headers = {}) =>
    hono.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("authenticates by bearer token, refuses browsers, and serves JSON-RPC", async () => {
    const hono = app((token) => (token === "good" ? "caller" : undefined));
    const list = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_list" } };

    const anonymous = await post(hono, list);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate"), /Bearer/);
    assert.equal((await post(hono, list, { Authorization: "Bearer bad" })).status, 401);
    assert.equal(
      (await post(hono, list, { Authorization: "Bearer good", Origin: "https://evil.example" }))
        .status,
      403,
    );

    const ok = await post(hono, list, { Authorization: "Bearer good" });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(
      body.result.structuredContent.chats.map((c) => c.id),
      ["caller"],
    );

    const note = await post(
      hono,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        Authorization: "Bearer good",
      },
    );
    assert.equal(note.status, 202);

    const garbage = await post(hono, "{nope", { Authorization: "Bearer good" });
    assert.equal(garbage.status, 400);
    assert.equal((await garbage.json()).error.code, -32700);

    assert.equal((await hono.request("/mcp")).status, 405);
  });

  it("the manager issues tokens only while serving, and only to live chats", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-orch-"));
    const manager = new InstanceManager(
      resolveConfig({
        logger: noopLogger,
        dbPath: join(dir, "sessions.db"),
        providerDirs: { claude: join(dir, ".claude"), codex: join(dir, ".codex") },
        workingDirectory: dir,
      }),
    );
    try {
      assert.equal(manager.issueRelayMcp("chat-x", "claude"), undefined, "not serving yet");
      manager.setOrchestrationEndpoint("http://127.0.0.1:1/mcp");
      const endpoint = manager.issueRelayMcp("chat-x", "claude");
      assert.equal(endpoint.url, "http://127.0.0.1:1/mcp");
      assert.equal(
        manager.resolveOrchestrationCaller(endpoint.token),
        undefined,
        "unknown chats are not callers",
      );
      manager.instances.set("chat-x", { info: chat({ id: "chat-x" }) });
      assert.equal(manager.resolveOrchestrationCaller(endpoint.token), "chat-x");

      const live = manager.instances.get("chat-x");
      live.process = { close() {} };
      live.sessionId = "s-x";
      assert.equal(manager.stopInstance("chat-x"), true);
      assert.equal(
        manager.resolveOrchestrationCaller(endpoint.token),
        undefined,
        "a stopped chat's token is revoked",
      );

      const reissued = manager.issueRelayMcp("chat-x", "claude");
      assert.equal(manager.resolveOrchestrationCaller(reissued.token), "chat-x");
      manager.setOrchestrationEndpoint(null);
      assert.equal(
        manager.resolveOrchestrationCaller(reissued.token),
        undefined,
        "clearing the endpoint revokes",
      );
      manager.instances.delete("chat-x");
    } finally {
      manager.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
