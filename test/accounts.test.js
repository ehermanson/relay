// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Accounts — a named context owning one login (config dir) per provider:
 *  - pure helpers (`server/core/accounts.ts`)
 *  - `AccountStore` (`server/core/account-store.ts`): storage in
 *    `global_settings.accounts_json`, the implicit default account, the
 *    legacy `provider_profiles_json` migration-on-read, change notification.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB } from "../dist/server/core/db.js";
import { noopLogger } from "../dist/server/core/logger.js";
import { AccountStore } from "../dist/server/core/account-store.js";
import {
  ACCOUNT_LABEL_MAX,
  DEFAULT_ACCOUNT_LABEL,
  accountLoginRoots,
  accountProviders,
  accountsFromLegacyProfiles,
  defaultAccount,
  findAccountForLogin,
  listAccounts,
  loginRootForTranscriptPath,
  normalizeAccountIds,
  normalizeConfigDir,
  resolveAccountLogin,
  validateAccountLabel,
  validateAccountLogins,
} from "../dist/server/core/accounts.js";
import { DEFAULT_ACCOUNT_ID } from "../dist/server/core/types.js";

const DEFAULTS = { claude: "/home/me/.claude", codex: "/home/me/.codex/" };
const WORK = {
  id: "work",
  label: "Work",
  logins: { claude: { configDir: "/home/me/.claude-work/" }, codex: { configDir: "/w/.codex" } },
};
const PERSONAL = {
  id: "personal",
  label: "Personal",
  logins: { claude: { configDir: "/home/me/.claude-personal" } },
};
const LOGIN_PROVIDERS = ["claude", "codex"];

