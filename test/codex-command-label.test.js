// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeCodexCommand } from "../dist/server/core/providers/codex-command-label.js";

describe("Codex command labels", () => {
  it("uses native read, search and listing metadata", () => {
    assert.equal(
      describeCodexCommand("opaque", [{ type: "read", name: "AGENTS.md", path: "/tmp/AGENTS.md" }]),
      "Read AGENTS.md",
    );
    assert.equal(
      describeCodexCommand("opaque", [{ type: "search", query: "tool_result", path: "app/src" }]),
      "Search for “tool_result”",
    );
    for (const type of ["listFiles", "list_files"]) {
      assert.equal(
        describeCodexCommand("opaque", [{ type, path: "app/src" }]),
        "List files in app/src",
      );
    }
  });
  it("summarizes the wrapped commit and push commands from the reported chat", () => {
    const commit = `/bin/zsh -lc 'PATH="/Users/me/.volta/tools/image/node/22.22.2/bin:$PATH" git commit -m "Restore file previews" > /tmp/commit.log 2>&1'`;
    const push = `/bin/zsh -lc 'PATH="/Users/me/.volta/tools/image/node/22.22.2/bin:$PATH" git push origin main > /tmp/push.log 2>&1'`;
    assert.equal(describeCodexCommand(commit), "Commit changes");
    assert.equal(describeCodexCommand(push), "Push changes");
    assert.equal(
      describeCodexCommand("/bin/zsh -lc 'tail -12 /tmp/log; git status --short'"),
      "Read files · Check Git status",
    );
  });
  it("does not mistake quoted arguments for additional commands", () => {
    assert.equal(
      describeCodexCommand(`git commit -m 'fix; git push && pnpm test'`),
      "Commit changes",
    );
    assert.equal(describeCodexCommand(`echo 'git push'`), "Run shell command");
    assert.equal(describeCodexCommand(`python3 -c 'print("git push")'`), "Run Python script");
    assert.equal(
      describeCodexCommand(`git -C '/tmp/my project' -c core.pager=cat status`),
      "Check Git status",
    );
    assert.equal(describeCodexCommand(`env CI=1 pnpm test`), "Run tests");
  });
  it("labels package tasks and test runners without inventing intent", () => {
    for (const cmd of [
      "pnpm test",
      "npm run test:unit",
      "pnpm exec vitest run",
      "node --test test/a.js",
      "/tools/node node_modules/vitest/vitest.mjs run",
    ])
      assert.equal(describeCodexCommand(cmd), "Run tests");
    assert.equal(describeCodexCommand("pnpm build:app"), "Build project");
    assert.equal(describeCodexCommand("pnpm typecheck"), "Check types");
    assert.equal(describeCodexCommand("pnpm lint"), "Run lint checks");
    assert.equal(describeCodexCommand("pnpm exec unknown --anything"), "Run shell command");
  });
  it("keeps mixed actions compact and falls back for complex scripts", () => {
    assert.equal(
      describeCodexCommand("pnpm test; pnpm test; git diff; git status"),
      "Run tests · Inspect changes (+1 more)",
    );
    assert.equal(describeCodexCommand('git commit -m "$(cat message)"'), "Run shell script");
    assert.equal(
      describeCodexCommand("python3 - <<'PY'\nprint('git push')\nPY"),
      "Run shell script",
    );
    assert.equal(describeCodexCommand("unterminated 'quote"), "Run shell script");
    assert.equal(
      describeCodexCommand("opaque", [{ type: "unknown", cmd: "git push" }]),
      "Push changes",
    );
    assert.equal(describeCodexCommand("git status", [null]), "Check Git status");
  });
});
