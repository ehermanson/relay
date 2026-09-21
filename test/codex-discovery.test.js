import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isSubagentSessionMeta,
  listCodexTranscripts,
  readCodexSessionMeta,
  selectCodexExternalTranscripts,
} from "../dist/server/core/providers/codex-discovery.js";

describe("isSubagentSessionMeta", () => {
  it("recognises both the thread_source and nested source spellings", () => {
    assert.equal(isSubagentSessionMeta({ thread_source: "subagent", source: "vscode" }), true);
    assert.equal(
      isSubagentSessionMeta({ source: { subagent: { thread_spawn: { depth: 1 } } } }),
      true,
    );
    assert.equal(isSubagentSessionMeta({ source: "vscode", thread_source: "user" }), false);
    assert.equal(isSubagentSessionMeta({ source: "exec" }), false);
    assert.equal(isSubagentSessionMeta(undefined), false);
  });
});

const NOW = Date.parse("2026-09-05T03:37:34.000Z");
const WINDOW = 90_000;

function candidate(path, ageMs) {
  return { path, mtime: NOW - ageMs };
}

describe("selectCodexExternalTranscripts", () => {
  const metaByPath = {
    "/s/a.jsonl": {
      sessionId: "a",
      cwd: "/proj/sdo",
      originator: "Codex Desktop",
      subagent: false,
    },
    "/s/b.jsonl": {
      sessionId: "b",
      cwd: "/proj/sdo",
      originator: "Codex Desktop",
      subagent: false,
    },
    "/s/c.jsonl": {
      sessionId: "c",
      cwd: "/proj/other",
      originator: "codex_cli_rs",
      subagent: false,
    },
    "/s/old.jsonl": {
      sessionId: "old",
      cwd: "/proj/sdo",
      originator: "Codex Desktop",
      subagent: false,
    },
    "/s/relay.jsonl": { sessionId: "r", cwd: "/proj/sdo", originator: "relay", subagent: false },
    "/s/sub.jsonl": { sessionId: "sub", cwd: "/proj/sdo", originator: "relay", subagent: true },
  };
  const readMeta = (c) => metaByPath[c.path] ?? null;
  const registered = new Set(["/proj/sdo", "/proj/other"]);
  const isRegisteredDirectory = (cwd) => registered.has(cwd);

  it("reports still-being-written rollouts in registered cwds without a process", () => {
    const selected = selectCodexExternalTranscripts({
      transcripts: [
        candidate("/s/a.jsonl", 5_000),
        candidate("/s/b.jsonl", 40_000),
        candidate("/s/old.jsonl", 3 * 60 * 60 * 1000),
      ],
      readMeta,
      processCwds: new Map(),
      isRegisteredDirectory,
      activeSince: NOW - WINDOW,
    });
    assert.deepEqual(
      selected.map((s) => [s.sessionId, s.pid]),
      [
        ["a", undefined],
        ["b", undefined],
      ],
    );
  });

  it("never reports Relay-originated or sub-agent rollouts without a process", () => {
    const selected = selectCodexExternalTranscripts({
      transcripts: [
        candidate("/s/relay.jsonl", 1_000),
        candidate("/s/sub.jsonl", 1_000),
        candidate("/s/a.jsonl", 1_000),
      ],
      readMeta,
      processCwds: new Map(),
      isRegisteredDirectory,
      activeSince: NOW - WINDOW,
    });
    assert.deepEqual(
      selected.map((s) => s.sessionId),
      ["a"],
    );
  });

  it("pairs a process with the parent thread, not a newer sub-agent rollout", () => {
    const selected = selectCodexExternalTranscripts({
      transcripts: [candidate("/s/a.jsonl", 60_000), candidate("/s/sub.jsonl", 1_000)],
      readMeta,
      processCwds: new Map([["/proj/sdo", { count: 1, pids: [9] }]]),
      isRegisteredDirectory,
      activeSince: NOW - WINDOW,
    });
    assert.deepEqual(
      selected.map((s) => [s.sessionId, s.pid]),
      [["a", 9]],
    );
  });

  it("skips fresh rollouts whose cwd is not a registered project", () => {
    const selected = selectCodexExternalTranscripts({
      transcripts: [candidate("/s/c.jsonl", 1_000)],
      readMeta,
      processCwds: new Map(),
      isRegisteredDirectory: (cwd) => cwd === "/proj/sdo",
      activeSince: NOW - WINDOW,
    });
    assert.deepEqual(selected, []);
  });

  it("does not read meta for stale files when no process needs ranking", () => {
    let reads = 0;
    selectCodexExternalTranscripts({
      transcripts: [candidate("/s/old.jsonl", 10 * 60 * 1000), candidate("/s/a.jsonl", 1_000)],
      readMeta: (c) => {
        reads++;
        return readMeta(c);
      },
      processCwds: new Map(),
      isRegisteredDirectory,
      activeSince: NOW - WINDOW,
    });
    assert.equal(reads, 1);
  });

  it("pairs process-backed cwds with their most recent rollouts and keeps pids", () => {
    const selected = selectCodexExternalTranscripts({
      transcripts: [
        candidate("/s/old.jsonl", 3 * 60 * 60 * 1000),
        candidate("/s/a.jsonl", 20 * 60 * 1000),
        candidate("/s/b.jsonl", 10 * 60 * 1000),
      ],
      readMeta,
      processCwds: new Map([["/proj/sdo", { count: 1, pids: [4242] }]]),
      isRegisteredDirectory,
      activeSince: NOW - WINDOW,
    });
    // count=1 → only the newest rollout for that cwd, paired with the pid.
    assert.deepEqual(
      selected.map((s) => [s.sessionId, s.pid]),
      [["b", 4242]],
    );
  });

  it("merges both signals without duplicating a path", () => {
    const selected = selectCodexExternalTranscripts({
      transcripts: [candidate("/s/a.jsonl", 1_000), candidate("/s/b.jsonl", 2_000)],
      readMeta,
      processCwds: new Map([["/proj/sdo", { count: 1, pids: [7] }]]),
      isRegisteredDirectory,
      activeSince: NOW - WINDOW,
    });
    assert.deepEqual(
      selected.map((s) => [s.sessionId, s.pid]),
      [
        ["a", 7],
        ["b", undefined],
      ],
    );
  });
});

