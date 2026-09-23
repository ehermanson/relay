// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchWorkspaceEntries } from "../dist/server/core/workspace-entries.js";

describe("searchWorkspaceEntries", () => {
  let rootDir;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "relay-ws-test-"));
    // Create a small project structure
    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "src", "components"), { recursive: true });
    mkdirSync(join(rootDir, "test"), { recursive: true });
    writeFileSync(join(rootDir, "package.json"), "{}");
    writeFileSync(join(rootDir, "README.md"), "# readme");
    writeFileSync(join(rootDir, "src", "index.ts"), "export {}");
    writeFileSync(join(rootDir, "src", "utils.ts"), "export {}");
    writeFileSync(join(rootDir, "src", "components", "button.tsx"), "<button/>");
    writeFileSync(join(rootDir, "src", "components", "input.tsx"), "<input/>");
    writeFileSync(join(rootDir, "test", "index.test.ts"), "test()");
  });

  afterEach(async () => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns results for an empty query (top-level entries first)", async () => {
    const results = await searchWorkspaceEntries(rootDir, "");
    assert.ok(results.length > 0);
    // Should include both files and directories
    const kinds = new Set(results.map((r) => r.kind));
    assert.ok(kinds.has("file"));
    assert.ok(kinds.has("directory"));
  });

  it("matches files by basename", async () => {
    const results = await searchWorkspaceEntries(rootDir, "button");
    assert.ok(results.length >= 1);
    assert.ok(results.some((r) => r.path.includes("button.tsx")));
  });

  it("matches files by path segment", async () => {
    const results = await searchWorkspaceEntries(rootDir, "components");
    assert.ok(results.length >= 1);
    // Should match the directory and files inside
    assert.ok(results.some((r) => r.path.includes("components")));
  });

  it("matches directories", async () => {
    const results = await searchWorkspaceEntries(rootDir, "src");
    assert.ok(results.some((r) => r.kind === "directory" && r.path === "src"));
  });

  it("strips leading @ from query (mention syntax)", async () => {
    const results = await searchWorkspaceEntries(rootDir, "@utils");
    assert.ok(results.some((r) => r.path.includes("utils.ts")));
  });

  it("is case-insensitive", async () => {
    const results = await searchWorkspaceEntries(rootDir, "README");
    assert.ok(results.some((r) => r.path.includes("README.md")));
  });

  it("returns empty for non-matching query", async () => {
    const results = await searchWorkspaceEntries(rootDir, "zzzznonexistent");
    assert.equal(results.length, 0);
  });

  it("returns empty for nonexistent directory", async () => {
    const results = await searchWorkspaceEntries("/nonexistent/dir", "test");
    assert.equal(results.length, 0);
  });

  it("skips node_modules and .git directories", async () => {
    mkdirSync(join(rootDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(rootDir, "node_modules", "pkg", "index.js"), "");
    mkdirSync(join(rootDir, ".git", "objects"), { recursive: true });
    writeFileSync(join(rootDir, ".git", "config"), "");

    const results = await searchWorkspaceEntries(rootDir, "");
    const paths = results.map((r) => r.path);
    assert.ok(!paths.some((p) => p.startsWith("node_modules")));
    assert.ok(!paths.some((p) => p.startsWith(".git")));
  });

  it("ranks exact basename matches higher than partial matches", async () => {
    const results = await searchWorkspaceEntries(rootDir, "index.ts");
    assert.ok(results.length >= 1);
    // The exact match should be first
    assert.equal(results[0].path, "src/index.ts");
  });

  it("limits results to max 25", async () => {
    // Create many files
    mkdirSync(join(rootDir, "many"), { recursive: true });
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(rootDir, "many", `file${i}.txt`), "");
    }

    const results = await searchWorkspaceEntries(rootDir, "file");
    assert.ok(results.length <= 25);
  });
});
