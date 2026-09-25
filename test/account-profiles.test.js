// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_PROFILE_LABEL_MAX,
  accountProfileRoots,
  defaultAccountProfile,
  findProfileForConfigDir,
  listAccountProfiles,
  normalizeConfigDir,
  resolveAccountProfile,
  validateAccountProfileInput,
} from "../dist/server/core/account-profiles.js";
import { DEFAULT_ACCOUNT_PROFILE_ID } from "../dist/server/core/types.js";

const DEFAULT_DIR = "/home/me/.claude";
const work = { id: "work", provider: "claude", label: "Work", configDir: "/home/me/.claude-work" };
const personal = {
  id: "personal",
  provider: "claude",
  label: "Personal",
  configDir: "/home/me/.claude-personal/",
};
const codexProfile = {
  id: "cx",
  provider: "codex",
  label: "Codex",
  configDir: "/home/me/.codex-2",
};

describe("account profiles — pure helpers", () => {
  it("normalizes trailing slashes and whitespace", () => {
    assert.equal(normalizeConfigDir("  /a/b//  "), "/a/b");
    assert.equal(normalizeConfigDir("/"), "/");
    assert.equal(normalizeConfigDir("///"), "/");
  });

  it("lists the default profile first, then stored profiles for that provider only", () => {
    const list = listAccountProfiles([work, codexProfile, personal], "claude", DEFAULT_DIR);
    assert.deepEqual(
      list.map((p) => p.id),
      [DEFAULT_ACCOUNT_PROFILE_ID, "work", "personal"],
    );
    assert.deepEqual(list[0], defaultAccountProfile("claude", DEFAULT_DIR));
    assert.equal(list[0].configDir, DEFAULT_DIR);
  });

  it("never lists a stored row that claims the default id", () => {
    const rogue = { ...work, id: DEFAULT_ACCOUNT_PROFILE_ID };
    const list = listAccountProfiles([rogue], "claude", DEFAULT_DIR);
    assert.equal(list.length, 1);
    assert.equal(list[0].configDir, DEFAULT_DIR);
  });

  it("finds a profile by config dir (normalized) and the default for no dir", () => {
    const list = listAccountProfiles([work, personal], "claude", DEFAULT_DIR);
    assert.equal(findProfileForConfigDir(list, "/home/me/.claude-personal")?.id, "personal");
    assert.equal(findProfileForConfigDir(list, "/home/me/.claude-work/")?.id, "work");
    assert.equal(findProfileForConfigDir(list, undefined)?.id, DEFAULT_ACCOUNT_PROFILE_ID);
    assert.equal(findProfileForConfigDir(list, "/elsewhere"), undefined);
  });

  describe("resolveAccountProfile precedence", () => {
    const profiles = listAccountProfiles([work, personal], "claude", DEFAULT_DIR);
    const providerDefaults = { claude: { profileId: "personal" } };

    it("explicit choice wins over project and global defaults", () => {
      const r = resolveAccountProfile({
        provider: "claude",
        profileId: "work",
        projectDefaultProfileId: "personal",
        providerDefaults,
        profiles,
      });
      assert.equal(r.profile.id, "work");
      assert.equal(r.configDir, work.configDir);
    });

    it("project default wins over the global provider default", () => {
      const r = resolveAccountProfile({
        provider: "claude",
        projectDefaultProfileId: "work",
        providerDefaults,
        profiles,
      });
      assert.equal(r.profile.id, "work");
    });

    it("falls back to the global provider default", () => {
      const r = resolveAccountProfile({ provider: "claude", providerDefaults, profiles });
      assert.equal(r.profile.id, "personal");
      assert.equal(r.configDir, personal.configDir);
    });

    it("resolves to the default profile with an undefined configDir when nothing is set", () => {
      const r = resolveAccountProfile({ provider: "claude", profiles });
      assert.equal(r.profile.id, DEFAULT_ACCOUNT_PROFILE_ID);
      assert.equal(r.configDir, undefined);
    });

    it("an unknown (deleted) id falls through to the next level", () => {
      const r = resolveAccountProfile({
        provider: "claude",
        profileId: "gone",
        projectDefaultProfileId: "also-gone",
        providerDefaults,
        profiles,
      });
      assert.equal(r.profile.id, "personal");
      const r2 = resolveAccountProfile({
        provider: "claude",
        profileId: "gone",
        providerDefaults: { claude: { profileId: "nope" } },
        profiles,
      });
      assert.equal(r2.profile.id, DEFAULT_ACCOUNT_PROFILE_ID);
      assert.equal(r2.configDir, undefined);
    });
  });

  describe("validateAccountProfileInput", () => {
    const existing = listAccountProfiles([work], "claude", DEFAULT_DIR);

    it("accepts a well-formed input and normalizes the dir", () => {
      const out = validateAccountProfileInput(
        { label: "  Personal ", configDir: "/home/me/.claude-personal/" },
        existing,
      );
      assert.deepEqual(out, { label: "Personal", configDir: "/home/me/.claude-personal" });
    });

    it("accepts a ~-prefixed dir (expansion is the route's job)", () => {
      const out = validateAccountProfileInput({ label: "P", configDir: "~/.claude-p" }, existing);
      assert.equal(out.configDir, "~/.claude-p");
    });

    it("rejects a missing or overlong label", () => {
      assert.throws(
        () => validateAccountProfileInput({ label: "  ", configDir: "/x" }, existing),
        /Enter a name/,
      );
      assert.throws(
        () =>
          validateAccountProfileInput(
            { label: "x".repeat(ACCOUNT_PROFILE_LABEL_MAX + 1), configDir: "/x" },
            existing,
          ),
        new RegExp(`at most ${ACCOUNT_PROFILE_LABEL_MAX}`),
      );
    });

    it("rejects a missing or relative config dir", () => {
      assert.throws(
        () => validateAccountProfileInput({ label: "P", configDir: "" }, existing),
        /config directory/,
      );
      assert.throws(
        () => validateAccountProfileInput({ label: "P", configDir: "relative/dir" }, existing),
        /absolute path/,
      );
    });

    it("rejects a duplicate dir (normalized) and a duplicate label (case-insensitive)", () => {
      assert.throws(
        () =>
          validateAccountProfileInput(
            { label: "New", configDir: "/home/me/.claude-work/" },
            existing,
          ),
        /"Work" already uses/,
      );
      assert.throws(
        () => validateAccountProfileInput({ label: "work", configDir: "/other" }, existing),
        /named "Work" already exists/,
      );
      // The default dir is also a duplicate.
      assert.throws(
        () => validateAccountProfileInput({ label: "New", configDir: DEFAULT_DIR }, existing),
        /"Default" already uses/,
      );
    });

    it("excludes the profile being renamed from duplicate checks", () => {
      const out = validateAccountProfileInput(
        { label: "WORK", configDir: work.configDir },
        existing,
        { excludeId: "work" },
      );
      assert.equal(out.label, "WORK");
    });
  });

  it("accountProfileRoots dedupes normalized dirs and keeps the default first", () => {
    const list = listAccountProfiles(
      [work, { ...personal, id: "dup", configDir: "/home/me/.claude-work/" }, personal],
      "claude",
      DEFAULT_DIR,
    );
    assert.deepEqual(accountProfileRoots(list), [
      DEFAULT_DIR,
      "/home/me/.claude-work",
      "/home/me/.claude-personal",
    ]);
  });
});
