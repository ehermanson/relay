import "./test-env.js";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import {
  readUiView,
  resolveUiResponse,
  summarizeUiView,
  UI_RENDER_EVENT,
  UiSpecError,
  validateUiRoot,
} from "../dist/server/core/ui-render.js";
import { buildChatView } from "../dist/server/core/orchestration/chat-view.js";
import { handleMcpPayload } from "../dist/server/core/orchestration/mcp-protocol.js";
import { createRelayMcpServer } from "../dist/server/core/orchestration/tools.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import { noopLogger } from "../dist/server/core/logger.js";
import { registerInstanceRoutes } from "../dist/server/routes/instances.js";

const BOARD = {
  type: "stack",
  children: [
    {
      type: "metrics",
      items: [{ label: "Tests", value: 1349, tone: "success", trend: [1, 2, 3] }],
    },
    {
      type: "table",
      columns: [
        { key: "check", label: "Check" },
        { key: "state", label: "State" },
      ],
      rows: [{ check: "CI", state: { text: "passed", tone: "success" } }],
    },
    { type: "list", items: [{ label: "Build", status: "done" }] },
    {
      type: "actions",
      items: [
        { id: "ship", label: "Ship it", reply: "Ship it to main", variant: "primary" },
        { id: "hold", label: "Hold", reply: "Hold" },
      ],
    },
    {
      type: "chart",
      kind: "bar",
      labels: ["a", "b"],
      series: [{ name: "runs", values: [1, 2] }],
    },
  ],
};

const PICK = {
  type: "choice",
  id: "target",
  prompt: "Deploy to",
  multiple: true,
  options: [
    { value: "us", label: "US" },
    { value: "eu", label: "EU" },
  ],
};

const errorFor = (root) => {
  try {
    validateUiRoot(root);
  } catch (error) {
    assert.ok(error instanceof UiSpecError);
    return error.message;
  }
  return null;
};

