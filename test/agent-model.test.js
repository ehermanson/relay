import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentModelFromTranscript } from "../dist/server/core/agent-model.js";
import { readAgentModelForProvider } from "../dist/server/core/provider-registry.js";

const directories = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "relay-agent-model-"));
  directories.push(dir);
  return dir;
}
const line = (entry) => JSON.stringify(entry) + "\n";

it("reads Codex model metadata past front-loaded context without parsing full history", () => {
  const dir = temp();
  mkdirSync(join(dir, "sessions"));
  const path = join(dir, "sessions", "rollout-child.jsonl");
  writeFileSync(
    path,
    line({ type: "session_meta", payload: { id: "child" } }) +
      line({ type: "response_item", payload: { text: "x".repeat(100_000), model: "wrong" } }) +
      line({ type: "turn_context", payload: { model: "gpt-6" } }) +
      "x".repeat(2_000_000),
  );
  assert.equal(
    readAgentModelForProvider("codex", {
      providerDirs: { codex: dir, claude: dir },
      agentId: "child",
      workingDirectory: dir,
      parseClaudeTranscript() {
        throw new Error("Must not parse history");
      },
    }),
    "gpt-6",
  );
});

it("resolves Claude child model through its provider-native id", () => {
  const dir = temp();
  mkdirSync(join(dir, "parent", "subagents"), { recursive: true });
  writeFileSync(
    join(dir, "parent", "subagents", "agent-child.jsonl"),
    line({ type: "assistant", message: { model: "<synthetic>" } }) +
      line({ type: "assistant", message: { model: "claude-sonnet-4-6" } }),
  );
  assert.equal(
    readAgentModelForProvider("claude", {
      providerDirs: { claude: dir, codex: dir },
      transcriptPath: join(dir, "parent.jsonl"),
      agentId: "tool-1",
      providerAgentId: "child",
      workingDirectory: dir,
      parseClaudeTranscript() {
        throw new Error("Must not parse history");
      },
    }),
    "claude-sonnet-4-6",
  );
});

it("rechecks a missing model as the child file grows, and tolerates absent files", () => {
  const path = join(temp(), "child.jsonl");
  assert.equal(readAgentModelFromTranscript(path, "codex"), undefined);
  writeFileSync(path, line({ type: "session_meta", payload: { id: "child" } }));
  assert.equal(readAgentModelFromTranscript(path, "codex"), undefined);
  appendFileSync(path, line({ type: "turn_context", payload: { model: "gpt-6" } }));
  assert.equal(readAgentModelFromTranscript(path, "codex"), "gpt-6");
});
