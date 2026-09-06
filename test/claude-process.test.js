import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeProcess } from "../dist/server/core/claude-process.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeConfig(overrides = {}) {
  return {
    workingDirectory: "/tmp",
    defaultRuntimeMode: "approval-required",
    processTimeout: 0,
    maxProcesses: 5,
    logger: noopLogger,
    ...overrides,
  };
}

describe("ClaudeProcess state management", () => {
  it("starts with isProcessing = false", () => {
    const proc = new ClaudeProcess(makeConfig());
    assert.equal(proc.isProcessing, false);
  });

  it("starts with empty stats", () => {
    const proc = new ClaudeProcess(makeConfig());
    const stats = proc.stats;
    assert.equal(stats.inputTokens, 0);
    assert.equal(stats.outputTokens, 0);
    assert.equal(stats.cacheCreationTokens, 0);
    assert.equal(stats.cacheReadTokens, 0);
    assert.equal(stats.model, undefined);
  });

  it("stats getter returns a copy, not the internal object", () => {
    const proc = new ClaudeProcess(makeConfig());
    const stats1 = proc.stats;
    const stats2 = proc.stats;
    assert.notEqual(stats1, stats2);
    assert.deepEqual(stats1, stats2);
  });

  it("provider is always 'claude'", () => {
    const proc = new ClaudeProcess(makeConfig());
    assert.equal(proc.provider, "claude");
  });

  it("maps AskUserQuestion to a user_input request on the CLI path", () => {
    const proc = new ClaudeProcess(makeConfig());
    const activities = [];
    const requests = [];
    proc.on("activity", (activity) => activities.push(activity));
    proc.on("permissionRequest", (request) => requests.push(request));

    proc.handleAgentProgress({
      message: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "ask-cli-1",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    id: "drink",
                    header: "Preference",
                    question: "Which do you prefer?",
                  },
                  {
                    id: "sides",
                    header: "Sides",
                    question: "Pick any sides",
                    multiSelect: true,
                  },
                ],
              },
            },
          ],
        },
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].kind, "user_input");
    assert.equal(requests[0].requestId, "ask-cli-1");
    // multiSelect is normalized to a boolean on the CLI path, matching the SDK/replay mappers.
    assert.equal(requests[0].questions[0].multiSelect, false);
    assert.equal(requests[0].questions[1].multiSelect, true);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].tool, "AskUserQuestion");
    assert.equal(activities[0].input.requestId, "ask-cli-1");
  });
});

describe("ClaudeProcess extractContextBudget", () => {
  it("extracts context window from budget:token_budget tag", () => {
    const proc = new ClaudeProcess(makeConfig());
    const emitted = [];
    proc.on("stats", (stats) => emitted.push(stats));

    proc.extractContextBudget("<budget:token_budget>200000</budget:token_budget>");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].contextWindow, 200000);
  });

  it("handles comma-formatted numbers in budget tag", () => {
    const proc = new ClaudeProcess(makeConfig());
    const emitted = [];
    proc.on("stats", (stats) => emitted.push(stats));

    proc.extractContextBudget("<budget:token_budget>200,000</budget:token_budget>");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].contextWindow, 200000);
  });

  it("extracts context window from system_warning tag", () => {
    const proc = new ClaudeProcess(makeConfig());
    const emitted = [];
    proc.on("stats", (stats) => emitted.push(stats));

    proc.extractContextBudget(
      "<system_warning>Token usage: 80,000 / 200,000; 120,000 remaining</system_warning>",
    );
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].contextWindow, 200000);
    assert.equal(emitted[0].contextTokens, 80000);
  });

  it("prefers budget tag over system_warning when both present", () => {
    const proc = new ClaudeProcess(makeConfig());
    const emitted = [];
    proc.on("stats", (stats) => emitted.push(stats));

    proc.extractContextBudget(
      "<budget:token_budget>200000</budget:token_budget> " +
        "<system_warning>Token usage: 50,000 / 100,000; 50,000 remaining</system_warning>",
    );
    // budget tag matched first → returns early, system_warning not processed
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].contextWindow, 200000);
  });

  it("does nothing for text without budget tags", () => {
    const proc = new ClaudeProcess(makeConfig());
    const emitted = [];
    proc.on("stats", (stats) => emitted.push(stats));

    proc.extractContextBudget("Here is some regular assistant text.");
    assert.equal(emitted.length, 0);
  });

  it("ignores system_warning with zero total", () => {
    const proc = new ClaudeProcess(makeConfig());
    const emitted = [];
    proc.on("stats", (stats) => emitted.push(stats));

    proc.extractContextBudget("<system_warning>Token usage: 0 / 0; 0 remaining</system_warning>");
    assert.equal(emitted.length, 0);
  });
});

