/**
 * Pure presentation helpers for accounts and their provider logins. The rules
 * for what the *active* account scopes live in `@/lib/account-scope`; this
 * module only decides what to *say* about a login.
 */

import type {
  AccountLoginStatus,
  AccountStatus,
  ProviderAccountStatus,
  ProviderKind,
} from "@shared/types";

/**
 * `email · org · plan`, using whichever identity fields the probe reported.
 * `label` is the provider's org/workspace name; a plan repeats nothing else.
 */
export function formatIdentity(identity: ProviderAccountStatus | undefined): string | null {
  if (!identity) return null;
  const parts: string[] = [];
  for (const value of [identity.email, identity.label, identity.plan]) {
    const trimmed = value?.trim();
    if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
  }
  // No name at all: say how it authenticates ("Enterprise gateway", "Signed in").
  if (!parts.length && identity.status?.trim()) parts.push(identity.status.trim());
  return parts.length ? parts.join(" · ") : null;
}

/**
 * One line describing what we know about a login: the identity when probed,
 * otherwise the probe state in words. Never empty — every row needs a visible
 * answer without hovering.
 */
export function formatLoginIdentity(
  login: Pick<AccountLoginStatus, "probeState" | "identity" | "probeError">,
): string {
  const identity = formatIdentity(login.identity);
  switch (login.probeState) {
    case "ok":
      return identity ?? "Signed in";
    case "error":
      return login.probeError?.trim() || "Not signed in";
    default:
      return identity ?? "Checking…";
  }
}

/** An account's logins in a stable order: `providerOrder` first, then the rest. */
export function accountLoginEntries(
  account: Pick<AccountStatus, "logins">,
  providerOrder: ReadonlyArray<ProviderKind> = [],
): Array<[ProviderKind, AccountLoginStatus]> {
  const entries = Object.entries(account.logins) as Array<[ProviderKind, AccountLoginStatus]>;
  const rank = (provider: ProviderKind) => {
    const index = providerOrder.indexOf(provider);
    return index === -1 ? providerOrder.length : index;
  };
  return entries
    .filter(([, login]) => !!login)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry[0]) - rank(b.entry[0]) || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * The one-line identity for narrow surfaces (the switcher pill): the first
 * login email, then the first login's identity line, then the providers the
 * account covers. Never empty.
 */
export function accountPrimaryIdentity(
  account: Pick<AccountStatus, "logins">,
  providerLabel: (provider: ProviderKind) => string,
  providerOrder: ReadonlyArray<ProviderKind> = [],
): string {
  const entries = accountLoginEntries(account, providerOrder);
  for (const [, login] of entries) {
    const email = login.identity?.email?.trim();
    if (email) return email;
  }
  for (const [, login] of entries) {
    const identity = formatIdentity(login.identity);
    if (identity) return identity;
  }
  if (entries.length === 0) return "No logins";
  return entries.map(([provider]) => providerLabel(provider)).join(" · ");
}

/**
 * Compact per-provider summary for menu rows: `Claude a@b.co · Codex c@d.co`.
 * Each login contributes its email (or, failing that, its state in words).
 */
export function accountLoginSummary(
  account: Pick<AccountStatus, "logins">,
  providerLabel: (provider: ProviderKind) => string,
  providerOrder: ReadonlyArray<ProviderKind> = [],
): string {
  const entries = accountLoginEntries(account, providerOrder);
  if (entries.length === 0) return "No logins";
  return entries
    .map(([provider, login]) => {
      const who = login.identity?.email?.trim() || formatLoginIdentity(login);
      return `${providerLabel(provider)} ${who}`;
    })
    .join(" · ");
}

/**
 * What a menu row shows under the account name. One identity when every login
 * agrees on an email (the common case — the same person on each provider), so
 * the row reads "logos · email"; otherwise one `provider → who` pair per login.
 */
export interface AccountLoginLine {
  /** Providers the account has logins for, in `providerOrder`. */
  providers: ProviderKind[];
  /** The single line to show when the logins share one identity. */
  shared: string | null;
  /** Per-login identities when they differ (empty when `shared` is set). */
  perLogin: Array<{ provider: ProviderKind; who: string }>;
}

export function accountLoginLine(
  account: Pick<AccountStatus, "logins">,
  providerOrder: ReadonlyArray<ProviderKind> = [],
): AccountLoginLine {
  const entries = accountLoginEntries(account, providerOrder);
  const providers = entries.map(([provider]) => provider);
  if (entries.length === 0) return { providers, shared: "No logins", perLogin: [] };
  const who = entries.map(([provider, login]) => ({
    provider,
    who: login.identity?.email?.trim() || formatLoginIdentity(login),
  }));
  const distinct = new Set(who.map((entry) => entry.who));
  if (distinct.size === 1) return { providers, shared: who[0].who, perLogin: [] };
  return { providers, shared: null, perLogin: who };
}

/** Polling is only worth it while some login's probe hasn't settled. */
export function hasUnsettledProbe(accounts: ReadonlyArray<AccountStatus> | undefined): boolean {
  return (accounts ?? []).some((account) =>
    Object.values(account.logins).some(
      (login) => login?.probeState === "probing" || login?.probeState === "unknown",
    ),
  );
}
