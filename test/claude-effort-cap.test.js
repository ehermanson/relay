// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capReasoningEffortLevels } from "../dist/server/core/provider-catalog.js";
import {
  claudeEffortCapForModel,
  normalizeClaudeModelKey,
  readClaudeEffortCaps,
  resolveClaudeEffortCaps,
} from "../dist/server/core/providers/claude-effort-cap.js";
import { applyModelEffortCaps } from "../dist/server/core/provider-registry.js";

const levels = ["low", "medium", "high", "xhigh", "max", "ultracode"].map((effort) => ({
  effort,
  label: effort,
  description: "",
}));
const efforts = (list) => list?.map((level) => level.effort);

describe("capReasoningEffortLevels", () => {
  it("drops levels above the cap; ultracode counts as xhigh", () => {
    assert.deepEqual(efforts(capReasoningEffortLevels(levels, "high")), ["low", "medium", "high"]);
    assert.deepEqual(efforts(capReasoningEffortLevels(levels, "xhigh")), [
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ]);
  });

  it("leaves levels alone without a known cap, and keeps unknown levels", () => {
    assert.equal(capReasoningEffortLevels(levels, undefined), levels);
    assert.equal(capReasoningEffortLevels(levels, "turbo"), levels);
    const withUnknown = [...levels, { effort: "turbo", label: "Turbo", description: "" }];
    assert.deepEqual(efforts(capReasoningEffortLevels(withUnknown, "low")), ["low", "turbo"]);
  });
});

describe("Claude maxEffortLevel", () => {
  it("normalizes model keys", () => {
    assert.equal(normalizeClaudeModelKey("claude-opus-4-6[1m]"), "claude-opus-4-6");
    assert.equal(normalizeClaudeModelKey("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
    assert.equal(normalizeClaudeModelKey("us.anthropic.claude-opus-4-6-v1:0"), "claude-opus-4-6");
    assert.equal(normalizeClaudeModelKey("Opus"), "opus");
  });

  it("a model entry replaces the file's top-level cap, and the lowest file wins", () => {
    const caps = resolveClaudeEffortCaps([
      {
        maxEffortLevel: "high",
        modelSettings: {
          "claude-opus-4-6": { maxEffortLevel: "max" },
          "claude-haiku-4-5": { maxEffortLevel: "low" },
        },
      },
      { maxEffortLevel: "xhigh" },
    ]);
    assert.equal(caps.default, "high");
    // Within the first file Opus is uncapped, but the second file caps it.
    assert.equal(claudeEffortCapForModel(caps, "claude-opus-4-6[1m]"), "xhigh");
    assert.equal(claudeEffortCapForModel(caps, "claude-haiku-4-5"), "low");
    assert.equal(claudeEffortCapForModel(caps, "claude-sonnet-4-5"), "high");
  });

  it("ignores invalid values and missing files", () => {
    const caps = resolveClaudeEffortCaps([
      null,
      { maxEffortLevel: "extreme", modelSettings: { opus: { maxEffortLevel: 3 } } },
    ]);
    assert.equal(caps.default, undefined);
    assert.deepEqual(caps.byModel, {});
  });

  it("caps each model's levels from the login's settings", () => {
    const configDir = mkdtempSync(join(tmpdir(), "relay-effort-cap-"));
    try {
      writeFileSync(
        join(configDir, "settings.json"),
        JSON.stringify({
          maxEffortLevel: "medium",
          modelSettings: { "claude-opus-4-6": { maxEffortLevel: "xhigh" } },
        }),
      );
      assert.equal(
        readClaudeEffortCaps(configDir, join(configDir, "absent.json")).default,
        "medium",
      );

      const capabilities = { reasoningEffortLevels: levels };
      const { capabilities: capped, models } = applyModelEffortCaps(
        "claude",
        configDir,
        capabilities,
        [
          {
            provider: "claude",
            id: "claude-opus-4-6",
            label: "Opus",
            resolvedCapabilities: capabilities,
          },
          {
            provider: "claude",
            id: "claude-sonnet-4-5",
            label: "Sonnet",
            resolvedCapabilities: capabilities,
          },
        ],
      );
      assert.deepEqual(efforts(capped.reasoningEffortLevels), ["low", "medium"]);
      assert.deepEqual(efforts(models[0].resolvedCapabilities.reasoningEffortLevels), [
        "low",
        "medium",
        "high",
        "xhigh",
        "ultracode",
      ]);
      assert.deepEqual(efforts(models[1].resolvedCapabilities.reasoningEffortLevels), [
        "low",
        "medium",
      ]);
      // Providers without the hook pass through untouched.
      assert.equal(
        applyModelEffortCaps("codex", configDir, capabilities, []).capabilities,
        capabilities,
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
