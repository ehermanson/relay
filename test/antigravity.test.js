import "./test-env.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  groupAntigravityModels,
  parseAntigravityModelsOutput,
  resolveAntigravityEffort,
  splitAntigravityModelId,
} from "../dist/server/core/providers/antigravity-models.js";
import {
  antigravityReadPreview,
  antigravityRelayToolRequest,
  antigravityToolUseActivity,
  cleanAntigravityToolOutput,
  describeAntigravityTool,
  parseAntigravityChecklist,
  splitAntigravityMcpToolName,
} from "../dist/server/core/providers/antigravity-tools.js";
import {
  antigravityTranscriptPath,
  clearAntigravityMetadataCache,
  extractAntigravityUserText,
  listAntigravityChildConversationIds,
  parseAntigravityAgentMessage,
  parseAntigravityTranscript,
  readAntigravityAgentHistory,
  readAntigravityConversationMetadata,
  readAntigravityConversationWorkspaces,
  readLastAntigravityMessage,
  convertAntigravityTranscriptEntry,
  seedAntigravityReplayContext,
} from "../dist/server/core/providers/antigravity-transcript.js";
import { AcpConnection } from "../dist/server/core/providers/acp-connection.js";
import { discoverAntigravityExternalSessions } from "../dist/server/core/provider-registry.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import {
  AntigravityAcpSession,
  antigravityModeFor,
  extractImagePaths,
} from "../dist/server/core/providers/antigravity-session.js";
import {
  classifyAntigravityTurn,
  formatAntigravityResetDelay,
  hasAntigravityPendingReply,
  readAntigravityLastStepIndex,
  readAntigravityTurnErrorStep,
} from "../dist/server/core/providers/antigravity-turn-outcome.js";
import { antigravityReleaseManifestUrl } from "../dist/server/core/provider-versions.js";
import { loginRootForTranscriptPath } from "../dist/server/core/accounts.js";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe("antigravity models", () => {
  const output = [
    "Available models:",
    "gemini-4-neon-low\tGemini 4 Neon (Low)",
    "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
    "gemini-4-neon-high\tGemini 4 Neon (High)",
    "gemini-4-neon-xhigh\tGemini 4 Neon (Extra High)",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n");

  it("parses `agy models` lines and ignores the rest", () => {
    const variants = parseAntigravityModelsOutput(output);
    assert.equal(variants.length, 7);
    assert.deepEqual(variants[0], { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" });
  });

  it("splits family and level", () => {
    assert.deepEqual(splitAntigravityModelId("gemini-4-neon-xhigh"), {
      model: "gemini-4-neon",
      effort: "xhigh",
    });
    assert.deepEqual(splitAntigravityModelId("claude-opus-5-5"), { model: "claude-opus-5-5" });
  });

  it("groups variants into families with effort levels", () => {
    const models = groupAntigravityModels(parseAntigravityModelsOutput(output));
    assert.deepEqual(
      models.map((model) => model.id),
      ["gemini-4-neon", "gemini-3.8-flash", "gpt-oss-120b-medium"],
    );
    const neon = models[0];
    assert.equal(neon.isDefault, true);
    assert.equal(neon.label, "Gemini 4 Neon");
    assert.deepEqual(
      neon.capabilities.reasoningEffortLevels.map((level) => level.effort),
      ["low", "medium", "high", "xhigh"],
    );
    assert.equal(
      neon.capabilities.reasoningEffortLevels.find((level) => level.isDefault)?.effort,
      "high",
    );
    // A lone variant keeps its full id and has no effort control.
    assert.equal(models[2].capabilities.supportsReasoningEffort, false);
  });

  it("maps Relay efforts onto available levels", () => {
    assert.equal(resolveAntigravityEffort("max", ["low", "medium", "high", "xhigh"]), "xhigh");
    assert.equal(resolveAntigravityEffort("max", ["low", "high"]), "high");
    assert.equal(resolveAntigravityEffort("xhigh", ["low", "medium", "high"]), "high");
    assert.equal(resolveAntigravityEffort("medium", ["low", "high"]), "low");
    assert.equal(resolveAntigravityEffort("high", []), undefined);
  });
});

describe("antigravity tools", () => {
  const cwd = "/work/repo";

  it("maps native tools onto Relay's tool names", () => {
    assert.equal(
      describeAntigravityTool("read_file", { Path: "/work/repo/a.ts" }, { cwd }).tool,
      "Read",
    );
    const bash = describeAntigravityTool(
      "run_command",
      { CommandLine: "ls -la", Cwd: cwd },
      { cwd },
    );
    assert.equal(bash.tool, "Bash");
    assert.equal(bash.input.command, "ls -la");
    assert.equal(
      describeAntigravityTool("search_web", { query: "node lts" }, { cwd }).tool,
      "WebSearch",
    );
    assert.equal(describeAntigravityTool("list_dir", { DirectoryPath: cwd }, { cwd }).tool, "Glob");
  });

  it("describes edits as Edit with a changed file", () => {
    const edit = describeAntigravityTool(
      "edit_file",
      { Path: "/work/repo/a.ts", Target: "a + b", Replacement: "b + a" },
      { cwd },
    );
    assert.equal(edit.tool, "Edit");
    assert.equal(edit.input.old_string, "a + b");
    assert.equal(edit.input.new_string, "b + a");
    assert.deepEqual(edit.changedFile, { path: "/work/repo/a.ts", kind: "edited" });
  });

  it("decodes JSON-encoded string arguments", () => {
    const write = describeAntigravityTool(
      "write_file",
      JSON.stringify({ Path: "/work/repo/new.ts", Content: "x" }),
      { cwd },
    );
    assert.equal(write.tool, "Write");
    assert.equal(write.changedFile?.path, "/work/repo/new.ts");
  });

  it("treats a feedback-requesting brain artifact as a plan", () => {
    const brainDir = "/home/u/.gemini/antigravity-cli/brain/abc";
    const plan = describeAntigravityTool(
      "write_file",
      {
        Path: `${brainDir}/implementation_plan.md`,
        Content: "# Plan\n1. Do it",
        ArtifactMetadata: { RequestFeedback: true },
      },
      { cwd, brainDir },
    );
    assert.equal(plan.plan, "# Plan\n1. Do it");
    assert.equal(plan.changedFile, undefined);
  });

  it("maps subagents onto Agent", () => {
    const agent = describeAntigravityTool(
      "invoke_subagent",
      { Prompt: "count lines", Role: "Counter", TypeName: "general" },
      { cwd },
    );
    assert.equal(agent.tool, "Agent");
    assert.equal(agent.subagent?.prompt, "count lines");
  });

  it("maps MCP tool names onto Relay's MCP activity shape", () => {
    assert.deepEqual(splitAntigravityMcpToolName("mcp_relay_delegate_task"), {
      serverName: "relay",
      toolName: "delegate_task",
    });
    assert.deepEqual(splitAntigravityMcpToolName("mcp_github_list_issues"), {
      serverName: "github",
      toolName: "list_issues",
    });
    assert.equal(splitAntigravityMcpToolName("read_file"), undefined);
    const view = describeAntigravityTool(
      "mcp_relay_chat_list",
      { toolSummary: "List chats", limit: 5 },
      { cwd: "/w" },
    );
    assert.equal(view.tool, "chat_list");
    assert.deepEqual(view.input, { limit: 5 });
    const activity = antigravityToolUseActivity(view, "call-1");
    assert.equal(activity.mcp.serverName, "relay");
    assert.equal(activity.mcp.toolName, "chat_list");
  });

  it("parses a checklist artifact", () => {
    assert.deepEqual(
      parseAntigravityChecklist("# T\n- [x] 1. One\n- [/] Two\n- [ ] Three\nnot a task"),
      [
        { id: "1", subject: "One", status: "completed" },
        { id: "2", subject: "Two", status: "in_progress" },
        { id: "3", subject: "Three", status: "pending" },
      ],
    );
  });

  it("keeps only a command's output", () => {
    assert.equal(
      cleanAntigravityToolOutput(
        "Created At: x\nCompleted At: y\nCommand exited with code 0.\n\nCommand output:\n       3 notes.txt",
      ),
      "3 notes.txt".padStart(18),
    );
  });

  it("previews a read file in agy's format", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-agy-read-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    assert.equal(antigravityReadPreview(file), "Showing lines 1-3 of 3\n1: one\n2: two\n3: three");
    assert.equal(antigravityReadPreview(file, 2, 1), "Showing lines 2-2 of 3\n2: two");
    assert.equal(antigravityReadPreview(join(dir, "missing.txt")), undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("strips timing headers from tool output", () => {
    assert.equal(
      cleanAntigravityToolOutput("Created At: 2026-01-01\nCompleted At: 2026-01-01\nhello"),
      "hello",
    );
  });
});

describe("antigravity transcripts", () => {
  let home;
  const parentId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const workspace = join(tmpdir(), "agy-ws-test");

  const writeTranscript = (id, steps) => {
    const path = antigravityTranscriptPath(home, id);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, steps.map((step) => JSON.stringify(step)).join("\n") + "\n");
    return path;
  };

  before(() => {
    home = mkdtempSync(join(tmpdir(), "relay-agy-home-"));
    mkdirSync(workspace, { recursive: true });
    const dataDir = join(home, "antigravity-cli");
    mkdirSync(join(dataDir, "cache"), { recursive: true });
    writeFileSync(
      join(dataDir, "cache", "conversation_metadata.json"),
      JSON.stringify({
        conversations: {
          [parentId]: {
            summary: {
              ID: parentId,
              Title: "Count lines",
              WorkspaceURIs: [`file://${workspace}`],
              UpdatedAt: "2026-11-20T23:00:00Z",
              Internal: false,
            },
          },
        },
      }),
    );
    writeTranscript(parentId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T22:59:00Z",
        content:
          "<USER_REQUEST>\nRead a.txt then delegate\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T22:59:01Z",
        thinking: "Let me read it.",
        model: "gemini-4-neon-high",
        input_tokens: 100,
        cache_read_tokens: 50,
        output_tokens: 20,
        tool_calls: [{ name: "read_file", args: { Path: join(workspace, "a.txt") } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "VIEW_FILE",
        created_at: "2026-11-20T22:59:02Z",
        content: "Created At: x\nCompleted At: y\nline one",
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T22:59:03Z",
        model: "gemini-4-neon-high",
        input_tokens: 10,
        output_tokens: 5,
        tool_calls: [{ name: "invoke_subagent", args: { Prompt: "count lines", Role: "Counter" } }],
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        created_at: "2026-11-20T22:59:04Z",
        content: `Created the following subagent:\n{ "conversationId": "${childId}", "logAbsoluteUri": "file:///x" }`,
      },
      {
        step_index: 5,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T22:59:05Z",
        content: "Waiting for the subagent.",
        model: "gemini-4-neon-high",
      },
      {
        step_index: 6,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-20T22:59:30Z",
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T22:59:30Z sender=${childId} priority=MESSAGE_PRIORITY_HIGH content=There are 3 lines.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 7,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T22:59:31Z",
        content: "The file has 3 lines.",
        model: "gemini-4-neon-high",
      },
    ]);
    mkdirSync(join(home, "antigravity-cli", "brain", parentId, ".system_generated", "subagents"), {
      recursive: true,
    });
    writeFileSync(
      join(
        home,
        "antigravity-cli",
        "brain",
        parentId,
        ".system_generated",
        "subagents",
        `${childId}.json`,
      ),
      JSON.stringify({ conversationId: childId }),
    );
    writeTranscript(childId, [
      {
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-20T22:59:05Z",
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=${parentId} priority=MESSAGE_PRIORITY_HIGH content=count lines in a.txt\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T22:59:20Z",
        content: "3 lines.",
        model: "gemini-3.8-flash-high",
      },
    ]);
  });

  after(() => {
    clearAntigravityMetadataCache();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("extracts the user's own words and agent messages", () => {
    assert.equal(
      extractAntigravityUserText("<USER_REQUEST>\nhi there\n</USER_REQUEST>\n<X>meta</X>"),
      "hi there",
    );
    assert.deepEqual(
      parseAntigravityAgentMessage(
        `[Message] timestamp=t sender=${childId} priority=HIGH content=done\n</SYSTEM_MESSAGE>`,
      ),
      { sender: childId, text: "done" },
    );
  });

  it("replays a conversation with tools, stats and a subagent", () => {
    const parsed = parseAntigravityTranscript(antigravityTranscriptPath(home, parentId));
    assert.equal(parsed.cwd, workspace);
    const messages = parsed.history.map((entry) => entry.message);
    const user = messages.find((message) => message.type === "user");
    assert.equal(user.text, "Read a.txt then delegate");
    const read = messages.find(
      (message) =>
        message.type === "activity" && message.activity === "tool_use" && message.tool === "Read",
    );
    assert.ok(read?.toolUseId);
    const result = messages.find(
      (message) =>
        message.type === "activity" &&
        message.activity === "tool_result" &&
        message.toolUseId === read.toolUseId,
    );
    assert.equal(result?.detail, "line one");
    const agentUpdates = messages.filter((message) => message.type === "agent_update");
    assert.ok(agentUpdates.some((update) => update.agent.status === "running"));
    assert.ok(agentUpdates.some((update) => update.agent.providerAgentId === childId));
    assert.ok(
      agentUpdates.some(
        (update) =>
          update.agent.status === "completed" && update.agent.result === "There are 3 lines.",
      ),
    );
    assert.equal(parsed.stats.inputTokens, 110);
    assert.equal(parsed.stats.cacheReadTokens, 50);
    assert.equal(parsed.stats.outputTokens, 25);
    const last = messages.filter((message) => message.type === "output").at(-1);
    assert.equal(last.isWaiting, true);
  });

  it("keeps a plan written for review pending on replay", () => {
    const planId = "33333333-3333-4333-8333-333333333333";
    const brain = join(home, "antigravity-cli", "brain", planId);
    const path = writeTranscript(planId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "<USER_REQUEST>plan it</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "write_file",
            args: {
              Path: `${brain}/implementation_plan.md`,
              Content: "# Plan",
              ArtifactMetadata: { RequestFeedback: true },
            },
          },
        ],
      },
      { step_index: 2, source: "MODEL", type: "GENERIC", content: "Created file" },
    ]);
    const messages = parseAntigravityTranscript(path, { cwd: workspace }).history.map(
      (entry) => entry.message,
    );
    assert.ok(
      messages.some(
        (message) => message.activity === "tool_use" && message.tool === "ExitPlanMode",
      ),
    );
    assert.ok(!messages.some((message) => message.activity === "tool_result"));
  });

  it("replays a todo artifact as the task list", () => {
    const todoId = "44444444-4444-4444-8444-444444444444";
    const todo = join(home, "antigravity-cli", "brain", todoId, "todo.md");
    const path = writeTranscript(todoId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "<USER_REQUEST>go</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "write_file",
            args: { Path: todo, Content: "# Tasks\n- [ ] 1. Read\n- [ ] 2. Edit\n" },
          },
        ],
      },
      { step_index: 2, source: "MODEL", type: "GENERIC", content: "Created file" },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "edit_file",
            args: { Path: todo, Target: "- [ ] 1. Read", Replacement: "- [x] 1. Read" },
          },
        ],
      },
      { step_index: 4, source: "MODEL", type: "GENERIC", content: "Edited file" },
    ]);
    const parsed = parseAntigravityTranscript(path, { cwd: workspace });
    const lists = parsed.history
      .map((entry) => entry.message)
      .filter((message) => message.activity === "task_list");
    assert.equal(lists.length, 2);
    assert.deepEqual(
      lists[1].tasks.map((task) => [task.subject, task.status]),
      [
        ["Read", "completed"],
        ["Edit", "pending"],
      ],
    );
    assert.equal(parsed.files.size, 0);
    const writeUse = parsed.history.find((entry) => entry.message.tool === "Write");
    assert.equal(writeUse.message.input.artifact, true);
  });

  it("reads child history attributed to the agent, with its assignment", () => {
    const history = readAntigravityAgentHistory(home, childId, "agent-key");
    assert.ok(history);
    const first = history[0].message;
    assert.equal(first.type, "user");
    assert.equal(first.text, "count lines in a.txt");
    assert.ok(
      history.every(
        (entry) => !("agentId" in entry.message) || entry.message.agentId === "agent-key",
      ),
    );
    assert.equal(readAntigravityAgentHistory(home, "../etc", "x"), null);
  });

  it("reads metadata, previews and child ids", () => {
    const dataDir = join(home, "antigravity-cli");
    const meta = readAntigravityConversationMetadata(dataDir).get(parentId);
    assert.equal(meta?.title, "Count lines");
    assert.deepEqual(meta?.workspaces, [workspace]);
    const last = readLastAntigravityMessage(antigravityTranscriptPath(home, parentId));
    assert.equal(last?.from, "assistant");
    assert.equal(last?.text, "The file has 3 lines.");
    assert.deepEqual([...listAntigravityChildConversationIds(dataDir)], [childId]);
  });

  it("reads workspaces from a conversation database", () => {
    const dataDir = join(home, "antigravity-cli");
    mkdirSync(join(dataDir, "conversations"), { recursive: true });
    const db = new DatabaseSync(join(dataDir, "conversations", `${childId}.db`));
    db.exec(
      "CREATE TABLE trajectory_metadata_blob (id TEXT DEFAULT 'main', data BLOB, PRIMARY KEY (id))",
    );
    const uri = Buffer.from(`file://${workspace}`);
    const inner = Buffer.concat([Buffer.from([0x0a, uri.length]), uri, Buffer.from([0x1a, 0x00])]);
    const blob = Buffer.concat([
      Buffer.from([0x0a, inner.length]),
      inner,
      Buffer.from([0x12, 0x02, 0x08, 0x01]),
    ]);
    db.prepare("INSERT INTO trajectory_metadata_blob (data) VALUES (?)").run(blob);
    db.close();
    assert.deepEqual(readAntigravityConversationWorkspaces(dataDir, childId), [workspace]);
    assert.deepEqual(readAntigravityConversationWorkspaces(dataDir, "missing-id"), []);
  });

  it("derives the login root from a transcript path", () => {
    assert.equal(
      loginRootForTranscriptPath("antigravity", antigravityTranscriptPath(home, parentId)),
      home,
    );
  });
});

