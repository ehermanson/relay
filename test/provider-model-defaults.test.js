// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getBuiltinProviderModels,
  getProviderCapabilities,
  mergeCapabilities,
  resolveProviderDefaultModelOption,
} from "../dist/server/core/index.js";

describe("resolveProviderDefaultModelOption", () => {
  it("returns the catalog default for claude (Opus 5)", () => {
    const result = resolveProviderDefaultModelOption("claude");
    assert.ok(result);
    assert.equal(result.id, "claude-opus-5");
    assert.equal(result.isDefault, true);
  });

  it("returns the catalog default for codex (gpt-5.4)", () => {
    const result = resolveProviderDefaultModelOption("codex");
    assert.ok(result);
    assert.equal(result.id, "gpt-5.4");
    assert.equal(result.isDefault, true);
  });

  it("prefers the newest discovered codex model when no default is marked", () => {
    const result = resolveProviderDefaultModelOption("codex", [
      { provider: "codex", id: "gpt-5.4", label: "GPT-5.4" },
      { provider: "codex", id: "gpt-5.5", label: "GPT-5.5" },
      { provider: "codex", id: "gpt-5.5-mini", label: "GPT-5.5 Mini" },
    ]);
    assert.ok(result);
    assert.equal(result.id, "gpt-5.5");
  });

  it("prefers the catalog default id in an enriched models list", () => {
    // Simulate enriched models (like the route produces) where resolvedCapabilities
    // are attached — the function should find the enriched version by id.
    const enriched = [
      {
        provider: "claude",
        id: "claude-opus-4-7",
        label: "Opus 4.7",
        isDefault: true,
        extra: true,
      },
      { provider: "claude", id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    ];
    const result = resolveProviderDefaultModelOption("claude", enriched);
    assert.ok(result);
    assert.equal(result.id, "claude-opus-4-7");
    assert.equal(result.extra, true); // got the enriched version, not raw catalog
  });

  it("prefers a discovered claude default over the fallback catalog default", () => {
    const result = resolveProviderDefaultModelOption("claude", [
      { provider: "claude", id: "claude-opus-4-8", label: "Opus 4.8" },
      { provider: "claude", id: "claude-fable-5", label: "Fable 5", isDefault: true },
    ]);
    assert.ok(result);
    assert.equal(result.id, "claude-fable-5");
  });

  it("falls back to first model when catalog default is absent and no isDefault", () => {
    const models = [
      { provider: "claude", id: "model-a", label: "A" },
      { provider: "claude", id: "model-b", label: "B" },
    ];
    const result = resolveProviderDefaultModelOption("claude", models);
    assert.ok(result);
    // Neither model matches the catalog default id, and neither has isDefault,
    // so it falls back to the first candidate.
    assert.equal(result.id, "model-a");
  });
});

describe("mergeCapabilities", () => {
  it("returns provider capabilities when no model overrides", () => {
    const base = getProviderCapabilities("claude");
    const merged = mergeCapabilities(base, undefined);
    assert.deepEqual(merged, base);
  });

  it("overrides specific fields from model capabilities", () => {
    const base = getProviderCapabilities("claude");
    const override = { supportsFastMode: false };
    const merged = mergeCapabilities(base, override);
    assert.equal(merged.supportsFastMode, false);
    // Other fields should be preserved
    assert.equal(merged.supportsResume, base.supportsResume);
    assert.equal(merged.supportsApprovals, base.supportsApprovals);
  });

  it("replaces reasoningEffortLevels wholesale (not per-entry merge)", () => {
    const base = getProviderCapabilities("claude");
    const customLevels = [
      { effort: "low", label: "Lo", description: "test" },
      { effort: "high", label: "Hi", description: "test" },
    ];
    const merged = mergeCapabilities(base, { reasoningEffortLevels: customLevels });
    assert.equal(merged.reasoningEffortLevels.length, 2);
    assert.equal(merged.reasoningEffortLevels[0].label, "Lo");
  });
});

describe("per-model reasoning effort levels", () => {
  it("claude provider default includes xhigh (EXTENDED_EFFORTS)", () => {
    const caps = getProviderCapabilities("claude");
    const efforts = caps.reasoningEffortLevels;
    assert.ok(efforts);
    const effortNames = efforts.map((e) => e.effort);
    assert.ok(effortNames.includes("xhigh"), "provider default should include xhigh");
    assert.ok(effortNames.includes("low"));
    assert.ok(effortNames.includes("medium"));
    assert.ok(effortNames.includes("high"));
    assert.ok(effortNames.includes("max"));
  });

  it("opus 4.7 catalog has xhigh as default effort", () => {
    const models = getBuiltinProviderModels("claude");
    const opus = models.find((m) => m.id === "claude-opus-4-7");
    assert.ok(opus);
    assert.ok(opus.capabilities?.reasoningEffortLevels);
    const defaultLevel = opus.capabilities.reasoningEffortLevels.find((l) => l.isDefault);
    assert.ok(defaultLevel, "opus 4.7 should have a default effort level");
    assert.equal(defaultLevel.effort, "xhigh");
  });

  it("sonnet 4.6 catalog has medium as default effort (no xhigh)", () => {
    const models = getBuiltinProviderModels("claude");
    const sonnet = models.find((m) => m.id === "claude-sonnet-4-6");
    assert.ok(sonnet);
    assert.ok(sonnet.capabilities?.reasoningEffortLevels);
    const effortNames = sonnet.capabilities.reasoningEffortLevels.map((e) => e.effort);
    assert.ok(!effortNames.includes("xhigh"), "sonnet should not have xhigh");
    const defaultLevel = sonnet.capabilities.reasoningEffortLevels.find((l) => l.isDefault);
    assert.ok(defaultLevel, "sonnet should have a default effort level");
    assert.equal(defaultLevel.effort, "medium");
  });

  it("per-model effort isDefault survives mergeCapabilities", () => {
    const base = getProviderCapabilities("claude");
    const models = getBuiltinProviderModels("claude");
    const opus = models.find((m) => m.id === "claude-opus-4-7");
    const merged = mergeCapabilities(base, opus.capabilities);
    const defaultLevel = merged.reasoningEffortLevels.find((l) => l.isDefault);
    assert.ok(defaultLevel);
    assert.equal(defaultLevel.effort, "xhigh");
  });

  it("codex provider default does not include xhigh", () => {
    const caps = getProviderCapabilities("codex");
    const efforts = caps.reasoningEffortLevels;
    assert.ok(efforts);
    const effortNames = efforts.map((e) => e.effort);
    assert.ok(!effortNames.includes("xhigh"), "codex should not have xhigh");
  });

  it("every model with effort levels has exactly one isDefault", () => {
    for (const provider of ["claude", "codex"]) {
      const models = getBuiltinProviderModels(provider);
      for (const model of models) {
        if (!model.capabilities?.reasoningEffortLevels) continue;
        const defaults = model.capabilities.reasoningEffortLevels.filter((l) => l.isDefault);
        assert.equal(
          defaults.length,
          1,
          `${model.id} should have exactly 1 default effort, got ${defaults.length}`,
        );
      }
    }
  });
});

describe("catalog default model used for session creation", () => {
  it("claude catalog has exactly one default model", () => {
    const models = getBuiltinProviderModels("claude");
    const defaults = models.filter((m) => m.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, "claude-opus-5");
  });

  it("codex catalog has exactly one default model", () => {
    const models = getBuiltinProviderModels("codex");
    const defaults = models.filter((m) => m.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, "gpt-5.4");
  });

  it("BUILTIN_PROVIDER_MODELS default id is what effectiveSessionModel resolves to", () => {
    // This mirrors the instance-manager logic:
    // const effectiveSessionModel = model ?? BUILTIN_PROVIDER_MODELS[provider].find(m => m.isDefault)?.id;
    for (const provider of ["claude", "codex"]) {
      const models = getBuiltinProviderModels(provider);
      const defaultModel = models.find((m) => m.isDefault);
      assert.ok(defaultModel, `${provider} should have a default model`);
      assert.ok(defaultModel.id, `${provider} default model should have an id`);
    }
  });
});
