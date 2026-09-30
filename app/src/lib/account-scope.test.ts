import { afterEach, describe, expect, it } from "vitest";
import type { AccountStatus } from "@shared/types";
import {
  ACTIVE_ACCOUNT_STORAGE_KEY,
  accountInitial,
  chatAccountMismatch,
  chatBelongsToAccount,
  isMultiAccount,
  isProjectScopedPath,
  loginDirForAccount,
  projectAccountIds,
  projectAccountMismatch,
  projectBelongsToAccount,
  readStoredActiveAccountId,
  resolveActiveAccountId,
  stateKeyFor,
  writeStoredActiveAccountId,
} from "./account-scope";

const defaultAccount: AccountStatus = {
  id: "default",
  label: "Default",
  isDefault: true,
  logins: {
    claude: { configDir: "/Users/me/.claude", probeState: "ok" },
    codex: { configDir: "/Users/me/.codex", probeState: "ok" },
  },
};
const work: AccountStatus = {
  id: "work",
  label: "Work",
  isDefault: false,
  logins: { claude: { configDir: "/Users/me/.claude-work", probeState: "ok" } },
};
const both = [defaultAccount, work];

afterEach(() => {
  localStorage.clear();
});

describe("isMultiAccount", () => {
  it("is true only from two accounts up", () => {
    expect(isMultiAccount([])).toBe(false);
    expect(isMultiAccount([defaultAccount])).toBe(false);
    expect(isMultiAccount(both)).toBe(true);
  });
});

describe("resolveActiveAccountId", () => {
  it("keeps a stored id that still exists", () => {
    expect(resolveActiveAccountId("work", both)).toBe("work");
  });

  it("falls back to default when the stored id is gone or the list is empty", () => {
    expect(resolveActiveAccountId("old", both)).toBe("default");
    expect(resolveActiveAccountId("work", [])).toBe("default");
    expect(resolveActiveAccountId(null, both)).toBe("default");
  });
});

describe("loginDirForAccount", () => {
  it("is absent for the default account, whatever the provider", () => {
    expect(loginDirForAccount(defaultAccount, "claude")).toBeUndefined();
    expect(loginDirForAccount(defaultAccount, "codex")).toBeUndefined();
    expect(loginDirForAccount(undefined, "claude")).toBeUndefined();
  });

  it("is that provider's login dir for another account", () => {
    expect(loginDirForAccount(work, "claude")).toBe("/Users/me/.claude-work");
  });

  it("never falls back for a provider the account has no login for", () => {
    expect(loginDirForAccount(work, "codex")).toBeUndefined();
    expect(loginDirForAccount(work, undefined)).toBeUndefined();
  });
});

describe("stateKeyFor", () => {
  it("leaves the default dir empty and normalizes non-default dirs", () => {
    expect(stateKeyFor("claude")).toBe("claude:");
    expect(stateKeyFor("claude", null)).toBe("claude:");
    expect(stateKeyFor("claude", "/Users/me/.claude-work/")).toBe("claude:/Users/me/.claude-work");
    expect(stateKeyFor("codex", "/Users/me/.codex-work")).toBe("codex:/Users/me/.codex-work");
  });
});

describe("chatBelongsToAccount", () => {
  it("treats an absent accountId as the default account", () => {
    expect(chatBelongsToAccount({}, "default")).toBe(true);
    expect(chatBelongsToAccount({}, "work")).toBe(false);
  });

  it("matches a chat to its account regardless of provider", () => {
    expect(chatBelongsToAccount({ accountId: "work" }, "work")).toBe(true);
    expect(chatBelongsToAccount({ accountId: "work" }, "default")).toBe(false);
    expect(chatBelongsToAccount({ accountId: "default" }, "default")).toBe(true);
  });

  it("files a chat whose account no longer exists under the default account", () => {
    const chat = { accountId: "removed" };
    expect(chatBelongsToAccount(chat, "default", both)).toBe(true);
    expect(chatBelongsToAccount(chat, "work", both)).toBe(false);
    // Without the account list the id is taken at face value.
    expect(chatBelongsToAccount(chat, "default")).toBe(false);
  });
});

