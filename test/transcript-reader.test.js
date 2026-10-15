import "./test-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptReader,
  readTranscriptLines,
  TranscriptHistory,
} from "../dist/server/core/transcript-reader.js";
import { parseCodexTranscript } from "../dist/server/core/providers/codex-transcript.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";

function fixture(t, content) {
  const root = mkdtempSync(join(tmpdir(), "relay-transcript-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, content);
  return path;
}

test("chunked transcript reads preserve multibyte boundaries, long records and final unterminated lines", (t) => {
  const long = "x".repeat(65534) + "😀" + "語".repeat(100000);
  const path = fixture(t, `\n${long}\r\nlast😀`);
  assert.deepEqual([...readTranscriptLines(path)], ["", `${long}\r`, "last😀"]);
  assert.deepEqual([...readTranscriptLines(fixture(t, ""))], []);
  assert.deepEqual([...readTranscriptLines(fixture(t, "one\n"))], ["one"]);
});

test("multi-pass replay uses its original file length, and readers close explicitly", (t) => {
  const path = fixture(t, "first\nsecond\n");
  const reader = new TranscriptReader(path);
  try {
    assert.deepEqual([...reader.lines()], ["first", "second"]);
    appendFileSync(path, "later\n");
    assert.deepEqual([...reader.lines()], ["first", "second"]);
  } finally {
    reader.close();
  }
  reader.close();
  assert.throws(() => [...reader.lines()], /closed/);
  assert.deepEqual([...readTranscriptLines(path)], ["first", "second", "later"]);
  assert.throws(() => [...readTranscriptLines(`${path}.missing`)], { code: "ENOENT" });
});

test("history tail stays ordered across multiple wraps and large batches", () => {
  const history = new TranscriptHistory(3);
  history.append([0, 1]);
  assert.deepEqual(history.toArray(), [0, 1]);
  history.append([2, 3, 4, 5, 6, 7]);
  assert.deepEqual(history.toArray(), [5, 6, 7]);
  history.append([8]);
  assert.deepEqual(history.toArray(), [6, 7, 8]);
});

// Parsing is independent of the running manager; use its actual conversion
// methods without starting discovery, a database, or Provider processes.
const manager = Object.create(InstanceManager.prototype);
const timestamp = "2026-01-01T00:00:00Z";
const assistant = (provider, text) =>
  provider === "claude"
    ? {
        type: "assistant",
        timestamp,
        message: {
          model: "claude-test",
          content: [{ type: "text", text }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }
    : { type: "event_msg", timestamp, payload: { type: "agent_message", message: text } };
const parse = (provider, path) =>
  provider === "claude" ? manager.parseJsonl(path) : parseCodexTranscript(path);

for (const provider of ["claude", "codex"]) {
  test(`${provider} replay preserves long Unicode records and skips malformed or unfinished appends`, (t) => {
    const text = "x".repeat(65535) + "😀" + "語".repeat(30000);
    const path = fixture(
      t,
      `${JSON.stringify(assistant(provider, text))}\r\nmalformed\n\n${JSON.stringify(assistant(provider, "final"))}`,
    );
    const before = parse(provider, path);
    assert.deepEqual(
      before.history
        .filter((e) => e.message.type === "output" && e.message.text)
        .map((e) => e.message.text),
      [text, "final"],
    );
    appendFileSync(path, '\n{"type":"assistant","unfinished":');
    assert.deepEqual(parse(provider, path).history, before.history);
    assert.deepEqual(parse(provider, `${path}.missing`).history, []);
  });

  test(`${provider} replay retains the same last1000 entries while accounting for earlier usage`, (t) => {
    const entries = [];
    for (let index = 0; index < 1300; index++)
      entries.push(assistant(provider, `message ${index}`));
    if (provider === "codex")
      entries.push({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 1300, output_tokens: 2600 } },
        },
      });
    const result = parse(provider, fixture(t, entries.map(JSON.stringify).join("\n")));
    assert.equal(result.history.length, 1000);
    // Claude preserves a separate end-of-turn output per assistant record.
    assert.equal(
      result.history[0].message.text,
      provider === "claude" ? "message 800" : "message 300",
    );
    assert.equal(result.history.findLast((e) => e.message.text)?.message.text, "message 1299");
    assert.equal(result.stats.inputTokens, 1300);
    assert.equal(result.stats.outputTokens, 2600);
  });
}

test("Claude replay uses only the last valid compact boundary for state rebuilding", (t) => {
  const entries = [
    {
      type: "user",
      timestamp,
      cwd: "/tmp/relay-stream-project",
      message: { content: "original request" },
    },
    {
      type: "assistant",
      timestamp,
      message: {
        content: [
          {
            type: "tool_use",
            id: "old",
            name: "Write",
            input: { file_path: "/tmp/relay-stream-project/old.txt", content: "old" },
          },
        ],
      },
    },
    { type: "system", subtype: "compact_boundary", timestamp },
    assistant("claude", "middle"),
    { type: "system", subtype: "compact_boundary", timestamp },
    {
      type: "assistant",
      timestamp,
      message: {
        content: [
          {
            type: "tool_use",
            id: "new",
            name: "Write",
            input: { file_path: "/tmp/relay-stream-project/new.txt", content: "new" },
          },
        ],
      },
    },
    assistant("claude", "after"),
  ];
  const result = parse(
    "claude",
    fixture(t, entries.map(JSON.stringify).join("\n") + '\n{"subtype":"compact_boundary"'),
  );
  assert.equal(result.cwd, "/tmp/relay-stream-project");
  assert.ok(
    result.history.some((e) => e.message.type === "user" && e.message.text === "original request"),
  );
  assert.ok(result.history.some((e) => e.message.type === "output" && e.message.text === "middle"));
  assert.equal(result.files.has("/tmp/relay-stream-project/old.txt"), false);
  assert.equal(result.files.has("/tmp/relay-stream-project/new.txt"), true);
});