describe("readCodexSessionMeta / listCodexTranscripts", () => {
  it("reads only the first line even when session_meta exceeds one read chunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-discovery-"));
    try {
      const sessions = join(dir, "sessions", "2026", "09", "04");
      mkdirSync(sessions, { recursive: true });
      const filePath = join(sessions, "rollout-x.jsonl");
      const meta = {
        timestamp: "2026-09-05T03:03:13.449Z",
        type: "session_meta",
        payload: {
          id: "01a06f83",
          cwd: "/proj/sdo",
          base_instructions: { text: "x".repeat(100 * 1024) },
        },
      };
      writeFileSync(
        filePath,
        [JSON.stringify(meta), JSON.stringify({ type: "event_msg", payload: {} })].join("\n"),
      );
      const stamp = new Date(NOW);
      utimesSync(filePath, stamp, stamp);

      const listed = listCodexTranscripts(dir);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].path, filePath);
      assert.equal(Math.floor(listed[0].mtime), NOW);

      assert.deepEqual(readCodexSessionMeta(filePath, listed[0].mtime), {
        sessionId: "01a06f83",
        cwd: "/proj/sdo",
        originator: undefined,
        subagent: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for files without a session_meta first line", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-discovery-"));
    try {
      const filePath = join(dir, "bad.jsonl");
      writeFileSync(filePath, JSON.stringify({ type: "event_msg", payload: {} }));
      assert.equal(readCodexSessionMeta(filePath), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
