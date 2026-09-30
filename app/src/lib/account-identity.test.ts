import { describe, expect, it } from "vitest";
import type { AccountLoginStatus, AccountStatus, ProviderKind } from "@shared/types";
import {
  accountLoginEntries,
  accountLoginLine,
  accountLoginSummary,
  accountPrimaryIdentity,
  formatIdentity,
  formatLoginIdentity,
  hasUnsettledProbe,
} from "./account-identity";

function login(overrides: Partial<AccountLoginStatus> = {}): AccountLoginStatus {
  return { configDir: "/Users/me/.claude-work", probeState: "ok", ...overrides };
}

function account(logins: AccountStatus["logins"]): AccountStatus {
  return { id: "work", label: "Work", isDefault: false, logins };
}

const label = (provider: ProviderKind) => (provider === "claude" ? "Claude" : "Codex");

describe("formatIdentity", () => {
  it("joins email, org, and plan with middle dots", () => {
    expect(formatIdentity({ email: "a@b.co", label: "Acme", plan: "team" })).toBe(
      "a@b.co · Acme · team",
    );
  });

  it("skips missing and duplicate parts", () => {
    expect(formatIdentity({ email: "a@b.co", label: "a@b.co" })).toBe("a@b.co");
    expect(formatIdentity({ plan: "  " })).toBeNull();
    expect(formatIdentity(undefined)).toBeNull();
  });

  it("falls back to how the login authenticates", () => {
    expect(formatIdentity({ status: "Enterprise gateway" })).toBe("Enterprise gateway");
  });
});

describe("formatLoginIdentity", () => {
  it("prefers the probed identity", () => {
    expect(formatLoginIdentity(login({ identity: { email: "me@example.com", plan: "max" } }))).toBe(
      "me@example.com · max",
    );
  });

  it("describes an unsettled probe", () => {
    expect(formatLoginIdentity(login({ probeState: "probing" }))).toBe("Checking…");
    expect(formatLoginIdentity(login({ probeState: "unknown" }))).toBe("Checking…");
  });

  it("shows the probe error, falling back to not signed in", () => {
    expect(formatLoginIdentity(login({ probeState: "error", probeError: "No login" }))).toBe(
      "No login",
    );
    expect(formatLoginIdentity(login({ probeState: "error" }))).toBe("Not signed in");
  });

  it("never returns an empty line for a successful probe without identity", () => {
    expect(formatLoginIdentity(login())).toBe("Signed in");
  });
});

describe("accountLoginEntries", () => {
  it("orders logins by the given provider order, unknown providers last", () => {
    const row = account({ codex: login(), claude: login() });
    expect(accountLoginEntries(row, ["claude", "codex"]).map(([p]) => p)).toEqual([
      "claude",
      "codex",
    ]);
    expect(accountLoginEntries(row, ["codex"]).map(([p]) => p)).toEqual(["codex", "claude"]);
    expect(accountLoginEntries(row).map(([p]) => p)).toEqual(["codex", "claude"]);
  });
});

describe("accountPrimaryIdentity", () => {
  it("uses the first login email in provider order", () => {
    const row = account({
      codex: login({ identity: { email: "codex@work.co" } }),
      claude: login({ identity: { email: "claude@work.co", plan: "team" } }),
    });
    expect(accountPrimaryIdentity(row, label, ["claude", "codex"])).toBe("claude@work.co");
  });

  it("skips a login without an email for one that has it", () => {
    const row = account({
      claude: login({ identity: { status: "API key" } }),
      codex: login({ identity: { email: "codex@work.co" } }),
    });
    expect(accountPrimaryIdentity(row, label, ["claude", "codex"])).toBe("codex@work.co");
  });

  it("falls back to an identity, then to the provider labels", () => {
    expect(
      accountPrimaryIdentity(account({ claude: login({ identity: { plan: "max" } }) }), label),
    ).toBe("max");
    expect(
      accountPrimaryIdentity(
        account({ claude: login({ probeState: "error" }), codex: login() }),
        label,
        ["claude", "codex"],
      ),
    ).toBe("Claude · Codex");
    expect(accountPrimaryIdentity(account({}), label)).toBe("No logins");
  });
});

describe("accountLoginSummary", () => {
  it("names each provider with its email or state", () => {
    const row = account({
      claude: login({ identity: { email: "me@work.co", plan: "team" } }),
      codex: login({ probeState: "error" }),
    });
    expect(accountLoginSummary(row, label, ["claude", "codex"])).toBe(
      "Claude me@work.co · Codex Not signed in",
    );
    expect(accountLoginSummary(account({}), label)).toBe("No logins");
  });
});

describe("hasUnsettledProbe", () => {
  it("is true only while some login's probe is pending or unknown", () => {
    expect(hasUnsettledProbe(undefined)).toBe(false);
    expect(hasUnsettledProbe([account({ claude: login() })])).toBe(false);
    expect(
      hasUnsettledProbe([
        account({ claude: login() }),
        account({ claude: login(), codex: login({ probeState: "probing" }) }),
      ]),
    ).toBe(true);
    expect(hasUnsettledProbe([account({ claude: login({ probeState: "unknown" }) })])).toBe(true);
  });
});

describe("accountLoginLine", () => {
  const login = (email?: string, probeState: "ok" | "error" = "ok") => ({
    configDir: "/x",
    probeState,
    identity: email ? { email } : undefined,
  });

  it("collapses to one identity when every login is the same person", () => {
    const line = accountLoginLine({ logins: { codex: login("a@b.co"), claude: login("a@b.co") } }, [
      "claude",
      "codex",
    ]);
    expect(line.providers).toEqual(["claude", "codex"]);
    expect(line.shared).toBe("a@b.co");
    expect(line.perLogin).toEqual([]);
  });

  it("lists each login when the identities differ", () => {
    const line = accountLoginLine(
      { logins: { claude: login("work@corp.example"), codex: login(undefined, "error") } },
      ["claude", "codex"],
    );
    expect(line.shared).toBeNull();
    expect(line.perLogin).toEqual([
      { provider: "claude", who: "work@corp.example" },
      { provider: "codex", who: "Not signed in" },
    ]);
  });

  it("says so when an account has no logins", () => {
    expect(accountLoginLine({ logins: {} })).toEqual({
      providers: [],
      shared: "No logins",
      perLogin: [],
    });
  });
});
