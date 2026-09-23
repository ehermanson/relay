// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_SUGGESTIONS,
  MAX_SUGGESTIONS,
  resolveSuggestions,
} from "../dist/server/core/index.js";

// Pick a built-in that has no server-evaluated conditions so it's always present.
const EXPLORE_ID = "explore-codebase";
const PICK_UP_TASK_ID = "pick-up-task"; // has-tasks (server-evaluated)

function makeCustom(id, overrides = {}) {
  return {
    id,
    label: `Custom ${id}`,
    description: "desc",
    icon: "Sparkles",
    prompt: "prompt text",
    ...overrides,
  };
}

describe("resolveSuggestions", () => {
  it("returns all non-server-conditional built-ins with empty config", () => {
    const resolved = resolveSuggestions(null, null);
    const ids = resolved.map((s) => s.id);
    assert.ok(ids.includes(EXPLORE_ID));
    // has-tasks suggestions are server-filtered and stripped when no context given.
    assert.ok(!ids.includes(PICK_UP_TASK_ID));
    // every returned entry marked as builtIn
    for (const s of resolved) assert.equal(s.builtIn, true);
  });

  it("includes has-tasks built-in only when context says hasOpenTasks", () => {
    const without = resolveSuggestions(null, null, { hasOpenTasks: false });
    const withTasks = resolveSuggestions(null, null, { hasOpenTasks: true });
    assert.ok(!without.some((s) => s.id === PICK_UP_TASK_ID));
    assert.ok(withTasks.some((s) => s.id === PICK_UP_TASK_ID));
  });

  it("strips server-evaluated conditions from the client-facing payload", () => {
    const resolved = resolveSuggestions(null, null, { hasOpenTasks: true });
    const pickUp = resolved.find((s) => s.id === PICK_UP_TASK_ID);
    assert.ok(pickUp);
    // `has-tasks` is a server condition and must never appear on resolved suggestions.
    assert.ok(!pickUp.conditions || !pickUp.conditions.includes("has-tasks"));
  });

  it("project cannot re-enable a globally-disabled built-in", () => {
    const global = {
      patches: { [EXPLORE_ID]: { disabled: true } },
      custom: [],
    };
    const project = {
      patches: { [EXPLORE_ID]: { disabled: false } },
      custom: [],
    };
    const resolved = resolveSuggestions(global, project);
    assert.ok(!resolved.some((s) => s.id === EXPLORE_ID));
  });

  it("project cannot re-enable a globally-disabled custom suggestion", () => {
    const global = {
      patches: {},
      custom: [makeCustom("shared-1", { disabled: true })],
    };
    const project = {
      patches: {},
      custom: [makeCustom("shared-1")], // same id, not disabled at project level
    };
    const resolved = resolveSuggestions(global, project);
    assert.ok(!resolved.some((s) => s.id === "shared-1"));
  });

  it("project disable hides a built-in that is enabled globally", () => {
    const resolved = resolveSuggestions(null, {
      patches: { [EXPLORE_ID]: { disabled: true } },
      custom: [],
    });
    assert.ok(!resolved.some((s) => s.id === EXPLORE_ID));
  });

  it("project prompt override beats global which beats built-in", () => {
    const global = {
      patches: { [EXPLORE_ID]: { prompt: "GLOBAL" } },
      custom: [],
    };
    const project = {
      patches: { [EXPLORE_ID]: { prompt: "PROJECT" } },
      custom: [],
    };
    const resolvedProject = resolveSuggestions(global, project);
    assert.equal(resolvedProject.find((s) => s.id === EXPLORE_ID)?.prompt, "PROJECT");
    const resolvedGlobalOnly = resolveSuggestions(global, null);
    assert.equal(resolvedGlobalOnly.find((s) => s.id === EXPLORE_ID)?.prompt, "GLOBAL");
  });

  it("custom suggestions from both levels appear alongside built-ins", () => {
    const global = {
      patches: {},
      custom: [makeCustom("global-custom")],
    };
    const project = {
      patches: {},
      custom: [makeCustom("project-custom")],
    };
    const resolved = resolveSuggestions(global, project);
    const ids = resolved.map((s) => s.id);
    assert.ok(ids.includes("global-custom"));
    assert.ok(ids.includes("project-custom"));
    assert.equal(resolved.find((s) => s.id === "global-custom")?.builtIn, false);
  });

  it("project custom with the same id as a global custom wins via upsert", () => {
    const global = {
      patches: {},
      custom: [makeCustom("shared", { label: "Global label" })],
    };
    const project = {
      patches: {},
      custom: [makeCustom("shared", { label: "Project label" })],
    };
    const resolved = resolveSuggestions(global, project);
    const shared = resolved.find((s) => s.id === "shared");
    assert.equal(shared?.label, "Project label");
  });

  it("caps the resolved list at MAX_SUGGESTIONS", () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 10 }, (_, i) => makeCustom(`extra-${i}`));
    const resolved = resolveSuggestions(null, { patches: {}, custom: many });
    assert.equal(resolved.length, MAX_SUGGESTIONS);
  });

  it("built-in definitions are non-empty and well-formed", () => {
    assert.ok(BUILT_IN_SUGGESTIONS.length > 0);
    for (const s of BUILT_IN_SUGGESTIONS) {
      assert.equal(typeof s.id, "string");
      assert.equal(typeof s.label, "string");
      assert.equal(typeof s.prompt, "string");
      assert.ok(s.id.length > 0);
    }
  });
});
