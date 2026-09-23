// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Chat titles.
 *
 * Claude Code records its own session title in the transcript (`ai-title`,
 * `custom-title`); Relay adopts it wherever it reads a transcript. Without one,
 * the title is the first substantive user message and is never overwritten by
 * a later message (the old fallback retitled chats to "ok, commit and push").
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  extractClaudeTitleRecord,
  pickClaudeTitleFromLines,
  readClaudeTranscriptTitle,
} from "../dist/server/core/providers/claude-session-title.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveManagedTranscriptPathForProvider } from "../dist/server/core/provider-registry.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const aiTitle = (aiTitle, sessionId = "s1") =>
  JSON.stringify({ type: "ai-title", aiTitle, sessionId });
const customTitle = (customTitle, sessionId = "s1") =>
  JSON.stringify({ type: "custom-title", customTitle, sessionId });
const userEntry = (text, sessionId = "s1") =>
  JSON.stringify({
    type: "user",
    sessionId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  });

describe("claude-session-title helpers", () => {
  it("extracts ai-title and custom-title records only", () => {
    assert.deepEqual(extractClaudeTitleRecord(JSON.parse(aiTitle("  Login  bug \n"))), {
      title: "Login bug",
      source: "ai",
    });
    assert.deepEqual(extractClaudeTitleRecord(JSON.parse(customTitle("mine"))), {
      title: "mine",
      source: "custom",
    });
    assert.equal(extractClaudeTitleRecord(JSON.parse(aiTitle("   "))), null);
    assert.equal(extractClaudeTitleRecord(JSON.parse(userEntry("ai-title"))), null);
    assert.equal(extractClaudeTitleRecord(null), null);
  });

  it("last record wins, custom beats ai, partial lines are skipped", () => {
    const text = [
      aiTitle("First guess"),
      '{"type":"ai-title","aiTitle":"trunc',
      userEntry('mentions "ai-title" in a message'),
      aiTitle("Refined title"),
    ].join("\n");
    assert.deepEqual(pickClaudeTitleFromLines(text), { title: "Refined title", source: "ai" });
    assert.deepEqual(pickClaudeTitleFromLines(text + "\n" + customTitle("Renamed")), {
      title: "Renamed",
      source: "custom",
    });
    assert.equal(pickClaudeTitleFromLines(userEntry("no title here")), null);
  });

  it("reads a title from the tail of a transcript larger than the scan windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-title-"));
    try {
      const path = join(dir, "big.jsonl");
      const filler = userEntry("x".repeat(4000));
      const lines = [aiTitle("Head title")];
      for (let i = 0; i < 60; i++) lines.push(filler); // ~240KB, well past 2×64KB
      lines.push(aiTitle("Tail title"));
      writeFileSync(path, lines.join("\n") + "\n");
      assert.deepEqual(readClaudeTranscriptTitle(path), { title: "Tail title", source: "ai" });

      const headOnly = join(dir, "head.jsonl");
      writeFileSync(headOnly, [aiTitle("Only head"), ...lines.slice(1, 61)].join("\n") + "\n");
      assert.deepEqual(readClaudeTranscriptTitle(headOnly), { title: "Only head", source: "ai" });

      assert.equal(readClaudeTranscriptTitle(join(dir, "missing.jsonl")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class FakeProviderSession extends EventEmitter {
  constructor() {
    super();
    this.provider = "claude";
    this.isProcessing = false;
    this.pid = undefined;
    this.stats = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }
  send() {}
  interrupt() {}
  close() {}
  setModel() {}
  addAllowedTool() {}
  setRuntimeMode() {}
  setSessionId() {}
  getRuntimeBinding() {
    return { provider: "claude", providerSessionId: "fake-session" };
  }
  respondToRequest() {
    return false;
  }
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe("chat title refresh", () => {
  let tempDir;
  let manager;
  let proc;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-titles-"));
    manager = new InstanceManager(
      resolveConfig({
        password: "test",
        logger: noopLogger,
        maxProcesses: 3,
        dbPath: join(tempDir, "sessions.db"),
        providerDirs: { claude: join(tempDir, ".claude"), codex: join(tempDir, ".codex") },
        workingDirectory: tempDir,
      }),
    );
    proc = new FakeProviderSession();
    manager.createProviderSession = () => proc;
  });

  afterEach(() => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function turn(id, text) {
    await manager.sendMessage(id, text);
    await tick();
    proc.emit("output", { type: "output", text: "", isWaiting: true });
    await tick();
  }

  it("keeps the first substantive message as the title across later turns", async () => {
    const { id } = manager.createInstance({ provider: "claude" });
    const instance = manager.instances.get(id);
    await turn(id, "fix the login button bug");
    assert.equal(instance.info.name, "fix the login button bug");
    await turn(id, "ok. commit and push");
    await turn(id, "looks great, now also update the readme for it");
    assert.equal(instance.info.name, "fix the login button bug", "later messages never retitle");
  });

  it("upgrades a trivial first-message title once a real request arrives", async () => {
    const { id } = manager.createInstance({ provider: "claude" });
    const instance = manager.instances.get(id);
    await turn(id, "hey");
    assert.equal(instance.info.name, "hey");
    await turn(id, "fix the login button bug");
    assert.equal(instance.info.name, "fix the login button bug");
  });

  it("adopts the title Claude recorded in the transcript and keeps it over the fallback", async () => {
    const { id } = manager.createInstance({ provider: "claude" });
    const instance = manager.instances.get(id);
    // Where Claude writes this session's transcript; record titles there like the CLI would.
    const jsonl = resolveManagedTranscriptPathForProvider("claude", {
      providerDirs: manager.providerDirs,
      sessionId: "fake-session",
      workingDirectory: tempDir,
    });
    mkdirSync(dirname(jsonl), { recursive: true });
    writeFileSync(jsonl, userEntry("fix the login button bug") + "\n");

    await turn(id, "fix the login button bug");
    assert.equal(instance.info.name, "fix the login button bug", "no record yet → first message");

    appendFileSync(jsonl, aiTitle("Fix CI") + "\n"); // short enough to read as "trivial"
    await turn(id, "ok now add the tests for it please");
    assert.equal(instance.info.name, "Fix CI", "recorded title adopted");
    await turn(id, "and update the docs while you are at it");
    assert.equal(instance.info.name, "Fix CI", "a short recorded title is not churned away");

    appendFileSync(jsonl, aiTitle("Login button fix") + "\n");
    await turn(id, "thanks");
    assert.equal(instance.info.name, "Login button fix", "re-evaluated title adopted");

    await manager.renameInstance(id, "My chat");
    appendFileSync(jsonl, aiTitle("Something else") + "\n");
    await turn(id, "one more thing please do it");
    assert.equal(instance.info.name, "My chat", "a Relay custom title is never replaced");
  });
});

describe("startup scan titles", () => {
  it("names discovered Claude sessions from their recorded title", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "relay-scan-titles-"));
    const manager = new InstanceManager(
      resolveConfig({
        password: "test",
        logger: noopLogger,
        maxProcesses: 3,
        dbPath: join(tempDir, "sessions.db"),
        providerDirs: { claude: join(tempDir, ".claude"), codex: join(tempDir, ".codex") },
      }),
    );
    try {
      const cwd = join(tempDir, "repo");
      mkdirSync(cwd, { recursive: true });
      execSync("git init", { cwd, stdio: "pipe" });
      const projectDir = join(tempDir, ".claude", "projects", cwd.replace(/\//g, "-"));
      mkdirSync(projectDir, { recursive: true });
      manager.projectManager.addProject(cwd);

      const init = (sessionId) =>
        JSON.stringify({ type: "init", cwd, sessionId, timestamp: new Date().toISOString() });
      writeFileSync(
        join(projectDir, "titled.jsonl"),
        [
          init("titled"),
          userEntry("please fix the flaky login test", "titled"),
          aiTitle("Flaky login test", "titled"),
        ].join("\n") + "\n",
      );
      writeFileSync(
        join(projectDir, "untitled.jsonl"),
        [init("untitled"), userEntry("please fix the flaky login test", "untitled")].join("\n") +
          "\n",
      );

      manager["scanAllSessions"]();

      const titled = manager.db.getBySessionId("titled");
      assert.equal(titled.name, "Flaky login test");
      assert.equal(titled.summary, "Flaky login test");
      const untitled = manager.db.getBySessionId("untitled");
      assert.equal(untitled.name, "please fix the flaky login test");
      assert.equal(untitled.summary, null);
    } finally {
      manager.stopAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