describe("chatAccountMismatch", () => {
  it("is null below two accounts, whatever the chat says", () => {
    expect(chatAccountMismatch({ accountId: "work" }, "default", [defaultAccount])).toBeNull();
    expect(chatAccountMismatch({ accountId: "work" }, "default", [])).toBeNull();
  });

  it("is null when the chat belongs to the active account", () => {
    expect(chatAccountMismatch({ accountId: "work" }, "work", both)).toBeNull();
    expect(chatAccountMismatch({}, "default", both)).toBeNull();
    expect(chatAccountMismatch({ accountId: "default" }, "default", both)).toBeNull();
  });

  it("names the owning account when it differs from the active one", () => {
    expect(chatAccountMismatch({ accountId: "work" }, "default", both)).toBe(work);
    expect(chatAccountMismatch({}, "work", both)).toBe(defaultAccount);
  });

  it("files a chat whose account no longer exists under the default account", () => {
    expect(chatAccountMismatch({ accountId: "removed" }, "work", both)).toBe(defaultAccount);
    expect(chatAccountMismatch({ accountId: "removed" }, "default", both)).toBeNull();
  });
});

describe("projectAccountMismatch", () => {
  it("is null below two accounts and when the active account is a member", () => {
    expect(
      projectAccountMismatch({ accountIds: ["work"] }, "default", [defaultAccount]),
    ).toBeNull();
    expect(projectAccountMismatch({ accountIds: ["work"] }, "work", both)).toBeNull();
    expect(projectAccountMismatch({ accountIds: [] }, "default", both)).toBeNull();
    expect(projectAccountMismatch({ accountIds: ["default", "work"] }, "work", both)).toBeNull();
  });

  it("names the first registered owner when the active account is not a member", () => {
    expect(projectAccountMismatch({ accountIds: ["work"] }, "default", both)).toBe(work);
    expect(projectAccountMismatch({ accountIds: [] }, "work", both)).toBe(defaultAccount);
    expect(projectAccountMismatch({ accountIds: ["work", "default"] }, "other", both)).toBe(
      defaultAccount,
    );
  });

  it("falls back to the default account when every owner is gone", () => {
    expect(projectAccountMismatch({ accountIds: ["removed"] }, "work", both)).toBe(defaultAccount);
  });
});

describe("isProjectScopedPath", () => {
  it("matches chats, spaces and project pages", () => {
    expect(isProjectScopedPath("/projects")).toBe(true);
    expect(isProjectScopedPath("/projects/relay")).toBe(true);
    expect(isProjectScopedPath("/projects/relay/chats/abc")).toBe(true);
    expect(isProjectScopedPath("/projects/relay/spaces/s1/abc")).toBe(true);
    expect(isProjectScopedPath("/projects/relay/settings")).toBe(true);
  });

  it("leaves Home and Settings alone", () => {
    expect(isProjectScopedPath("/")).toBe(false);
    expect(isProjectScopedPath("/settings/providers")).toBe(false);
    expect(isProjectScopedPath("/projectsx")).toBe(false);
  });
});

describe("projectBelongsToAccount", () => {
  it("ignores membership with a single account", () => {
    expect(projectBelongsToAccount({ accountIds: ["work"] }, "default", false)).toBe(true);
  });

  it("uses membership with several accounts, defaulting an empty list", () => {
    expect(projectBelongsToAccount({ accountIds: ["work"] }, "work", true)).toBe(true);
    expect(projectBelongsToAccount({ accountIds: ["work"] }, "default", true)).toBe(false);
    expect(projectBelongsToAccount({ accountIds: [] }, "default", true)).toBe(true);
    expect(
      projectBelongsToAccount({ accountIds: undefined as unknown as string[] }, "default", true),
    ).toBe(true);
    expect(projectBelongsToAccount({ accountIds: ["default", "work"] }, "work", true)).toBe(true);
  });

  it("normalizes membership lists", () => {
    expect(projectAccountIds({ accountIds: [] })).toEqual(["default"]);
    expect(projectAccountIds({ accountIds: ["work"] })).toEqual(["work"]);
  });
});

describe("stored active account", () => {
  it("round-trips through localStorage", () => {
    expect(readStoredActiveAccountId()).toBeNull();
    writeStoredActiveAccountId("work");
    expect(localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY)).toBe("work");
    expect(readStoredActiveAccountId()).toBe("work");
  });
});

describe("accountInitial", () => {
  it("uppercases the first character and never renders empty", () => {
    expect(accountInitial("work")).toBe("W");
    expect(accountInitial("  personal")).toBe("P");
    expect(accountInitial("")).toBe("A");
    expect(accountInitial(undefined)).toBe("A");
  });
});
