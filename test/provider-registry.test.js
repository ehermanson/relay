// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEffectiveProviderCapabilities,
  getProviderDriver,
  getProviderCapabilities,
  getRegisteredProviders,
  inferClaudeModelIdFromSdkInfo,
  isProviderAvailable,
  resolveCoreConfig,
} from "../dist/server/core/index.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeContext() {
  const config = resolveCoreConfig({ logger: noopLogger });
  return {
    providerDirs: {
      claude: config.providerDirs.claude,
      codex: config.providerDirs.codex,
    },
    logger: noopLogger,
    sdkQueryFn: null,
  };
}

describe("provider registry", () => {
  it("only exposes Codex writes mode for CLI 0.144.0 or newer", () => {
    const base = getProviderDriver("codex").capabilities;
    const advisory = (currentVersion) => ({
      status: "current",
      currentVersion,
      latestVersion: currentVersion,
      packageName: "@openai/codex",
      updateCommand: null,
      installMethod: "manual",
      checkedAt: new Date().toISOString(),
    });

    assert.equal(
      buildEffectiveProviderCapabilities("codex", base, advisory("0.143.9")).runtimeModes?.[
        "writes-only"
      ],
      undefined,
    );
    assert.ok(
      buildEffectiveProviderCapabilities("codex", base, advisory("0.144.0")).runtimeModes?.[
        "writes-only"
      ],
    );
    assert.ok(
      buildEffectiveProviderCapabilities("codex", base, advisory("0.145.0-alpha.1")).runtimeModes?.[
        "writes-only"
      ],
    );
  });

  it("only exposes Claude auto mode for eligible, enabled environments", () => {
    const base = getProviderDriver("claude").capabilities;
    const capabilities = (env, settings = null) =>
      buildEffectiveProviderCapabilities("claude", base, undefined, {
        env,
        claudeUserSettings: settings,
      });

    assert.equal(capabilities({}).runtimeModes?.auto, undefined);
    assert.ok(capabilities({ CLAUDE_CODE_USE_BEDROCK: "1" }).runtimeModes?.auto);
    assert.ok(capabilities({ CLAUDE_CODE_ENABLE_AUTO_MODE: "true" }).runtimeModes?.auto);
    assert.equal(
      capabilities({ CLAUDE_CODE_USE_VERTEX: "1" }, { disableAutoMode: "disable" }).runtimeModes
        ?.auto,
      undefined,
    );
  });

  it("registers drivers for all known provider kinds", () => {
    assert.deepEqual(getRegisteredProviders().sort(), ["claude", "codex"]);
  });

  it("exposes fixed capability metadata for each driver", () => {
    for (const provider of getRegisteredProviders()) {
      const capabilities = getProviderCapabilities(provider);
      assert.equal(typeof capabilities.supportsResume, "boolean");
      assert.equal(typeof capabilities.supportsTranscriptReplay, "boolean");
      assert.equal(typeof capabilities.supportsApprovals, "boolean");
      assert.equal(typeof capabilities.supportsUserInputRequests, "boolean");
      assert.equal(typeof capabilities.supportsModelSelection, "boolean");
      assert.equal(typeof capabilities.supportsTitleUpdates, "boolean");
    }
  });

  it("reports unknown provider kinds as unavailable instead of throwing", () => {
    assert.equal(isProviderAvailable("gemini", makeContext()), false);
  });

  it("infers canonical Claude model ids from SDK model descriptions", () => {
    const inferred = inferClaudeModelIdFromSdkInfo({
      value: "default",
      displayName: "Default (recommended)",
      description: "Opus 4.8 with 1M context · Most capable for complex work",
    });
    assert.equal(inferred, "claude-opus-4-8");
  });

  it("prefers the SDK's resolvedModel over display-text inference", () => {
    const inferred = inferClaudeModelIdFromSdkInfo({
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5 · Efficient for routine tasks",
    });
    assert.equal(inferred, "claude-sonnet-5");
  });

  it("strips the 1M-context alias suffix from resolved ids", () => {
    assert.equal(
      inferClaudeModelIdFromSdkInfo({
        value: "opus[1m]",
        resolvedModel: "claude-opus-4-8[1m]",
        displayName: "Opus",
        description: "Opus 4.8 with 1M context",
      }),
      "claude-opus-4-8",
    );
    assert.equal(
      inferClaudeModelIdFromSdkInfo({
        value: "claude-fable-5[1m]",
        displayName: "Fable",
        description: "Fable 5 · Most capable",
      }),
      "claude-fable-5",
    );
  });

  it("infers new family names from display text when resolvedModel is absent", () => {
    const inferred = inferClaudeModelIdFromSdkInfo({
      value: "fable",
      displayName: "Fable",
      description: "Fable 5 · Most capable for your hardest tasks",
    });
    assert.equal(inferred, "claude-fable-5");
  });

  it("resolves managed transcript paths through the provider driver", () => {
    const claudePath = getProviderDriver("claude").resolveManagedTranscriptPath({
      providerDirs: {
        claude: "/tmp/.claude",
        codex: "/tmp/.codex",
      },
      sessionId: "session-123",
      workingDirectory: "/tmp/project",
    });
    assert.equal(claudePath, join("/tmp/.claude", "projects", "-tmp-project", "session-123.jsonl"));
  });

  it("never pairs a new Claude session with another chat's transcript", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "relay-provider-registry-"));
    const claudeDir = join(tempDir, ".claude");
    const projectDir = join(claudeDir, "projects", "-tmp-project");
    mkdirSync(projectDir, { recursive: true });
    // A concurrent chat's transcript is the newest file; ours isn't flushed yet.
    writeFileSync(join(projectDir, "other-session.jsonl"), "{}\n");

    const captured = getProviderDriver("claude").captureManagedSession({
      proc: { getRuntimeBinding: () => ({ providerSessionId: "new-session" }) },
      workingDirectory: "/tmp/project",
      providerDirs: { claude: claudeDir, codex: join(tempDir, ".codex") },
    });

    assert.deepEqual(captured, {
      sessionId: "new-session",
      transcriptPath: join(projectDir, "new-session.jsonl"),
    });
  });

  it("ignores a stored Claude transcript path that names a different session", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "relay-provider-registry-"));
    const claudeDir = join(tempDir, ".claude");
    const projectDir = join(claudeDir, "projects", "-tmp-project");
    mkdirSync(projectDir, { recursive: true });
    const foreign = join(projectDir, "other-session.jsonl");
    writeFileSync(foreign, "{}\n");
    writeFileSync(join(projectDir, "my-session.jsonl"), "{}\n");

    const resolved = getProviderDriver("claude").resolveManagedTranscriptPath({
      providerDirs: { claude: claudeDir, codex: join(tempDir, ".codex") },
      sessionId: "my-session",
      transcriptPath: foreign,
      workingDirectory: "/tmp/project",
    });

    assert.equal(resolved, join(projectDir, "my-session.jsonl"));
  });

  it("finds Claude transcript paths for dotted relay worktree directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "relay-provider-registry-"));
    const claudeDir = join(tempDir, ".claude");
    const encodedProjectDir = "-Users-test--relay-worktrees-space-262013e4";
    mkdirSync(join(claudeDir, "projects", encodedProjectDir), { recursive: true });

    const claudePath = getProviderDriver("claude").resolveManagedTranscriptPath({
      providerDirs: {
        claude: claudeDir,
        codex: join(tempDir, ".codex"),
      },
      sessionId: "session-123",
      workingDirectory: "/Users/test/.relay/worktrees/space-262013e4",
    });

    assert.equal(claudePath, join(claudeDir, "projects", encodedProjectDir, "session-123.jsonl"));
  });
});