describe("antigravity helpers", () => {
  it("maps runtime modes", () => {
    assert.equal(antigravityModeFor("plan", false), "plan");
    assert.equal(antigravityModeFor("full-access", false), "accept-edits");
    assert.equal(antigravityModeFor("approval-required", false), "default");
    assert.equal(antigravityModeFor("full-access", true), "default");
  });

  it("finds image markers", () => {
    assert.deepEqual(extractImagePaths("look [Image: source: /tmp/a.png] here"), ["/tmp/a.png"]);
  });

  it("builds the release manifest url per platform", () => {
    assert.match(
      antigravityReleaseManifestUrl("darwin", "arm64"),
      /manifests\/darwin_arm64\.json$/,
    );
    assert.match(antigravityReleaseManifestUrl("linux", "x64"), /manifests\/linux_amd64\.json$/);
    assert.equal(antigravityReleaseManifestUrl("win32", "x64"), null);
  });
});

// A scripted ACP agent standing in for `agy acp`.
const STUB_AGENT = String.raw`
const fs = require("fs");
const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + "\n");
let buffer = "";
let nextId = 1000;
const waiting = new Map();
let cancelPrompt = null;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const config = { model: "gemini-4-neon", thought_level: "high" };
const configOptions = () => [
  { id: "model", category: "model", type: "select", currentValue: config.model,
    options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gemini-3.8-flash", name: "Flash" }] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: config.thought_level,
    options: ["low", "medium", "high", "xhigh"].map((value) => ({ value, name: value })) },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function handle(message) {
  if (message.id !== undefined && !message.method) { waiting.get(message.id)?.(message.result); return; }
  log({ method: message.method, params: message.params });
  const reply = (result) => send({ id: message.id, result });
  const sid = "sess-1";
  if (message.method === process.env.STUB_HOLD) await sleep(Number(process.env.STUB_HOLD_MS || 0));
  if (message.method === process.env.STUB_FAIL && message.id !== undefined) {
    return send({ id: message.id, error: { code: -32603, message: "stub failure" } });
  }
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentInfo: { name: "stub", version: "1.5.13" },
        agentCapabilities: { loadSession: true, _meta: { antigravity: { systemPrompt: { append: true } } } } });
    case "authenticate": return reply({});
    case "session/new":
    case "session/resume":
      return reply({ sessionId: sid, configOptions: configOptions(),
        modes: { currentModeId: process.env.STUB_INITIAL_MODE || "default", availableModes: [{ id: "default" }, { id: "accept-edits" }, { id: "plan" }, { id: "auto" }] } });
    case "session/set_config_option":
      config[message.params.configId] = message.params.value;
      return reply({ configOptions: configOptions() });
    case "session/set_mode": return reply({});
    case "session/cancel": if (cancelPrompt) cancelPrompt(); return;
    case "session/prompt": {
      const text = message.params.prompt[0].text;
      if (text === "hello") {
        update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi!" } });
        update(sid, { sessionUpdate: "session_info_update", title: "Greeting" });
        update(sid, { sessionUpdate: "usage_update", used: 1200, size: 1048576 });
        return reply({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 2, thoughtTokens: 1 } });
      }
      if (text === "edit") {
        const toolCall = { toolCallId: "t1", name: "edit_file", kind: "edit", status: "pending",
          args: { Path: process.cwd() + "/a.txt", Target: "x", Replacement: "y" } };
        update(sid, { sessionUpdate: "tool_call", ...toolCall, status: "in_progress" });
        const answer = await ask("session/request_permission", { sessionId: sid, toolCall,
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
        log({ permission: answer });
        const allowed = answer?.outcome?.optionId === "allow";
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed",
          content: [{ type: "content", content: { type: "text", text: allowed ? "edited" : "denied" } }] });
        return reply({ stopReason: "end_turn" });
      }
      if (text === "delegate") {
        update(sid, { sessionUpdate: "tool_call", toolCallId: "sub1", name: "invoke_subagent", kind: "other", status: "in_progress",
          args: { Prompt: "count lines", Role: "Counter" } });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "sub1", status: "completed",
          content: [{ type: "content", content: { type: "text", text: "Created the following subagent" } }] });
        reply({ stopReason: "end_turn" });
        setTimeout(() => {
          fs.appendFileSync(process.env.STUB_TRANSCRIPT, JSON.stringify({ step_index: 9, source: "SYSTEM", type: "SYSTEM_MESSAGE",
            created_at: new Date().toISOString(),
            content: "<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=c0ffee00-0000-4000-8000-000000000001 priority=MESSAGE_PRIORITY_HIGH content=It has 3 lines.\n</SYSTEM_MESSAGE>" }) + "\n");
          update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The child says 3." } });
          fs.appendFileSync(process.env.STUB_TRANSCRIPT, JSON.stringify({ step_index: 10, source: "MODEL", type: "PLANNER_RESPONSE",
            created_at: new Date().toISOString(), content: "The child says 3." }) + "\n");
          update(sid, { sessionUpdate: "usage_update", used: 50, size: 100 });
        }, 200);
        return;
      }
      if (text === "parallel") {
        for (const id of ["sub-a", "sub-b"]) {
          update(sid, { sessionUpdate: "tool_call", toolCallId: id, name: "invoke_subagent", kind: "other",
            status: "in_progress", args: { Prompt: "work " + id, Role: id } });
        }
        // Reversed completion order; each result names its own child.
        for (const [id, child] of [["sub-b", "bbbbbbbb-0000-4000-8000-000000000002"], ["sub-a", "aaaaaaaa-0000-4000-8000-000000000001"]]) {
          update(sid, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed",
            content: [{ type: "content", content: { type: "text",
              text: 'Created the following subagent: { "conversationId": "' + child + '" }' } }] });
        }
        return reply({ stopReason: "end_turn" });
      }
      if (text === "noargs") {
        update(sid, { sessionUpdate: "tool_call", toolCallId: "n1", name: "read_file", kind: "read", status: "pending" });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "n1", status: "in_progress",
          args: { Path: process.cwd() + "/a.txt" } });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "n1", status: "completed",
          content: [{ type: "content", content: { type: "text", text: "contents" } }] });
        return reply({ stopReason: "end_turn" });
      }
      if (text === "wake-slow") {
        reply({ stopReason: "end_turn" });
        await sleep(200);
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working. " } });
        update(sid, { sessionUpdate: "tool_call", toolCallId: "w1", name: "run_command", kind: "execute",
          status: "in_progress", args: { CommandLine: "sleep 4" } });
        // A usage update mid-reply, then a tool that outlasts the settle delay.
        update(sid, { sessionUpdate: "usage_update", used: 10, size: 100 });
        await sleep(3500);
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed",
          content: [{ type: "content", content: { type: "text", text: "ok" } }] });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
        update(sid, { sessionUpdate: "usage_update", used: 20, size: 100 });
        return;
      }
      if (text === "wake-ask") {
        reply({ stopReason: "end_turn" });
        await sleep(200);
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Need to edit." } });
        const toolCall = { toolCallId: "w2", name: "edit_file", kind: "edit", status: "pending",
          args: { Path: process.cwd() + "/a.txt", Target: "x", Replacement: "y" } };
        update(sid, { sessionUpdate: "tool_call", ...toolCall, status: "in_progress" });
        const answer = await ask("session/request_permission", { sessionId: sid, toolCall,
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
        log({ permission: answer });
        return;
      }
      if (text === "mcp") {
        const toolCall = { toolCallId: "m1", name: "mcp_" + process.env.STUB_MCP_SERVER + "_ui_render", kind: "other",
          status: "pending", rawInput: { ServerName: process.env.STUB_MCP_SERVER, ToolName: "ui_render" } };
        update(sid, { sessionUpdate: "tool_call", ...toolCall, status: "in_progress" });
        const answer = await ask("session/request_permission", { sessionId: sid, toolCall,
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
        log({ permission: answer });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "m1", status: "completed",
          content: [{ type: "content", content: { type: "text", text: "shown" } }] });
        return reply({ stopReason: "end_turn" });
      }
      if (text === "api-error") {
        // agy logs the failed model call as an error step and ends the turn normally.
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.env.STUB_DB);
        db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(1, 14, Buffer.from("user"));
        db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(2, 17,
          Buffer.from("model call failed: Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: [reason:QUOTA_EXHAUSTED quotaResetDelay:2h5m0s]"));
        db.close();
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Something went wrong." } });
        return reply({ stopReason: "end_turn" });
      }
      if (text === "queued-report") {
        // A subagent's report waits unread in the inbox when the prompt ends.
        reply({ stopReason: "end_turn" });
        await sleep(300);
        fs.writeFileSync(process.env.STUB_INBOX + "/read.json", JSON.stringify({ "msg-1": true }));
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The report says 3." } });
        update(sid, { sessionUpdate: "usage_update", used: 30, size: 100 });
        return;
      }
      if (text === "slow") {
        await new Promise((resolve) => { cancelPrompt = resolve; });
        cancelPrompt = null;
        return reply({ stopReason: "cancelled" });
      }
      return reply({ stopReason: "end_turn" });
    }
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "nope" } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`;