describe("ui_render specs", () => {
  it("accepts a well-formed view and keeps only known fields", () => {
    const root = validateUiRoot(BOARD);
    assert.deepEqual(root, BOARD);
  });

  it("names the exact path of a bad field", () => {
    assert.match(
      errorFor({ type: "stack", children: [{ type: "tabel" }] }),
      /^root\.children\[0\]\.type: unknown node type "tabel"/,
    );
    assert.match(
      errorFor({ type: "table", colums: [], columns: [{ key: "a", label: "A" }], rows: [] }),
      /^root\.colums: unknown field/,
    );
    assert.match(
      errorFor({ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ b: 1 }] }),
      /^root\.rows\[0\]\.b: not one of the table's column keys/,
    );
    assert.match(
      errorFor({
        type: "chart",
        kind: "line",
        labels: ["a", "b"],
        series: [{ name: "x", values: [1] }],
      }),
      /root\.series\[0\]\.values: has 1 values for 2 labels/,
    );
    assert.match(
      errorFor({ type: "list", items: [{ label: "x", href: "javascript:alert(1)" }] }),
      /root\.items\[0\]\.href: links must be/,
    );
    assert.match(
      errorFor({
        type: "actions",
        items: [
          { id: "a", label: "A", reply: "A" },
          { id: "a", label: "B", reply: "B" },
        ],
      }),
      /root\.items\[1\]\.id: duplicate id "a"/,
    );
  });

  it("allows one answer per view: at most one actions or choice", () => {
    assert.match(
      errorFor({ type: "stack", children: [BOARD.children[3], PICK] }),
      /^root\.children\[1\]: a view takes one answer, and root\.children\[0\] already asks for it/,
    );
    assert.deepEqual(validateUiRoot(PICK), PICK);
  });

  it("enforces depth and size limits", () => {
    let deep = { type: "text", markdown: "x" };
    for (let i = 0; i < 9; i++) deep = { type: "stack", children: [deep] };
    assert.match(errorFor(deep), /nested deeper than 8/);
    const big = {
      type: "stack",
      children: Array.from({ length: 30 }, () => ({ type: "text", markdown: "x".repeat(19_000) })),
    };
    assert.match(errorFor(big), /the limit is 256 KB/);
  });

  it("reads unknown node types from a newer server as unsupported blocks", () => {
    const view = readUiView({
      id: "v1",
      title: "T",
      version: 2,
      updatedAt: 1,
      root: {
        type: "stack",
        children: [
          { type: "hologram", spin: true },
          { type: "text", markdown: "hi" },
        ],
      },
    });
    assert.deepEqual(view.root.children[0], { type: "unsupported", originalType: "hologram" });
    assert.equal(readUiView({ id: "bad id!", title: "T", updatedAt: 1, root: BOARD }), null);
  });

  it("derives replies from the view, never from the client", () => {
    const view = { id: "v", title: "T", version: 1, updatedAt: 1, root: validateUiRoot(BOARD) };
    assert.deepEqual(resolveUiResponse(view, "ship"), { ok: true, reply: "Ship it to main" });
    const pick = { ...view, root: validateUiRoot(PICK) };
    assert.deepEqual(resolveUiResponse(pick, "target", ["eu", "us"]), {
      ok: true,
      reply: "Deploy to: US, EU",
      values: ["eu", "us"],
    });
    assert.equal(resolveUiResponse(pick, "target", ["mars"]).ok, false);
    assert.equal(resolveUiResponse(pick, "target", []).ok, false);
    assert.equal(
      resolveUiResponse({ ...pick, root: validateUiRoot({ ...PICK, multiple: false }) }, "target", [
        "us",
        "eu",
      ]).ok,
      false,
      "a single choice takes one option",
    );
    assert.equal(resolveUiResponse(view, "nope").ok, false);
    const answered = { ...view, response: { actionId: "ship", reply: "Ship it to main", at: 2 } };
    assert.equal(resolveUiResponse(answered, "hold").ok, false, "one answer per view");
  });

  it("summarizes a view as text for chat_read", () => {
    const text = summarizeUiView({
      id: "v",
      title: "Release",
      version: 1,
      updatedAt: 1,
      root: validateUiRoot(BOARD),
      response: { actionId: "ship", reply: "Ship it to main", at: 2 },
    });
    assert.match(text, /^\[View\] Release/);
    assert.match(text, /Tests: 1349/);
    assert.match(text, /CI \| passed/);
    assert.match(text, /- \[done\] Build/);
    assert.match(text, /Buttons: Ship it, Hold/);
    assert.match(text, /Answered: Ship it to main/);
    const page = buildChatView([
      {
        timestamp: 5,
        message: {
          type: "system_event",
          event: UI_RENDER_EVENT,
          payload: { id: "v", title: "Release", version: 1, updatedAt: 1, root: BOARD },
        },
      },
    ]);
    assert.equal(page.items[0].role, "view");
    assert.match(page.items[0].text, /^\[View\] Release/);
  });
});

describe("ui_render tool", () => {
  const server = createRelayMcpServer("test");
  const published = [];
  const host = {
    getChat: (id) => (id === "caller" ? { id: "caller", name: "Caller" } : undefined),
    publishUiView: (callerId, view) => {
      published.push({ callerId, ...view });
      return { id: view.id ?? "generated", updated: view.id === "known" };
    },
  };
  const call = async (args) =>
    (
      await handleMcpPayload(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ui_render", arguments: args },
        },
        server,
        { host, callerId: "caller" },
      )
    ).result;

  it("publishes a validated view and reports its id", async () => {
    const result = await call({ title: "Board", root: BOARD });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.id, "generated");
    assert.equal(result.structuredContent.updated, false);
    assert.deepEqual(published.at(-1), { callerId: "caller", title: "Board", root: BOARD });
    const update = await call({ id: "known", title: "Board", root: BOARD });
    assert.equal(update.structuredContent.updated, true);
  });

  it("returns spec errors with their path", async () => {
    const before = published.length;
    const result = await call({ title: "Bad", root: { type: "metrics", items: [{ label: "x" }] } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "invalid_request");
    assert.match(result.structuredContent.error.message, /root\.items\[0\]\.value/);
    assert.equal((await call({ title: "Bad", id: "no spaces", root: BOARD })).isError, true);
    assert.equal((await call({ root: BOARD })).isError, true);
    assert.equal(published.length, before);
  });
});