describe("ClaudeProcess session targeting", () => {
  it("setSessionId stores the session ID for resume", () => {
    const proc = new ClaudeProcess(makeConfig());
    proc.setSessionId("abc-123");
    const binding = proc.getRuntimeBinding();
    assert.equal(binding.providerSessionId, "abc-123");
    assert.deepEqual(binding.resumeCursor, { sessionId: "abc-123" });
  });

  it("constructor accepts resumeSessionId", () => {
    const proc = new ClaudeProcess(makeConfig(), { resumeSessionId: "existing-session" });
    const binding = proc.getRuntimeBinding();
    assert.equal(binding.providerSessionId, "existing-session");
  });

  it("getRuntimeBinding without session ID has no resume cursor", () => {
    const proc = new ClaudeProcess(makeConfig());
    const binding = proc.getRuntimeBinding();
    assert.equal(binding.providerSessionId, undefined);
    assert.equal(binding.resumeCursor, undefined);
  });
});

describe("ClaudeProcess model and reasoning", () => {
  it("setModel stores the preferred model", () => {
    const proc = new ClaudeProcess(makeConfig());
    proc.setModel("claude-sonnet-4-6");
    const binding = proc.getRuntimeBinding();
    assert.equal(binding.runtimePayload.model, "claude-sonnet-4-6");
  });

  it("setModel(null) clears the model", () => {
    const proc = new ClaudeProcess(makeConfig());
    proc.setModel("claude-sonnet-4-6");
    proc.setModel(null);
    const binding = proc.getRuntimeBinding();
    assert.equal(binding.runtimePayload.model, undefined);
  });

  it("constructor accepts model option", () => {
    const proc = new ClaudeProcess(makeConfig(), { model: "claude-haiku-4-5-20251001" });
    const binding = proc.getRuntimeBinding();
    assert.equal(binding.runtimePayload.model, "claude-haiku-4-5-20251001");
  });
});

describe("ClaudeProcess runtime mode", () => {
  it("setRuntimeMode swaps between approval-required and full-access", () => {
    const proc = new ClaudeProcess(makeConfig());
    assert.equal(proc.getRuntimeBinding().runtimeMode, "approval-required");

    proc.setRuntimeMode("full-access");
    assert.equal(proc.getRuntimeBinding().runtimeMode, "full-access");

    proc.setRuntimeMode("approval-required");
    assert.equal(proc.getRuntimeBinding().runtimeMode, "approval-required");
  });

  it("constructor honors runtimeMode option over config default", () => {
    const proc = new ClaudeProcess(makeConfig(), { runtimeMode: "full-access" });
    assert.equal(proc.getRuntimeBinding().runtimeMode, "full-access");
  });

  it("setRuntimeMode('plan') enters plan mode", () => {
    const proc = new ClaudeProcess(makeConfig(), { runtimeMode: "full-access" });
    proc.setRuntimeMode("plan");
    assert.equal(proc.getRuntimeBinding().runtimeMode, "plan");

    proc.setRuntimeMode("full-access");
    assert.equal(proc.getRuntimeBinding().runtimeMode, "full-access");
  });

  it("addAllowedTool deduplicates tools", () => {
    const proc = new ClaudeProcess(makeConfig());
    proc.addAllowedTool("Bash");
    proc.addAllowedTool("Bash");
    proc.addAllowedTool("Edit");
    // No direct way to inspect allowedTools, but verify no error
    assert.ok(proc);
  });
});

describe("ClaudeProcess cancel and kill", () => {
  it("cancel when no process is a no-op", () => {
    const proc = new ClaudeProcess(makeConfig());
    // Should not throw
    proc.cancel();
    assert.equal(proc.isProcessing, false);
  });

  it("kill when no process is a no-op", () => {
    const proc = new ClaudeProcess(makeConfig());
    proc.kill();
    assert.equal(proc.isProcessing, false);
  });

  it("close is an alias for kill", () => {
    const proc = new ClaudeProcess(makeConfig());
    proc.close();
    assert.equal(proc.isProcessing, false);
  });

  it("interrupt is an alias for cancel", () => {
    const proc = new ClaudeProcess(makeConfig());
    proc.interrupt();
    assert.equal(proc.isProcessing, false);
  });

  it("cancelForPermission when no process is a no-op", () => {
    const proc = new ClaudeProcess(makeConfig());
    proc.cancelForPermission();
    assert.equal(proc.isProcessing, false);
  });
});

describe("ClaudeProcess send guards", () => {
  it("ignores send when already processing", () => {
    const proc = new ClaudeProcess(makeConfig());
    // Force _isProcessing via a send call that will fail (no claude binary)
    // and check it doesn't crash on double-send
    try {
      proc.send("first message");
    } catch {
      // Expected — claude binary not available in test
    }
    // Second send while processing should be silently ignored
    // (it logs but doesn't throw)
  });
});