describe("AntigravityAcpSession (stub agent)", () => {
  let dir;
  let stubPath;
  let logPath;
  const sessions = [];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-agy-session-"));
    stubPath = join(dir, "stub-agent.cjs");
    writeFileSync(stubPath, STUB_AGENT);
  });

  after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  const createSession = ({ env: extraEnv = {}, ...options } = {}) => {
    logPath = join(dir, `log-${sessions.length}.jsonl`);
    writeFileSync(logPath, "");
    const session = new AntigravityAcpSession({
      logger: silentLogger,
      cwd: dir,
      home: join(dir, "gemini-home"),
      binaryPath: "agy",
      spawnProcess: (_binary, args, spawnOptions) =>
        spawn(process.execPath, [stubPath, ...args], {
          ...spawnOptions,
          env: { ...spawnOptions.env, STUB_LOG: logPath, ...extraEnv },
        }),
      ...options,
    });
    sessions.push(session);
    return session;
  };

  const readLog = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  const collect = (session) => {
    const events = [];
    for (const name of [
      "output",
      "activity",
      "stats",
      "systemEvent",
      "titleUpdate",
      "permissionRequest",
      "providerError",
    ]) {
      session.on(name, (payload) => events.push({ name, payload }));
    }
    return events;
  };

  const turnEnd = (session) =>
    new Promise((resolve) => {
      const onOutput = (message) => {
        if (message.isWaiting) {
          session.off("output", onOutput);
          resolve(message);
        }
      };
      session.on("output", onOutput);
    });

  it("runs a turn: config, system prompt, streaming, usage and title", async () => {
    const session = createSession({
      model: "gemini-4-neon",
      modelOptions: { reasoningEffort: "max" },
      bootstrapContext: { developerInstructions: "Project rules here." },
    });
    const events = collect(session);
    const done = turnEnd(session);
    session.send("hello");
    assert.equal(session.isProcessing, true);
    const end = await done;
    assert.equal(end.aborted, undefined);
    assert.equal(session.isProcessing, false);

    const log = readLog();
    const created = log.find((entry) => entry.method === "session/new");
    assert.equal(created.params.cwd, dir);
    assert.match(created.params._meta.antigravity.systemPrompt.append, /Project rules here\./);
    assert.ok(
      log.some(
        (entry) =>
          entry.method === "session/set_config_option" &&
          entry.params.configId === "thought_level" &&
          entry.params.value === "xhigh",
      ),
    );

    const text = events
      .filter((event) => event.name === "output" && !event.payload.isWaiting)
      .map((event) => event.payload.text)
      .join("");
    assert.equal(text, "Hi!");
    assert.ok(
      events.some(
        (event) =>
          event.name === "activity" &&
          event.payload.activity === "thinking" &&
          event.payload.detail === "thinking",
      ),
    );
    assert.ok(events.some((event) => event.name === "titleUpdate" && event.payload === "Greeting"));
    assert.ok(
      events.some(
        (event) => event.name === "systemEvent" && event.payload.event === "session_init",
      ),
    );
    assert.equal(session.stats.inputTokens, 10);
    assert.equal(session.stats.cacheReadTokens, 2);
    assert.equal(session.stats.contextTokens, 1200);
    assert.equal(session.getRuntimeBinding().providerSessionId, "sess-1");
  });

  it("asks for approval and relays the answer", async () => {
    const session = createSession();
    const events = collect(session);
    const request = new Promise((resolve) => session.once("permissionRequest", resolve));
    const done = turnEnd(session);
    session.send("edit");
    const pending = await request;
    assert.equal(pending.category, "file_change");
    assert.deepEqual(pending.files, [join(realpathSync(dir), "a.txt")]);
    assert.equal(session.respondToRequest(pending.requestId, "accept"), true);
    await done;
    assert.deepEqual(readLog().find((entry) => entry.permission)?.permission, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    const result = events.find(
      (event) => event.name === "activity" && event.payload.activity === "tool_result",
    );
    assert.equal(result?.payload.tool, "Edit");
    assert.equal(result?.payload.detail, "edited");
    assert.ok(
      events.some(
        (event) =>
          event.name === "activity" &&
          event.payload.activity === "file_list" &&
          event.payload.files.length === 1,
      ),
    );
  });

  it("answers approvals itself in full access", async () => {
    const session = createSession({ runtimeMode: "full-access" });
    const events = collect(session);
    const done = turnEnd(session);
    session.send("edit");
    await done;
    assert.equal(events.filter((event) => event.name === "permissionRequest").length, 0);
    const log = readLog();
    assert.ok(
      log.some(
        (entry) => entry.method === "session/set_mode" && entry.params.modeId === "accept-edits",
      ),
    );
    assert.equal(log.find((entry) => entry.permission)?.permission.outcome.optionId, "allow");
  });

  it("interrupts a running turn", async () => {
    const session = createSession();
    const done = turnEnd(session);
    session.send("slow");
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.interrupt();
    const end = await done;
    assert.equal(end.aborted, true);
    assert.ok(readLog().some((entry) => entry.method === "session/cancel"));
  });

  it("completes a subagent's card from its report", async () => {
    const home = join(dir, "gemini-home");
    const brain = join(home, "antigravity-cli", "brain", "sess-1");
    mkdirSync(join(brain, ".system_generated", "subagents"), { recursive: true });
    mkdirSync(join(brain, ".system_generated", "logs"), { recursive: true });
    writeFileSync(
      join(brain, ".system_generated", "subagents", "c0ffee00-0000-4000-8000-000000000001.json"),
      "{}",
    );
    const transcript = join(brain, ".system_generated", "logs", "transcript_full.jsonl");
    writeFileSync(transcript, "");
    const session = createSession({ env: { STUB_TRANSCRIPT: transcript } });
    const updates = [];
    session.on("agentUpdate", (update) => updates.push(update.agent));
    const ends = [];
    const twoTurns = new Promise((resolve) =>
      session.on("output", (message) => {
        if (message.isWaiting && ends.push(message) === 2) resolve();
      }),
    );
    session.send("delegate");
    await twoTurns;
    assert.equal(updates[0].status, "running");
    assert.equal(updates[0].assignment, "count lines");
    assert.equal(updates[1].providerAgentId, "c0ffee00-0000-4000-8000-000000000001");
    const done = updates.find((agent) => agent.status === "completed");
    assert.equal(done?.result, "It has 3 lines.");
    assert.equal(done?.agentId, "sub1");
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const methods = () => readLog().map((entry) => entry.method);

  it("Stop while the session is still signing in never sends the prompt", async () => {
    const session = createSession({ env: { STUB_HOLD: "authenticate", STUB_HOLD_MS: "400" } });
    const done = turnEnd(session);
    session.send("hello");
    await sleep(50);
    session.interrupt();
    const end = await done;
    assert.equal(end.aborted, true);
    assert.equal(session.isProcessing, false);
    await sleep(700); // setup finishes after the stop
    assert.ok(methods().includes("session/new"));
    assert.ok(!methods().includes("session/prompt"), "the stopped prompt is never sent");
    assert.ok(!methods().includes("session/cancel"), "nothing to cancel on the agent");

    // The next message runs normally, exactly once.
    const next = turnEnd(session);
    session.send("hello");
    assert.equal((await next).aborted, undefined);
    assert.equal(methods().filter((method) => method === "session/prompt").length, 1);
  });

  it("Stop while a resumed session is still configuring never sends the prompt", async () => {
    const session = createSession({
      resumeSessionId: "sess-1",
      model: "gemini-3.8-flash",
      env: { STUB_HOLD: "session/set_config_option", STUB_HOLD_MS: "400" },
    });
    const done = turnEnd(session);
    session.send("hello");
    await sleep(150);
    assert.ok(methods().includes("session/resume"));
    session.interrupt();
    assert.equal((await done).aborted, true);
    await sleep(600);
    assert.ok(!methods().includes("session/prompt"));
    assert.ok(!methods().includes("session/cancel"));
  });

  it("refuses to send when a switch to a stricter mode fails", async () => {
    const session = createSession({
      runtimeMode: "approval-required",
      env: { STUB_INITIAL_MODE: "accept-edits", STUB_FAIL: "session/set_mode" },
    });
    const events = collect(session);
    const done = turnEnd(session);
    session.send("hello");
    await done;
    assert.ok(methods().includes("session/set_mode"));
    assert.ok(!methods().includes("session/prompt"), "never runs under the looser mode");
    assert.ok(
      events.some((event) => event.name === "providerError" && /didn't switch/.test(event.payload)),
    );
  });

  it("still sends when a switch to a looser mode fails", async () => {
    const session = createSession({
      runtimeMode: "full-access",
      env: { STUB_INITIAL_MODE: "default", STUB_FAIL: "session/set_mode" },
    });
    const done = turnEnd(session);
    session.send("hello");
    assert.equal((await done).aborted, undefined);
    assert.ok(methods().includes("session/prompt"));
  });

  it("kills a half-started agent and starts a fresh one on the next send", async () => {
    const children = [];
    const session = createSession({
      env: { STUB_FAIL: "authenticate" },
      spawnProcess: (_binary, args, spawnOptions) => {
        const child = spawn(process.execPath, [stubPath, ...args], {
          ...spawnOptions,
          env: { ...spawnOptions.env, STUB_LOG: logPath, STUB_FAIL: "authenticate" },
        });
        children.push(child);
        return child;
      },
    });
    const events = collect(session);
    const exits = [];
    session.on("exit", (exit) => exits.push(exit));
    const done = turnEnd(session);
    session.send("hello");
    await done;
    await new Promise((resolve) =>
      children[0].exitCode !== null || children[0].signalCode
        ? resolve()
        : children[0].once("exit", resolve),
    );
    assert.equal(session.pid, undefined);
    assert.equal(exits.length, 0, "a replaced agent is not reported as a crash");
    assert.ok(events.some((event) => event.name === "providerError"));

    const again = turnEnd(session);
    session.send("hello");
    await again;
    assert.equal(children.length, 2);
  });

  it("survives a binary that fails to spawn", async () => {
    const session = createSession({
      spawnProcess: (_binary, args, spawnOptions) =>
        spawn(join(dir, "missing-agy"), args, spawnOptions),
    });
    const exit = new Promise((resolve) => session.once("exit", resolve));
    const done = turnEnd(session);
    session.send("hello");
    const [ended, exited] = await Promise.all([done, exit]);
    assert.equal(ended.aborted, true);
    assert.match(exited.stderr, /ENOENT/);
    assert.equal(session.pid, undefined);
  });

  it("an unprompted reply stays open through a slow tool and a mid-reply usage update", async () => {
    const session = createSession();
    const events = collect(session);
    const ends = [];
    const twoTurns = new Promise((resolve) =>
      session.on("output", (message) => {
        if (message.isWaiting && ends.push(Date.now()) === 2) resolve();
      }),
    );
    session.send("wake-slow");
    await twoTurns;
    const outputs = events.filter((event) => event.name === "output");
    const doneAt = outputs.findIndex((event) => event.payload.text === "Done.");
    const secondEnd = outputs.findIndex(
      (event, index) => index > 0 && event.payload.isWaiting && index > doneAt,
    );
    assert.ok(doneAt > 0, "the reply's tail arrived");
    assert.ok(secondEnd > doneAt, "the reply ended after its tail, not mid-tool");
    assert.equal(outputs.filter((event) => event.payload.isWaiting).length, 2);
  });

  it("Stop on an unprompted reply cancels it on the agent and answers its question", async () => {
    const session = createSession();
    const first = turnEnd(session);
    session.send("wake-ask");
    await first;
    const request = await new Promise((resolve) => session.once("permissionRequest", resolve));
    assert.equal(session.isProcessing, true);
    const stopped = turnEnd(session);
    session.interrupt();
    assert.equal((await stopped).aborted, true);
    await sleep(200);
    assert.ok(methods().includes("session/cancel"));
    assert.deepEqual(readLog().find((entry) => entry.permission)?.permission, {
      outcome: { outcome: "cancelled" },
    });
    assert.equal(session.respondToRequest(request.requestId, "accept"), false);
  });

  it("attributes parallel subagents by the ids their launches return", async () => {
    const session = createSession();
    const updates = [];
    session.on("agentUpdate", (update) => updates.push(update.agent));
    const done = turnEnd(session);
    session.send("parallel");
    await done;
    const childOf = (agentId) =>
      updates.find((agent) => agent.agentId === agentId && agent.providerAgentId)?.providerAgentId;
    assert.equal(childOf("sub-a"), "aaaaaaaa-0000-4000-8000-000000000001");
    assert.equal(childOf("sub-b"), "bbbbbbbb-0000-4000-8000-000000000002");
  });

  it("emits a tool call once its arguments are known", async () => {
    const session = createSession();
    const events = collect(session);
    const done = turnEnd(session);
    session.send("noargs");
    await done;
    const uses = events.filter(
      (event) => event.name === "activity" && event.payload.activity === "tool_use",
    );
    assert.equal(uses.length, 1);
    assert.equal(uses[0].payload.tool, "Read");
    assert.equal(uses[0].payload.input.file_path, join(realpathSync(dir), "a.txt"));
  });

  const relayMcp = { url: "http://127.0.0.1:9/mcp", token: "test-token" };

  it("runs Relay's own tools without asking, in every mode", async () => {
    const session = createSession({ relayMcp, env: { STUB_MCP_SERVER: "relay" } });
    const events = collect(session);
    const done = turnEnd(session);
    session.send("mcp");
    await done;
    assert.equal(events.filter((event) => event.name === "permissionRequest").length, 0);
    assert.equal(readLog().find((entry) => entry.permission)?.permission.outcome.optionId, "allow");
  });

  it("still asks before another server's MCP tool", async () => {
    const session = createSession({ relayMcp, env: { STUB_MCP_SERVER: "github" } });
    const request = new Promise((resolve) => session.once("permissionRequest", resolve));
    const done = turnEnd(session);
    session.send("mcp");
    const pending = await request;
    assert.equal(session.respondToRequest(pending.requestId, "decline"), true);
    await done;
    assert.equal(readLog().find((entry) => entry.permission)?.permission.outcome.optionId, "deny");
  });

  it("reports an API failure agy ended as a normal turn", async () => {
    const home = join(dir, "gemini-home-error");
    const conversations = join(home, "antigravity-cli", "conversations");
    mkdirSync(conversations, { recursive: true });
    const dbPath = join(conversations, "sess-1.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)");
    db.prepare("INSERT INTO steps VALUES (0, 15, ?)").run(Buffer.from("earlier reply"));
    db.close();
    const session = createSession({ home, env: { STUB_DB: dbPath } });
    const events = collect(session);
    const done = turnEnd(session);
    session.send("api-error");
    const end = await done;
    assert.ok(!end.aborted);
    const errors = events.filter((event) => event.name === "providerError");
    assert.equal(errors.length, 1);
    assert.match(
      errors[0].payload,
      /^You've reached your Antigravity quota for this period\. It resets in 2h 5m\.$/,
    );
  });

  it("keeps the turn open while a subagent's report is queued", async () => {
    const home = join(dir, "gemini-home-inbox");
    const inbox = join(home, "antigravity-cli", "brain", "sess-1", ".system_generated", "messages");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, "msg-1.json"),
      JSON.stringify({
        id: "msg-1",
        priority: "MESSAGE_PRIORITY_HIGH",
        content: "It has 3 lines.",
      }),
    );
    const session = createSession({ home, env: { STUB_INBOX: inbox } });
    const outputs = [];
    session.on("output", (message) => outputs.push(message));
    const done = turnEnd(session);
    session.send("queued-report");
    await done;
    const endAt = outputs.findIndex((message) => message.isWaiting);
    const replyAt = outputs.findIndex((message) => message.text === "The report says 3.");
    assert.ok(replyAt >= 0 && replyAt < endAt, "the queued reply belongs to the same turn");
    await sleep(300);
    assert.equal(outputs.filter((message) => message.isWaiting).length, 1);
  });

  it("resumes an existing conversation", async () => {
    const session = createSession({ resumeSessionId: "sess-1" });
    const done = turnEnd(session);
    session.send("hello");
    await done;
    assert.ok(
      readLog().some(
        (entry) => entry.method === "session/resume" && entry.params.sessionId === "sess-1",
      ),
    );
    assert.ok(!readLog().some((entry) => entry.method === "session/new"));
  });
});

