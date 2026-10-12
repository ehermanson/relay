import "./test-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "relay-transcript-cache-"));
  const manager = new InstanceManager(
    resolveConfig({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      dbPath: join(directory, "sessions.db"),
      providerDirs: { claude: join(directory, "claude"), codex: join(directory, "codex") },
    }),
  );
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      manager.stopAll();
      stopped = true;
    }
  };
  t.after(() => {
    stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, manager, stop };
}

function transcript(provider, path, text) {
  const timestamp = "2026-10-12T12:00:00.000Z";
  const rows =
    provider === "claude"
      ? [
          { type: "system", subtype: "init", cwd: tmpdir(), timestamp },
          { type: "user", timestamp, message: { role: "user", content: "Inspect this Project" } },
          {
            type: "assistant",
            timestamp,
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
        ]
      : [
          {
            timestamp,
            type: "session_meta",
            payload: { id: path, timestamp, cwd: tmpdir(), source: "cli" },
          },
          {
            timestamp,
            type: "event_msg",
            payload: { type: "user_message", message: "Inspect this Project" },
          },
          { timestamp, type: "event_msg", payload: { type: "agent_message", message: text } },
        ];
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
const parse = (manager, provider, path) => manager.parseProviderTranscriptCached(provider, path);
const stats = (manager) => manager.getMemoryDiagnostics().transcriptCache;

for (const provider of ["claude", "codex"]) {
  test(`${provider} cached history isolates caller mutations and retains only the current file version`, (t) => {
    const { directory, manager } = fixture(t);
    const path = join(directory, `${provider}.jsonl`);
    transcript(provider, path, "Original response");
    const first = parse(manager, provider, path);
    const expected = structuredClone(first.parsed);
    first.parsed.history[0].message.text = "Caller mutation";
    first.parsed.history.pop();
    first.parsed.tasks.set("caller", { id: "caller", subject: "not from transcript" });
    first.parsed.files.set("caller", { path: "caller", editCount: 1, type: "added" });
    first.parsed.stats.inputTokens = 9999;
    const hit = parse(manager, provider, path);
    assert.equal(hit.cacheHit, true);
    assert.deepEqual(hit.parsed, expected);
    for (let version = 0; version < 20; version++) {
      transcript(provider, path, `Updated response ${version}`);
      utimesSync(path, Date.now() / 1000, Date.now() / 1000 + version + 1);
      const updated = parse(manager, provider, path);
      assert.equal(updated.cacheHit, false);
      assert.ok(
        updated.parsed.history.some(
          (entry) => entry.message.text === `Updated response ${version}`,
        ),
      );
      assert.equal(stats(manager).entries, 1, "previous metadata versions are released");
    }
    unlinkSync(path);
    try {
      parse(manager, provider, path);
    } catch {
      /* Provider may reject a deleted transcript. */
    }
    assert.equal(stats(manager).entries, 0);
    assert.equal(stats(manager).estimatedBytes, 0);
  });
}

test("large transcripts obey a shared byte budget and evict least-recently-used results across providers", (t) => {
  const { directory, manager, stop } = fixture(t);
  const paths = ["claude-a", "codex-b", "claude-c"].map((name) => join(directory, `${name}.jsonl`));
  const providers = ["claude", "codex", "claude"];
  const text = "x".repeat(4 * 1024 * 1024);
  for (let index = 0; index < paths.length; index++)
    transcript(providers[index], paths[index], text);
  parse(manager, providers[0], paths[0]);
  parse(manager, providers[1], paths[1]);
  assert.equal(parse(manager, providers[0], paths[0]).cacheHit, true, "refresh the oldest result");
  parse(manager, providers[2], paths[2]);
  assert.equal(stats(manager).entries, 2, "byte budget evicts long results before the entry cap");
  assert.ok(stats(manager).estimatedBytes <= stats(manager).maxBytes);
  assert.equal(parse(manager, providers[0], paths[0]).cacheHit, true);
  assert.equal(
    parse(manager, providers[1], paths[1]).cacheHit,
    false,
    "least recently used provider result was evicted",
  );
  stop();
  assert.equal(stats(manager).estimatedBytes, 0, "shutdown releases cached history");
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} oversized results are not retained and remain independent across reads`, (t) => {
    const { directory, manager } = fixture(t);
    const path = join(directory, `${provider}-oversized.jsonl`);
    transcript(provider, path, "x".repeat(17 * 1024 * 1024));
    const first = parse(manager, provider, path);
    assert.equal(first.cacheHit, false);
    assert.equal(stats(manager).entries, 0);
    first.parsed.history[0].message.text = "Caller mutation";
    const second = parse(manager, provider, path);
    assert.equal(second.cacheHit, false);
    assert.notEqual(second.parsed.history[0].message.text, "Caller mutation");
    assert.equal(stats(manager).estimatedBytes, 0);
  });
}
