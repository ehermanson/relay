// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskListActivityFromPlan,
  describeToolUse,
  describeToolDetail,
  extractAskQuestionTexts,
  isPermissionDenial,
  parseAskUserQuestionAnswerText,
  parsePlanUpdate,
} from "../dist/server/core/tools.js";

describe("describeToolUse", () => {
  it("returns 'Reading file' for Read", () => {
    assert.equal(describeToolUse("Read", { file_path: "/tmp/x" }), "Reading file");
  });

  it("returns 'Editing file' for Edit", () => {
    assert.equal(describeToolUse("Edit", { file_path: "/tmp/x" }), "Editing file");
  });

  it("returns 'Writing file' for Write", () => {
    assert.equal(describeToolUse("Write", { file_path: "/tmp/x" }), "Writing file");
  });

  it("returns 'Running command' for Bash", () => {
    assert.equal(describeToolUse("Bash", { command: "ls" }), "Running command");
  });

  it("returns 'Searching files' for Glob", () => {
    assert.equal(describeToolUse("Glob", { pattern: "*.js" }), "Searching files");
  });

  it("returns 'Searching content' for Grep", () => {
    assert.equal(describeToolUse("Grep", { pattern: "TODO" }), "Searching content");
  });

  it("returns 'Fetching URL' for WebFetch", () => {
    assert.equal(describeToolUse("WebFetch", { url: "https://example.com" }), "Fetching URL");
  });

  it("returns 'Searching web' for WebSearch", () => {
    assert.equal(describeToolUse("WebSearch", { query: "node.js" }), "Searching web");
  });

  it("returns 'Running subtask' for Task", () => {
    assert.equal(describeToolUse("Task", { description: "do stuff" }), "Running subtask");
  });

  it("returns 'Using <name>' for unknown tool with input", () => {
    assert.equal(describeToolUse("CustomTool", { foo: "bar" }), "Using CustomTool");
  });

  it("returns 'Using <name>' when input is undefined", () => {
    assert.equal(describeToolUse("Read"), "Using Read");
    assert.equal(describeToolUse("Bash"), "Using Bash");
    assert.equal(describeToolUse("CustomTool"), "Using CustomTool");
  });
});

describe("isPermissionDenial", () => {
  it("detects 'haven't granted' format (Write)", () => {
    assert.equal(
      isPermissionDenial(
        "Claude requested permissions to write to /Users/me/projects/README.md, but you haven't granted it yet.",
      ),
      true,
    );
  });

  it("detects 'haven't granted' format (Bash)", () => {
    assert.equal(
      isPermissionDenial(
        "Claude requested permissions to Bash(npm install), but you haven't granted it yet.",
      ),
      true,
    );
  });

  it("detects 'requires approval' format", () => {
    assert.equal(isPermissionDenial("This command requires approval"), true);
  });

  it("returns false for normal tool output", () => {
    assert.equal(isPermissionDenial("hello\nworld"), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isPermissionDenial(""), false);
  });

  it("returns false for generic errors", () => {
    assert.equal(isPermissionDenial("No files found"), false);
    assert.equal(isPermissionDenial("Command failed with exit code 1"), false);
  });
});

describe("extractAskQuestionTexts", () => {
  it("pulls question texts from AskUserQuestion input", () => {
    assert.deepEqual(
      extractAskQuestionTexts({
        questions: [{ question: "Pick a color" }, { question: "Pick a size" }],
      }),
      ["Pick a color", "Pick a size"],
    );
  });

  it("returns empty for malformed input", () => {
    assert.deepEqual(extractAskQuestionTexts(undefined), []);
    assert.deepEqual(extractAskQuestionTexts({ questions: "nope" }), []);
    assert.deepEqual(extractAskQuestionTexts({ questions: [{}, { question: "" }] }), []);
  });
});

