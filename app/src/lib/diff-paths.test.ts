import { describe, expect, it } from "vitest";
import { toDiffPath } from "./diff-paths";

describe("toDiffPath", () => {
  it("is relative to the working directory when the diff root is unknown", () => {
    expect(toDiffPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("matches a file in a worktree the agent entered", () => {
    const worktree = "/repo/.claude/worktrees/fix";
    expect(toDiffPath(`${worktree}/src/a.ts`, "/repo", [worktree])).toBe("src/a.ts");
  });

  it("is relative to the repo root for a chat in a subdirectory", () => {
    expect(toDiffPath("/repo/app/src/a.ts", "/repo/app", ["/repo"])).toBe("app/src/a.ts");
  });

  it("resolves a path relative to the working directory", () => {
    expect(toDiffPath("src/a.ts", "/repo/app", ["/repo"])).toBe("app/src/a.ts");
    const worktree = "/repo/.claude/worktrees/fix";
    expect(toDiffPath(".claude/worktrees/fix/a.ts", "/repo", [worktree])).toBe("a.ts");
  });

  it("matches both spellings of a symlinked root", () => {
    const roots = ["/link/repo", "/real/repo"];
    expect(toDiffPath("/link/repo/src/a.ts", "/link/repo", roots)).toBe("src/a.ts");
    expect(toDiffPath("/real/repo/src/a.ts", "/link/repo", roots)).toBe("src/a.ts");
  });

  it("never matches a file outside the diff root", () => {
    expect(toDiffPath("/repo/a.ts", "/repo", ["/repo/.claude/worktrees/fix"])).toBe("/repo/a.ts");
    expect(toDiffPath("/repo-two/a.ts", "/repo", ["/repo"])).toBe("/repo-two/a.ts");
  });
});