describe("antigravity turn outcomes", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const failed = (errorText) => ({ errorText, reachedModel: false });

  it("passes a turn with no error step", () => {
    assert.equal(classifyAntigravityTurn("end_turn", undefined, now), undefined);
    assert.equal(classifyAntigravityTurn("end_turn", { reachedModel: true }, now), undefined);
  });

  it("reads an HTTP status line", () => {
    const failure = classifyAntigravityTurn(
      "end_turn",
      failed("Error 502, Message: upstream connect error, Status: 502 Bad Gateway, Details: []"),
      now,
    );
    assert.equal(failure.kind, "provider_error");
    assert.equal(
      failure.message,
      "Antigravity error (502 502 Bad Gateway): upstream connect error",
    );
  });

  it("reads the STATUS (code NNN) form", () => {
    const failure = classifyAntigravityTurn(
      "end_turn",
      failed("UNAVAILABLE (code 503): The model is overloaded. Try again later."),
      now,
    );
    assert.equal(failure.code, "UNAVAILABLE");
    assert.match(
      failure.message,
      /^Antigravity error \(503 UNAVAILABLE\): The model is overloaded/,
    );
  });

  it("names an exhausted quota and when it resets", () => {
    const byDelay = classifyAntigravityTurn(
      "end_turn",
      failed(
        "Error 429, Message: exhausted, Status: RESOURCE_EXHAUSTED, Details: [reason:QUOTA_EXHAUSTED quotaResetDelay:1h30m0s]",
      ),
      now,
    );
    assert.equal(byDelay.kind, "usage_limit");
    assert.equal(byDelay.resetAt, now + 90 * 60_000);
    assert.equal(
      byDelay.message,
      "You've reached your Antigravity quota for this period. It resets in 1h 30m.",
    );
    const byStamp = classifyAntigravityTurn(
      "end_turn",
      failed("reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-23T12:40:00Z]"),
      now,
    );
    assert.equal(byStamp.resetAt, Date.parse("2026-11-23T12:40:00Z"));
    assert.match(byStamp.message, /resets in 40m\.$/);
  });

  it("treats a refusal as an exhausted quota even without a log", () => {
    const failure = classifyAntigravityTurn("refusal", undefined, now);
    assert.equal(failure.kind, "usage_limit");
    assert.equal(failure.message, "You've reached your Antigravity quota for this period.");
  });

  it("separates a plain rate limit from a quota", () => {
    const failure = classifyAntigravityTurn(
      "end_turn",
      failed(
        "Error 429, Message: Too many requests., Status: RESOURCE_EXHAUSTED, Details: [retryDelay:40s]",
      ),
      now,
    );
    assert.equal(failure.kind, "usage_limit");
    assert.equal(failure.message, "Antigravity is rate limited: Too many requests. Retry in 40s.");
  });

  it("flags a conversation whose thinking signature is invalid", () => {
    const failure = classifyAntigravityTurn(
      "end_turn",
      failed(
        "Error 400, Message: messages.3.content.0.thinking.signature: Field required, Status: INVALID_ARGUMENT",
      ),
      now,
    );
    assert.equal(failure.broken, true);
    assert.match(failure.message, /Start a new chat/);
  });

  it("falls back to a generic message for an unrecognised error", () => {
    assert.equal(
      classifyAntigravityTurn("end_turn", failed("panic: something odd"), now).message,
      "Antigravity stopped this turn because of an error.",
    );
  });

  it("formats reset delays", () => {
    assert.equal(formatAntigravityResetDelay(now + 5_000, now), "in 5s");
    assert.equal(formatAntigravityResetDelay(now + 2 * 3_600_000, now), "in 2h");
  });

  it("reads the steps a prompt added from the conversation database", () => {
    const home = mkdtempSync(join(tmpdir(), "relay-agy-steps-"));
    try {
      assert.equal(readAntigravityLastStepIndex(home, "conv"), -1);
      assert.equal(readAntigravityTurnErrorStep(home, "conv", -1), undefined);
      const conversations = join(home, "antigravity-cli", "conversations");
      mkdirSync(conversations, { recursive: true });
      const db = new DatabaseSync(join(conversations, "conv.db"));
      db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)");
      db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(0, 14, Buffer.from("prompt"));
      db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(1, 15, Buffer.from("reply"));
      assert.equal(readAntigravityLastStepIndex(home, "conv"), 1);
      assert.equal(readAntigravityTurnErrorStep(home, "conv", 1), undefined);
      db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(2, 14, Buffer.from("prompt"));
      db.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(
        3,
        17,
        Buffer.from("Error 500, Message: boom, Status: INTERNAL"),
      );
      db.close();
      assert.deepEqual(readAntigravityTurnErrorStep(home, "conv", 1), {
        errorText: "Error 500, Message: boom, Status: INTERNAL",
        reachedModel: false,
      });
      assert.equal(readAntigravityTurnErrorStep(home, "../conv", 1), undefined);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detects a reply agy has queued", () => {
    const home = mkdtempSync(join(tmpdir(), "relay-agy-inbox-"));
    try {
      const generated = join(home, "antigravity-cli", "brain", "conv", ".system_generated");
      const inbox = join(generated, "messages");
      mkdirSync(inbox, { recursive: true });
      mkdirSync(join(generated, "logs"), { recursive: true });
      assert.equal(hasAntigravityPendingReply(home, "conv"), false);
      writeFileSync(
        join(inbox, "low.json"),
        JSON.stringify({ id: "low", priority: "MESSAGE_PRIORITY_LOW" }),
      );
      assert.equal(hasAntigravityPendingReply(home, "conv"), false);
      writeFileSync(
        join(inbox, "high.json"),
        JSON.stringify({ id: "high", priority: "MESSAGE_PRIORITY_HIGH" }),
      );
      assert.equal(hasAntigravityPendingReply(home, "conv"), true);
      writeFileSync(join(inbox, "read.json"), JSON.stringify({ high: true }));
      assert.equal(hasAntigravityPendingReply(home, "conv"), false);

      // Dequeued but not yet answered: the transcript ends on the system step.
      const transcript = join(generated, "logs", "transcript_full.jsonl");
      const step = (type, content) => JSON.stringify({ type, content }) + "\n";
      writeFileSync(
        transcript,
        step("SYSTEM_MESSAGE", "[Message] sender=x priority=MESSAGE_PRIORITY_HIGH content=done"),
      );
      assert.equal(hasAntigravityPendingReply(home, "conv"), true);
      writeFileSync(
        transcript,
        step("SYSTEM_MESSAGE", "[Message] sender=x priority=MESSAGE_PRIORITY_LOW content=fyi"),
      );
      assert.equal(hasAntigravityPendingReply(home, "conv"), false);
      writeFileSync(
        transcript,
        step("SYSTEM_MESSAGE", "[Message] sender=x priority=MESSAGE_PRIORITY_HIGH content=done") +
          step("PLANNER_RESPONSE", "Got it."),
      );
      assert.equal(hasAntigravityPendingReply(home, "conv"), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("recognises a request to run one of Relay's own tools", () => {
    const raw = (ServerName, ToolName, extra = {}) => ({
      rawInput: { ServerName, ToolName, ...extra },
    });
    assert.equal(antigravityRelayToolRequest(raw("relay", "ui_render")), "ui_render");
    assert.equal(antigravityRelayToolRequest(raw("relay", "rm_rf")), undefined);
    assert.equal(antigravityRelayToolRequest(raw("github", "ui_render")), undefined);
    assert.equal(
      antigravityRelayToolRequest(raw("relay", "ui_render", { CommandLine: "rm -rf /" })),
      undefined,
    );
    assert.equal(antigravityRelayToolRequest({ title: "Run mcp_relay_chat_send" }), "chat_send");
    assert.equal(antigravityRelayToolRequest({ name: "mcp_relay_delegate_task" }), "delegate_task");
    assert.equal(antigravityRelayToolRequest({ title: "Run mcp_github_create_issue" }), undefined);
    // agy's rawInput is authoritative over a name that only looks like Relay's.
    assert.equal(
      antigravityRelayToolRequest({
        name: "mcp_relay_ui_render",
        rawInput: { ServerName: "other", ToolName: "ui_render" },
      }),
      undefined,
    );
  });
});

describe("ACP connection", () => {
  it("closes on a stdin write error instead of crashing", async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        const error = new Error("write EPIPE");
        error.code = "EPIPE";
        callback(error);
      },
    });
    const connection = new AcpConnection(child, { onNotification() {}, onRequest() {} });
    const first = connection.request("initialize", {});
    await assert.rejects(first, /EPIPE/);
    assert.equal(connection.isClosed, true);
    await assert.rejects(connection.request("session/prompt", {}), /EPIPE/);
  });
});