describe("parseAskUserQuestionAnswerText", () => {
  const questions = [
    "Should blast-radius block commits, or just report?",
    "Where should it run in the hook?",
  ];
  const content =
    "Your questions have been answered: " +
    '"Should blast-radius block commits, or just report?"="Informational only (Recommended)", ' +
    '"Where should it run in the hook?"="lint-staged entry (Recommended)". ' +
    "You can now continue with these answers in mind.";

  it("reconstructs multi-question answers as > Q / A blocks", () => {
    assert.equal(
      parseAskUserQuestionAnswerText(content, questions),
      "> Should blast-radius block commits, or just report?\n\nInformational only (Recommended)\n\n" +
        "> Where should it run in the hook?\n\nlint-staged entry (Recommended)",
    );
  });

  it("handles a single question", () => {
    const single =
      'Your questions have been answered: "Pick a color"="Purple". You can now continue with these answers in mind.';
    assert.equal(
      parseAskUserQuestionAnswerText(single, ["Pick a color"]),
      "> Pick a color\n\nPurple",
    );
  });

  it("handles a free-text answer keyed to the first question", () => {
    const authored =
      'Your questions have been answered: "Pick a color"="Use a custom teal, hex #0a7". You can now continue with these answers in mind.';
    assert.equal(
      parseAskUserQuestionAnswerText(authored, ["Pick a color"]),
      "> Pick a color\n\nUse a custom teal, hex #0a7",
    );
  });

  it("returns null when the content is not an answer sentence", () => {
    assert.equal(parseAskUserQuestionAnswerText("some other tool output", questions), null);
    assert.equal(parseAskUserQuestionAnswerText(content, []), null);
  });
});

describe("describeToolDetail", () => {
  it("returns undefined when input is undefined", () => {
    assert.equal(describeToolDetail("Read"), undefined);
    assert.equal(describeToolDetail("Bash"), undefined);
    assert.equal(describeToolDetail("CustomTool"), undefined);
  });

  it("extracts file_path for Read", () => {
    assert.equal(
      describeToolDetail("Read", { file_path: "/home/user/file.ts" }),
      "/home/user/file.ts",
    );
  });

  it("extracts file_path for Edit", () => {
    assert.equal(describeToolDetail("Edit", { file_path: "/tmp/edit.ts" }), "/tmp/edit.ts");
  });

  it("extracts file_path for Write", () => {
    assert.equal(describeToolDetail("Write", { file_path: "/tmp/write.ts" }), "/tmp/write.ts");
  });

  it("falls back to path for file tools", () => {
    assert.equal(describeToolDetail("Read", { path: "/fallback/path.ts" }), "/fallback/path.ts");
  });

  it("extracts short command for Bash", () => {
    assert.equal(describeToolDetail("Bash", { command: "ls -la" }), "ls -la");
  });

  it("truncates long commands for Bash", () => {
    const longCmd = "a".repeat(150);
    const result = describeToolDetail("Bash", { command: longCmd });
    assert.equal(result, "a".repeat(100) + "...");
    assert.equal(result.length, 103);
  });

  it("returns undefined for Bash with no command", () => {
    assert.equal(describeToolDetail("Bash", {}), undefined);
  });

  it("extracts pattern for Glob", () => {
    assert.equal(describeToolDetail("Glob", { pattern: "**/*.ts" }), "**/*.ts");
  });

  it("extracts pattern for Grep", () => {
    assert.equal(describeToolDetail("Grep", { pattern: "TODO" }), "TODO");
  });

  it("extracts url for WebFetch", () => {
    assert.equal(
      describeToolDetail("WebFetch", { url: "https://example.com/api" }),
      "https://example.com/api",
    );
  });

  it("extracts query for WebSearch", () => {
    assert.equal(
      describeToolDetail("WebSearch", { query: "node test runner" }),
      "node test runner",
    );
  });

  it("returns undefined for unknown tool", () => {
    assert.equal(describeToolDetail("CustomTool", { foo: "bar" }), undefined);
  });
});

describe("parsePlanUpdate", () => {
  it("parses update_plan JSON and normalizes statuses", () => {
    const parsed = parsePlanUpdate(
      JSON.stringify({
        explanation: "Current plan",
        plan: [
          { step: "Inspect the code", status: "completed" },
          { step: "Wire the new task flow", status: "inProgress" },
          { step: "Run checks", status: "pending" },
        ],
      }),
    );

    assert.deepEqual(parsed, {
      explanation: "Current plan",
      tasks: [
        { id: "plan-0", subject: "Inspect the code", status: "completed" },
        { id: "plan-1", subject: "Wire the new task flow", status: "in_progress" },
        { id: "plan-2", subject: "Run checks", status: "pending" },
      ],
    });
  });

  it("returns undefined for invalid payloads", () => {
    assert.equal(parsePlanUpdate("not json"), undefined);
    assert.equal(parsePlanUpdate({ nope: true }), undefined);
  });
});

describe("buildTaskListActivityFromPlan", () => {
  it("builds a task_list activity from plan data", () => {
    const activity = buildTaskListActivityFromPlan({
      explanation: "Plan update",
      plan: [{ step: "Fix the bug", status: "in_progress" }],
    });

    assert.deepEqual(activity, {
      type: "activity",
      activity: "task_list",
      description: "Plan update",
      tasks: [{ id: "plan-0", subject: "Fix the bug", status: "in_progress" }],
    });
  });
});