describe("ui_render storage, updates, and answers", () => {
  it("updates a view in place and sends the user's answer once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-ui-render-"));
    const manager = new InstanceManager(
      resolveConfig({
        logger: noopLogger,
        dbPath: join(dir, "sessions.db"),
        providerDirs: { claude: join(dir, ".claude"), codex: join(dir, ".codex") },
        workingDirectory: dir,
      }),
    );
    const sent = [];
    manager.sendMessage = async (id, text) => {
      sent.push({ id, text });
      return undefined;
    };
    const events = [];
    manager.on("instance:system_event", (id, message) => events.push(message));
    try {
      const info = manager.createInstance({ workingDirectory: dir });
      const root = validateUiRoot(BOARD);
      const first = manager.publishUiView(info.id, { id: "board", title: "Board", root });
      assert.deepEqual(first, { id: "board", updated: false });
      const [row] = manager.db.getSessionEvents(info.id);

      const progress = validateUiRoot({ type: "progress", value: 50 });
      assert.deepEqual(
        manager.publishUiView(info.id, { id: "board", title: "Board", root: progress }),
        {
          id: "board",
          updated: true,
        },
      );
      const rows = manager.db.getSessionEvents(info.id);
      assert.equal(rows.length, 1, "an update rewrites the view's one row");
      assert.equal(rows[0].timestamp, row.timestamp, "and keeps its position");
      assert.deepEqual(JSON.parse(rows[0].payload_json).root, progress);
      const views = manager.instances
        .get(info.id)
        .history.filter((e) => e.message.event === UI_RENDER_EVENT);
      assert.equal(views.length, 1, "live history holds one entry per view");
      assert.deepEqual(views[0].message.payload.root, progress);

      const generated = manager.publishUiView(info.id, { title: "Other", root });
      assert.notEqual(generated.id, "board");

      const hono = new Hono();
      registerInstanceRoutes(hono, { instanceManager: manager });
      const answer = (viewId, body) =>
        hono.request(`/api/instances/${info.id}/ui-views/${viewId}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      assert.equal(
        (await answer("board", { actionId: "ship" })).status,
        400,
        "not in this view now",
      );
      manager.publishUiView(info.id, { id: "pick", title: "Pick", root: validateUiRoot(PICK) });
      const ok = await answer("pick", { actionId: "target", values: ["us"] });
      assert.equal(ok.status, 200);
      assert.deepEqual(sent, [{ id: info.id, text: "Deploy to: US" }]);
      const pickRow = manager.db
        .getSessionEvents(info.id)
        .find((row) => JSON.parse(row.payload_json).id === "pick");
      assert.deepEqual(readUiView(JSON.parse(pickRow.payload_json)).response.values, ["us"]);
      assert.equal(
        events.at(-1).payload.response.reply,
        "Deploy to: US",
        "every device sees the answer",
      );
      assert.equal(
        (await answer("pick", { actionId: "target", values: ["eu"] })).status,
        409,
        "answered once",
      );
      assert.equal(sent.length, 1);

      manager.publishUiView(info.id, { id: "board", title: "Board", root });
      assert.equal((await answer("board", { actionId: "ship" })).status, 200);
      assert.equal(
        (await answer("board", { actionId: "hold" })).status,
        409,
        "one answer per view",
      );
      assert.equal(sent.length, 2);
      assert.equal((await answer("missing", { actionId: "ship" })).status, 404);

      manager.publishUiView(info.id, { id: "board", title: "Board", root });
      assert.equal(
        readUiView(JSON.parse(manager.db.getSessionEvents(info.id)[0].payload_json)).response,
        undefined,
        "an update clears the answer",
      );
      assert.equal((await answer("board", { actionId: "hold" })).status, 200);
      assert.equal(sent.at(-1).text, "Hold");
    } finally {
      manager.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doesn't stamp an answer onto a view replaced while it was sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-ui-render-race-"));
    const manager = new InstanceManager(
      resolveConfig({
        logger: noopLogger,
        dbPath: join(dir, "sessions.db"),
        providerDirs: { claude: join(dir, ".claude"), codex: join(dir, ".codex") },
        workingDirectory: dir,
      }),
    );
    try {
      const info = manager.createInstance({ workingDirectory: dir });
      const root = validateUiRoot(BOARD);
      manager.publishUiView(info.id, { id: "board", title: "Board", root });
      manager.sendMessage = async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        manager.publishUiView(info.id, { id: "board", title: "Shipping", root });
        return undefined;
      };
      await manager.answerUiView(info.id, "board", "ship");
      const stored = readUiView(JSON.parse(manager.db.getSessionEvents(info.id)[0].payload_json));
      assert.equal(stored.title, "Shipping");
      assert.equal(stored.response, undefined);
    } finally {
      manager.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