describe("antigravity watcher state", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-agy-watch-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const writeSteps = (id, steps) => {
    const path = antigravityTranscriptPath(join(dir, "home"), id);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, steps.map((step) => JSON.stringify(step)).join("\n") + "\n");
    return path;
  };

  it("seeds pending calls and subagents from before the first watched step", () => {
    const childId = "c0ffee00-0000-4000-8000-0000000000aa";
    const path = writeSteps("w1", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "go" },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        input_tokens: 100,
        tool_calls: [
          { name: "invoke_subagent", args: { Prompt: "count", Role: "Counter" } },
          { name: "read_file", args: { Path: "/tmp/x.txt" } },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        content: `Created the following subagent: { "conversationId": "${childId}" }`,
      },
    ]);
    const stats = { inputTokens: 7, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    const files = new Map();
    const ctx = seedAntigravityReplayContext(path, 3, { sessionId: "w1", stats, files });
    assert.equal(ctx.stats, stats, "the chat's own stats object");
    assert.equal(stats.inputTokens, 7, "history's tokens are not counted again");
    assert.equal(ctx.files, files);
    assert.equal(ctx.pendingCalls.length, 1, "the read is still waiting for its result");
    assert.equal(ctx.childAgents.get(childId), "w1:1:0");

    // The read's result, appended after the watcher attached, resolves.
    const [result] = convertAntigravityTranscriptEntry(
      { step_index: 3, source: "MODEL", type: "VIEW_FILE", content: "hello" },
      ctx,
    ).map((entry) => entry.message);
    assert.equal(result.activity, "tool_result");
    assert.equal(result.toolUseId, "w1:1:1");

    // So does the child's later report.
    const [report] = convertAntigravityTranscriptEntry(
      {
        step_index: 4,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: `[Message] timestamp=t sender=${childId} priority=HIGH content=Done.`,
      },
      ctx,
    ).map((entry) => entry.message);
    assert.equal(report.agent.agentId, "w1:1:0");
    assert.equal(report.agent.status, "completed");
  });

  it("points the watcher at the chat's current maps on every step", () => {
    const manager = new InstanceManager(
      resolveConfig({
        logger: silentLogger,
        dbPath: join(dir, "sessions.db"),
        providerDirs: { claude: join(dir, ".claude"), codex: join(dir, ".codex") },
        workingDirectory: dir,
      }),
    );
    try {
      const path = writeSteps("w2", [
        { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hi" },
      ]);
      const instance = {
        info: { workingDirectory: dir },
        tasks: new Map(),
        files: new Map(),
        watchState: { jsonlPath: path, stats: { inputTokens: 0, outputTokens: 0 } },
      };
      const first = manager.antigravityWatcherContext(instance, { step_index: 1 });
      first.pendingCalls.push({ id: "kept", view: {} });
      // Hydrate replaces the chat's maps and stats.
      instance.files = new Map();
      instance.tasks = new Map();
      instance.watchState.stats = { inputTokens: 5, outputTokens: 0 };
      const second = manager.antigravityWatcherContext(instance, { step_index: 2 });
      assert.equal(second, first, "replay state carries over");
      assert.equal(second.pendingCalls[0].id, "kept");
      assert.equal(second.files, instance.files);
      assert.equal(second.tasks, instance.tasks);
      assert.equal(second.stats, instance.watchState.stats);
    } finally {
      manager.stopAll();
    }
  });
});