describe("accounts — pure helpers", () => {
  it("normalizes trailing slashes and whitespace", () => {
    assert.equal(normalizeConfigDir(" /a/b// "), "/a/b");
    assert.equal(normalizeConfigDir("/"), "/");
  });

  it("the default account owns the server's dir for every installed provider", () => {
    assert.deepEqual(defaultAccount(DEFAULTS), {
      id: DEFAULT_ACCOUNT_ID,
      label: DEFAULT_ACCOUNT_LABEL,
      logins: {
        claude: { configDir: "/home/me/.claude" },
        codex: { configDir: "/home/me/.codex" },
      },
    });
    // A provider that isn't installed has no login in the default account.
    assert.deepEqual(accountProviders(defaultAccount({ claude: "/c" })), ["claude"]);
    assert.equal(defaultAccount(DEFAULTS, "  Main ").label, "Main");
  });

  it("lists the default first, then stored accounts in stored order", () => {
    const accounts = listAccounts([PERSONAL, WORK], DEFAULTS);
    assert.deepEqual(
      accounts.map((a) => a.id),
      ["default", "personal", "work"],
    );
    assert.equal(accounts[2].logins.claude.configDir, "/home/me/.claude-work", "normalized");
  });

  it("a stored default entry only renames it — its logins always come from the server", () => {
    const accounts = listAccounts(
      [{ id: "default", label: "Home", logins: { claude: { configDir: "/evil" } } }, WORK],
      DEFAULTS,
    );
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].label, "Home");
    assert.equal(accounts[0].logins.claude.configDir, "/home/me/.claude");
  });

  it("drops duplicates, malformed entries and accounts left with no login", () => {
    const accounts = listAccounts(
      [
        WORK,
        { ...WORK, label: "Dup" },
        null,
        { id: 7, label: "bad id", logins: WORK.logins },
        { id: "empty", label: "Empty", logins: {} },
        { id: "blank", label: "Blank", logins: { claude: { configDir: "  " } } },
        { id: "nolabel", label: " ", logins: { codex: { configDir: "/x" } } },
      ],
      DEFAULTS,
    );
    assert.deepEqual(
      accounts.map((a) => [a.id, a.label]),
      [
        ["default", "Default"],
        ["work", "Work"],
        ["nolabel", "nolabel"],
      ],
    );
    assert.deepEqual(
      listAccounts(null, DEFAULTS).map((a) => a.id),
      ["default"],
    );
  });

  it("migrates legacy per-provider profiles: one account per profile, holding that one login", () => {
    assert.deepEqual(
      accountsFromLegacyProfiles([
        { id: "w", provider: "claude", label: "Work", configDir: "/w/" },
        { id: "default", provider: "claude", label: "Default", configDir: "/d" },
        { id: "c", provider: "codex", label: "Codex", configDir: "/c" },
      ]),
      [
        { id: "w", label: "Work", logins: { claude: { configDir: "/w" } } },
        { id: "c", label: "Codex", logins: { codex: { configDir: "/c" } } },
      ],
    );
    assert.deepEqual(accountsFromLegacyProfiles(null), []);
  });

  describe("resolveAccountLogin — no login means unavailable, never a fallback", () => {
    const accounts = listAccounts([WORK, PERSONAL], DEFAULTS);

    it("binds a non-default account's login dir", () => {
      const resolved = resolveAccountLogin(accounts, "work", "claude");
      assert.equal(resolved.available, true);
      assert.equal(resolved.account.id, "work");
      assert.equal(resolved.configDir, "/home/me/.claude-work");
    });

    it("the default account resolves with an undefined configDir", () => {
      for (const id of [undefined, null, "default"]) {
        const resolved = resolveAccountLogin(accounts, id, "codex");
        assert.equal(resolved.available, true);
        assert.equal(resolved.account.id, "default");
        assert.equal(resolved.configDir, undefined);
      }
    });

    it("an unknown (deleted) id is the default account, never a failure", () => {
      const resolved = resolveAccountLogin(accounts, "gone", "claude");
      assert.equal(resolved.account.id, "default");
      assert.equal(resolved.available, true);
    });

    it("a provider with no login in the account is unavailable there", () => {
      const resolved = resolveAccountLogin(accounts, "personal", "codex");
      assert.equal(resolved.available, false);
      assert.equal(resolved.account.id, "personal");
      assert.equal("configDir" in resolved, false);
      // …including the default account when the provider isn't installed.
      const bare = listAccounts([], { claude: "/c" });
      assert.equal(resolveAccountLogin(bare, undefined, "codex").available, false);
    });
  });

  it("finds the account owning a login (normalized); no dir is the default; unknown dir is nothing", () => {
    const accounts = listAccounts([WORK, PERSONAL], DEFAULTS);
    assert.equal(findAccountForLogin(accounts, "claude", "/home/me/.claude-work//").id, "work");
    assert.equal(findAccountForLogin(accounts, "codex", "/w/.codex").id, "work");
    assert.equal(findAccountForLogin(accounts, "claude", "/home/me/.claude").id, "default");
    assert.equal(findAccountForLogin(accounts, "claude", undefined).id, "default");
    assert.equal(findAccountForLogin(accounts, "claude", "/nowhere"), undefined);
    // Provider-scoped: Work's Codex dir is not a Claude login.
    assert.equal(findAccountForLogin(accounts, "claude", "/w/.codex"), undefined);
  });

  it("accountLoginRoots: the default's dir first, per provider, deduped", () => {
    const accounts = listAccounts(
      [WORK, PERSONAL, { id: "dup", label: "Dup", logins: { codex: { configDir: "/w/.codex/" } } }],
      DEFAULTS,
    );
    assert.deepEqual(accountLoginRoots(accounts, "claude"), [
      "/home/me/.claude",
      "/home/me/.claude-work",
      "/home/me/.claude-personal",
    ]);
    assert.deepEqual(accountLoginRoots(accounts, "codex"), ["/home/me/.codex", "/w/.codex"]);
  });

  describe("loginRootForTranscriptPath", () => {
    it("returns the root above the provider's transcript folder", () => {
      assert.equal(
        loginRootForTranscriptPath("claude", "/home/me/.claude-work/projects/-tmp-x/s.jsonl"),
        "/home/me/.claude-work",
      );
      assert.equal(
        loginRootForTranscriptPath("codex", "/w/.codex/sessions/2026/09/30/rollout-a.jsonl"),
        "/w/.codex",
      );
    });

    it("uses the last marker so a root under a 'projects' folder still resolves", () => {
      assert.equal(
        loginRootForTranscriptPath("claude", "/home/me/projects/cfg/projects/-tmp-x/s.jsonl"),
        "/home/me/projects/cfg",
      );
    });

    it("is undefined for odd paths and unknown providers", () => {
      assert.equal(loginRootForTranscriptPath("claude", null), undefined);
      assert.equal(loginRootForTranscriptPath("claude", "/no/marker/s.jsonl"), undefined);
      assert.equal(loginRootForTranscriptPath("claude", "/projects/x/s.jsonl"), undefined);
      assert.equal(loginRootForTranscriptPath("codex", "/a/projects/x/s.jsonl"), undefined);
      assert.equal(loginRootForTranscriptPath("other", "/a/projects/x/s.jsonl"), undefined);
      assert.equal(loginRootForTranscriptPath(undefined, "/a/projects/x/s.jsonl"), undefined);
    });
  });

  describe("normalizeAccountIds", () => {
    it("trims, dedupes, drops blanks and non-strings; empty means default only", () => {
      assert.deepEqual(normalizeAccountIds([" work ", "work", "", 3, null, "personal"]), [
        "work",
        "personal",
      ]);
      assert.deepEqual(normalizeAccountIds([]), ["default"]);
      assert.deepEqual(normalizeAccountIds(null), ["default"]);
      assert.deepEqual(normalizeAccountIds(["default", "work"]), ["default", "work"]);
    });
  });

  describe("validateAccountLabel", () => {
    const accounts = listAccounts([WORK], DEFAULTS);

    it("trims and accepts a fresh name", () => {
      assert.equal(validateAccountLabel("  Personal ", accounts), "Personal");
    });

    it("rejects a missing or overlong label", () => {
      assert.throws(() => validateAccountLabel("  ", accounts), /Enter a name/);
      assert.throws(() => validateAccountLabel(undefined, accounts), /Enter a name/);
      assert.throws(
        () => validateAccountLabel("x".repeat(ACCOUNT_LABEL_MAX + 1), accounts),
        /at most 40 characters/,
      );
    });

    it("rejects a duplicate (case-insensitive), the default's name included, unless excluded", () => {
      assert.throws(() => validateAccountLabel("work", accounts), /"Work" already exists/);
      assert.throws(() => validateAccountLabel("DEFAULT", accounts), /"Default" already exists/);
      assert.equal(validateAccountLabel("Work", accounts, { excludeId: "work" }), "Work");
    });
  });

  describe("validateAccountLogins", () => {
    const accounts = listAccounts([WORK], DEFAULTS);
    const options = { loginProviders: LOGIN_PROVIDERS };

    it("accepts well-formed logins and normalizes dirs (~ expansion is the route's job)", () => {
      assert.deepEqual(
        validateAccountLogins(
          { claude: { configDir: " /p/.claude/ " }, codex: { configDir: "~/.codex-p" } },
          accounts,
          options,
        ),
        { claude: { configDir: "/p/.claude" }, codex: { configDir: "~/.codex-p" } },
      );
    });

    it("skips blank entries but requires at least one login", () => {
      assert.deepEqual(
        validateAccountLogins(
          { claude: { configDir: "/p" }, codex: { configDir: " " } },
          accounts,
          options,
        ),
        { claude: { configDir: "/p" } },
      );
      for (const bad of [undefined, null, {}, "x", { claude: {} }, { claude: { configDir: 3 } }]) {
        assert.throws(
          () => validateAccountLogins(bad, accounts, options),
          /at least one provider login/,
        );
      }
    });

    it("rejects a provider without account logins and a relative dir", () => {
      assert.throws(
        () =>
          validateAccountLogins({ codex: { configDir: "/p" } }, accounts, {
            loginProviders: ["claude"],
          }),
        /codex does not support separate account logins/,
      );
      assert.throws(
        () => validateAccountLogins({ claude: { configDir: "rel/dir" } }, accounts, options),
        /must be an absolute path/,
      );
    });

    it("rejects a dir another account already uses for that provider — the default's included", () => {
      assert.throws(
        () =>
          validateAccountLogins(
            { claude: { configDir: "/home/me/.claude-work" } },
            accounts,
            options,
          ),
        /"Work" already uses that claude config directory/,
      );
      assert.throws(
        () =>
          validateAccountLogins({ codex: { configDir: "/home/me/.codex/" } }, accounts, options),
        /"Default" already uses that codex config directory/,
      );
      // Same dir under a different provider is a different login.
      assert.deepEqual(
        validateAccountLogins({ codex: { configDir: "/home/me/.claude-work" } }, accounts, options),
        { codex: { configDir: "/home/me/.claude-work" } },
      );
      // Editing an account keeps its own dirs.
      assert.deepEqual(
        validateAccountLogins({ claude: { configDir: "/home/me/.claude-work" } }, accounts, {
          ...options,
          excludeId: "work",
        }),
        { claude: { configDir: "/home/me/.claude-work" } },
      );
    });
  });
});

