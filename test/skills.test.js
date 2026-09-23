// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSkills } from "../dist/server/core/skills.js";

// discoverSkills reads from fixed paths under homedir(). To test it properly
// we'd need to mock homedir, which is fragile. Instead, we test project-scoped
// skills (via projectDir parameter) which we control completely.

describe("discoverSkills — project-scoped", () => {
  let projectDir;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "relay-skills-test-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("discovers skills from project .claude/skills directory", () => {
    const skillDir = join(projectDir, ".claude", "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: my-skill",
        "description: A test skill",
        "---",
        "",
        "Skill body content here.",
      ].join("\n"),
    );

    const skills = discoverSkills(projectDir);
    const found = skills.find((s) => s.name === "my-skill");
    assert.ok(found, "Should find the project-scoped skill");
    assert.equal(found.description, "A test skill");
    assert.equal(found.source, "project");
    assert.ok(found.providers.includes("claude"));
  });

  it("uses directory name as fallback when name field is missing", () => {
    const skillDir = join(projectDir, ".claude", "skills", "fallback-name");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "description: No name field", "---", "", "Body."].join("\n"),
    );

    const skills = discoverSkills(projectDir);
    const found = skills.find((s) => s.name === "fallback-name");
    assert.ok(found, "Should use directory name as fallback");
    assert.equal(found.description, "No name field");
  });

  it("skips directories without SKILL.md", () => {
    const emptyDir = join(projectDir, ".claude", "skills", "no-skill-file");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "README.md"), "Not a skill");

    const skills = discoverSkills(projectDir);
    assert.ok(!skills.some((s) => s.name === "no-skill-file"));
  });

  it("discovers multiple skills and sorts alphabetically", () => {
    for (const name of ["zebra-skill", "alpha-skill", "beta-skill"]) {
      const dir = join(projectDir, ".claude", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        [`---`, `name: ${name}`, `description: ${name} desc`, `---`].join("\n"),
      );
    }

    const skills = discoverSkills(projectDir);
    const projectSkills = skills.filter((s) => s.source === "project");
    const names = projectSkills.map((s) => s.name);
    assert.ok(names.indexOf("alpha-skill") < names.indexOf("beta-skill"));
    assert.ok(names.indexOf("beta-skill") < names.indexOf("zebra-skill"));
  });

  it("returns empty when no skills directory exists", () => {
    // projectDir has no .claude/skills/
    const skills = discoverSkills(projectDir);
    // May return user/system skills, but no project skills
    assert.ok(!skills.some((s) => s.source === "project"));
  });

  it("handles quoted name and description values", () => {
    const skillDir = join(projectDir, ".claude", "skills", "quoted");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", 'name: "quoted-name"', "description: 'single-quoted desc'", "---"].join("\n"),
    );

    const skills = discoverSkills(projectDir);
    const found = skills.find((s) => s.name === "quoted-name");
    assert.ok(found);
    assert.equal(found.description, "single-quoted desc");
  });

  it("handles SKILL.md with no frontmatter", () => {
    const skillDir = join(projectDir, ".claude", "skills", "no-frontmatter");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "Just plain text, no frontmatter.");

    const skills = discoverSkills(projectDir);
    // Should fall back to directory name
    const found = skills.find((s) => s.name === "no-frontmatter");
    assert.ok(found);
    assert.equal(found.description, "");
  });

  it("handles SKILL.md with incomplete frontmatter", () => {
    const skillDir = join(projectDir, ".claude", "skills", "incomplete");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), ["---", "name: just-name", "---"].join("\n"));

    const skills = discoverSkills(projectDir);
    const found = skills.find((s) => s.name === "just-name");
    assert.ok(found);
    assert.equal(found.description, "");
  });

  it("skips hidden directories", () => {
    const hiddenDir = join(projectDir, ".claude", "skills", ".hidden-skill");
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(
      join(hiddenDir, "SKILL.md"),
      ["---", "name: hidden", "description: should be skipped", "---"].join("\n"),
    );

    const skills = discoverSkills(projectDir);
    assert.ok(!skills.some((s) => s.name === "hidden"));
  });
});