describe("antigravity external discovery", () => {
  let home;
  const cwd = mkdtempSync(join(tmpdir(), "relay-agy-cwd-"));
  before(() => {
    home = mkdtempSync(join(tmpdir(), "relay-agy-disc-"));
    const cache = join(home, "antigravity-cli", "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "last_conversations.json"), JSON.stringify({ [cwd]: "conv-last" }));
    writeFileSync(
      join(cache, "conversation_metadata.json"),
      JSON.stringify({
        conversations: {
          "conv-other": {
            summary: { WorkspaceURIs: [`file://${cwd}`], UpdatedAt: new Date().toISOString() },
          },
        },
      }),
    );
    for (const id of ["conv-last", "conv-other"]) {
      const path = antigravityTranscriptPath(home, id);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "");
    }
    clearAntigravityMetadataCache();
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const discover = (info) =>
    discoverAntigravityExternalSessions({
      runningProcessCwds: new Map([["agy", new Map([[cwd, info]])]]),
      providerDirs: { antigravity: home },
      excludePids: new Set(),
      registeredDirectories: new Set([cwd]),
    });

  it("attaches the PID only when one agy process runs in the folder", async () => {
    const single = await discover({ count: 1, pids: [111] });
    assert.deepEqual(
      single.map((session) => [session.sessionId, session.pid]),
      [["conv-last", 111]],
    );
  });

  it("lists sessions without PIDs when several share the folder", async () => {
    const several = await discover({ count: 2, pids: [111, 222] });
    assert.deepEqual(
      several.map((session) => [session.sessionId, session.pid]),
      [
        ["conv-last", undefined],
        ["conv-other", undefined],
      ],
    );
  });
});