describe("AccountStore", () => {
  const cleanup = [];

  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()();
  });

  function setup(defaults = DEFAULTS) {
    const tmp = mkdtempSync(join(tmpdir(), "relay-accounts-"));
    const db = new SessionDB(join(tmp, "sessions.db"), noopLogger);
    let current = defaults;
    const store = new AccountStore(db, () => current);
    const changes = [];
    store.onChange(() => changes.push(store.list().map((a) => a.id)));
    cleanup.push(() => {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    });
    const stored = () => {
      const raw = db.getGlobalSettings().accounts_json;
      return raw ? JSON.parse(raw) : null;
    };
    return { db, store, changes, stored, setDefaults: (next) => (current = next) };
  }
  const options = { loginProviders: LOGIN_PROVIDERS };

  it("a fresh install has only the implicit default account and stores nothing", () => {
    const { store, stored, setDefaults } = setup();
    const accounts = store.list();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, DEFAULT_ACCOUNT_ID);
    assert.deepEqual(Object.keys(accounts[0].logins), ["claude", "codex"]);
    assert.equal(stored(), null);
    assert.equal(store.get("default").label, "Default");
    assert.equal(store.get("nope"), undefined);
    // The default's logins track the server's dirs live (e.g. a provider gets installed).
    setDefaults({ claude: "/c" });
    assert.deepEqual(store.get("default").logins, { claude: { configDir: "/c" } });
  });

  it("creates an account, persists it and notifies", () => {
    const { store, changes, stored } = setup();
    const account = store.create(
      { label: " Work ", logins: { claude: { configDir: "/w/.claude/" } } },
      options,
    );
    assert.match(account.id, /^[0-9a-f-]{36}$/);
    assert.equal(account.label, "Work");
    assert.deepEqual(account.logins, { claude: { configDir: "/w/.claude" } });
    assert.deepEqual(stored(), [account]);
    assert.deepEqual(changes, [["default", account.id]]);
    assert.deepEqual(store.get(account.id), account);
  });

  it("validates logins on create: provider support, duplicates, at least one", () => {
    const { store, changes } = setup();
    store.create({ label: "Work", logins: { claude: { configDir: "/w" } } }, options);
    assert.throws(
      () => store.create({ label: "Work", logins: { claude: { configDir: "/x" } } }, options),
      /already exists/,
    );
    assert.throws(
      () => store.create({ label: "Other", logins: { claude: { configDir: "/w/" } } }, options),
      /"Work" already uses that claude config directory/,
    );
    assert.throws(
      () =>
        store.create(
          { label: "Other", logins: { claude: { configDir: DEFAULTS.claude } } },
          options,
        ),
      /"Default" already uses/,
    );
    assert.throws(() => store.create({ label: "Other", logins: {} }, options), /at least one/);
    assert.throws(
      () =>
        store.create(
          { label: "Other", logins: { codex: { configDir: "/c" } } },
          { loginProviders: ["claude"] },
        ),
      /codex does not support/,
    );
    assert.equal(changes.length, 1, "a rejected mutation writes and notifies nothing");
  });

  it("resolveLogin / findForLogin / roots read through the stored list", () => {
    const { store } = setup();
    const work = store.create(
      { label: "Work", logins: { claude: { configDir: "/w/.claude" } } },
      options,
    );
    const resolved = store.resolveLogin(work.id, "claude");
    assert.equal(resolved.available, true);
    assert.equal(resolved.configDir, "/w/.claude");
    assert.equal(store.resolveLogin(work.id, "codex").available, false, "no Codex login in Work");
    assert.equal(store.resolveLogin(undefined, "codex").configDir, undefined);
    assert.equal(store.resolveLogin("gone", "claude").account.id, "default");

    assert.equal(store.findForLogin("claude", "/w/.claude/").id, work.id);
    assert.equal(store.findForLogin("claude", null).id, "default");
    assert.equal(store.findForLogin("codex", "/w/.claude"), undefined);

    assert.deepEqual(store.roots("claude"), ["/home/me/.claude", "/w/.claude"]);
    assert.deepEqual(store.roots("codex"), ["/home/me/.codex"]);
  });

  it("renames the default account (label only is stored); its logins can't be edited", () => {
    const { store, stored, changes } = setup();
    const renamed = store.update("default", { label: "Personal" }, options);
    assert.equal(renamed.label, "Personal");
    assert.deepEqual(renamed.logins, store.get("default").logins);
    assert.deepEqual(stored(), [{ id: "default", label: "Personal", logins: {} }]);
    assert.deepEqual(
      store.list().map((a) => [a.id, a.label]),
      [["default", "Personal"]],
    );
    assert.equal(changes.length, 1);
    assert.throws(
      () => store.update("default", { logins: { claude: { configDir: "/x" } } }, options),
      /cannot be edited/,
    );
    // Renaming again replaces the entry rather than stacking another.
    store.update("default", { label: "Home" }, options);
    assert.equal(stored().filter((a) => a.id === "default").length, 1);
    assert.equal(store.get("default").label, "Home");
  });

  it("updates label and/or logins in place, keeping stored order", () => {
    const { store, stored } = setup();
    const a = store.create({ label: "A", logins: { claude: { configDir: "/a" } } }, options);
    const b = store.create({ label: "B", logins: { claude: { configDir: "/b" } } }, options);

    const renamed = store.update(a.id, { label: "Alpha" }, options);
    assert.deepEqual(renamed, { ...a, label: "Alpha" });
    const relogged = store.update(
      a.id,
      { logins: { claude: { configDir: "/a" }, codex: { configDir: "/a-codex" } } },
      options,
    );
    assert.equal(relogged.label, "Alpha");
    assert.deepEqual(Object.keys(relogged.logins), ["claude", "codex"]);
    assert.deepEqual(
      stored().map((x) => x.id),
      [a.id, b.id],
    );

    assert.throws(() => store.update(a.id, { label: "b" }, options), /already exists/);
    assert.throws(
      () => store.update(a.id, { logins: { claude: { configDir: "/b" } } }, options),
      /"B" already uses/,
    );
    assert.throws(() => store.update(a.id, { logins: {} }, options), /at least one/);
    assert.throws(() => store.update("nope", { label: "X" }, options), /Account not found/);
  });

  it("removes a non-default account; the default can't be removed", () => {
    const { store, stored, changes } = setup();
    const a = store.create({ label: "A", logins: { claude: { configDir: "/a" } } }, options);
    assert.equal(store.remove("nope"), false);
    assert.equal(store.remove(a.id), true);
    assert.deepEqual(stored(), [], "an empty list stays a list — null would mean never migrated");
    assert.deepEqual(changes.at(-1), ["default"]);
    assert.throws(() => store.remove("default"), /cannot be removed/);
  });

  it("onChange returns an unsubscribe", () => {
    const { store } = setup();
    let calls = 0;
    const off = store.onChange(() => calls++);
    store.update("default", { label: "One" }, options);
    off();
    store.update("default", { label: "Two" }, options);
    assert.equal(calls, 1);
  });

  describe("legacy provider_profiles_json", () => {
    const LEGACY = [
      { id: "w", provider: "claude", label: "Work", configDir: "/w/.claude" },
      { id: "p", provider: "claude", label: "Personal", configDir: "/p/.claude" },
    ];

    it("is read as one account per profile while accounts_json was never written", () => {
      const { db, store, stored } = setup();
      db.updateGlobalSettings({ provider_profiles_json: JSON.stringify(LEGACY) });
      assert.deepEqual(
        store.list().map((a) => [a.id, a.label, Object.keys(a.logins)]),
        [
          ["default", "Default", ["claude", "codex"]],
          ["w", "Work", ["claude"]],
          ["p", "Personal", ["claude"]],
        ],
      );
      assert.equal(store.resolveLogin("w", "claude").configDir, "/w/.claude");
      assert.equal(store.resolveLogin("w", "codex").available, false);
      assert.equal(stored(), null, "reading never writes");
    });

    it("the first mutation carries the migrated accounts into accounts_json", () => {
      const { db, store, stored } = setup();
      db.updateGlobalSettings({ provider_profiles_json: JSON.stringify(LEGACY) });
      store.update(
        "w",
        { logins: { claude: { configDir: "/w/.claude" }, codex: { configDir: "/w/.codex" } } },
        options,
      );
      assert.deepEqual(
        stored().map((a) => [a.id, Object.keys(a.logins)]),
        [
          ["w", ["claude", "codex"]],
          ["p", ["claude"]],
        ],
      );
      // accounts_json now wins; the legacy column is ignored from here on.
      db.updateGlobalSettings({ provider_profiles_json: JSON.stringify([]) });
      assert.deepEqual(
        store.list().map((a) => a.id),
        ["default", "w", "p"],
      );
    });

    it("removing every migrated account persists an empty list instead of resurrecting them", () => {
      const { db, store, stored } = setup();
      db.updateGlobalSettings({ provider_profiles_json: JSON.stringify(LEGACY) });
      assert.equal(store.remove("w"), true);
      assert.equal(store.remove("p"), true);
      assert.deepEqual(
        stored(),
        [],
        "an emptied list is stored as [] — null would mean never migrated",
      );
      assert.deepEqual(
        store.list().map((a) => a.id),
        ["default"],
        "the legacy profiles must not come back once the user removed them",
      );
    });

    it("a corrupt column reads as no stored accounts", () => {
      const { db, store } = setup();
      db.updateGlobalSettings({ accounts_json: "{not json", provider_profiles_json: "nope" });
      assert.deepEqual(
        store.list().map((a) => a.id),
        ["default"],
      );
    });
  });
});
