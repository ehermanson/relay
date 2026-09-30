/**
 * Relay accounts — pure helpers shared by the server (creation, discovery,
 * routes) and the UI via `@shared/accounts`. No fs access: checks that need
 * the filesystem (a config dir exists) live at the route.
 *
 * An account is a named context ("Work", "Personal") owning one login per
 * provider it uses. The default account is implicit — its logins are the
 * server's own resolved dirs for every installed provider — and only its label
 * is ever stored. A provider with no login in an account is unavailable there;
 * nothing falls back to another account's login.
 */

import {
  DEFAULT_ACCOUNT_ID,
  type Account,
  type AccountLogin,
  type ProviderKind,
} from "#core/types.js";

export const DEFAULT_ACCOUNT_LABEL = "Default";
export const ACCOUNT_LABEL_MAX = 40;

/** The server's own resolved dir per installed provider — the default account's logins. */
export type DefaultLogins = Partial<Record<ProviderKind, string>>;

/** Normalize a config dir for comparison: trimmed, trailing slashes off. No `~` expansion. */
export function normalizeConfigDir(dir: string): string {
  const trimmed = dir.trim().replace(/\/+$/, "");
  return trimmed || "/";
}

function normalizeLogins(
  logins: Partial<Record<ProviderKind, AccountLogin>> | null | undefined,
): Partial<Record<ProviderKind, AccountLogin>> {
  const out: Partial<Record<ProviderKind, AccountLogin>> = {};
  for (const [provider, login] of Object.entries(logins ?? {})) {
    const dir = typeof login?.configDir === "string" ? login.configDir.trim() : "";
    if (dir) out[provider as ProviderKind] = { configDir: normalizeConfigDir(dir) };
  }
  return out;
}

/** The implicit default account: the server's own dir for every installed provider. */
export function defaultAccount(defaultLogins: DefaultLogins, label?: string | null): Account {
  const logins: Partial<Record<ProviderKind, AccountLogin>> = {};
  for (const [provider, dir] of Object.entries(defaultLogins)) {
    if (dir) logins[provider as ProviderKind] = { configDir: normalizeConfigDir(dir) };
  }
  return { id: DEFAULT_ACCOUNT_ID, label: label?.trim() || DEFAULT_ACCOUNT_LABEL, logins };
}

/**
 * Default first, then the stored accounts in stored order. A stored
 * `{ id: "default" }` entry only renames the default account — its logins
 * always come from `defaultLogins`. Accounts left with no login are dropped.
 */
export function listAccounts(
  stored: Account[] | null | undefined,
  defaultLogins: DefaultLogins,
): Account[] {
  const entries = Array.isArray(stored) ? stored : [];
  const rename = entries.find((a) => a?.id === DEFAULT_ACCOUNT_ID)?.label;
  const accounts: Account[] = [defaultAccount(defaultLogins, rename)];
  const seen = new Set<string>([DEFAULT_ACCOUNT_ID]);
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    const logins = normalizeLogins(entry.logins);
    if (Object.keys(logins).length === 0) continue;
    seen.add(entry.id);
    accounts.push({ id: entry.id, label: entry.label?.trim() || entry.id, logins });
  }
  return accounts;
}

/** Row shape of the superseded `provider_profiles_json` list (one login per profile). */
export interface LegacyProviderProfile {
  id: string;
  provider: ProviderKind;
  label: string;
  configDir: string;
}

/** Legacy `provider_profiles_json` → accounts: one account per profile, holding that one login. */
export function accountsFromLegacyProfiles(
  profiles: LegacyProviderProfile[] | null | undefined,
): Account[] {
  return (profiles ?? [])
    .filter((p) => p && p.id !== DEFAULT_ACCOUNT_ID && typeof p.configDir === "string")
    .map((p) => ({
      id: p.id,
      label: p.label,
      logins: { [p.provider]: { configDir: normalizeConfigDir(p.configDir) } },
    }));
}

/** Providers an account can run — those it has a login for. */
export function accountProviders(account: Account): ProviderKind[] {
  return Object.keys(account.logins) as ProviderKind[];
}

export type ResolvedAccountLogin =
  | {
      available: true;
      account: Account;
      /**
       * Dir to bind the chat to; `undefined` for the default account so
       * `InstanceInfo.configDir` stays absent (the server's own dir).
       */
      configDir: string | undefined;
    }
  | { available: false; account: Account };

/**
 * The login a chat of `provider` uses in `accountId`. An absent or unknown id
 * is the default account. No login for the provider in that account means
 * **unavailable** — never another account's login.
 */
export function resolveAccountLogin(
  accounts: Account[],
  accountId: string | null | undefined,
  provider: ProviderKind,
): ResolvedAccountLogin {
  const account =
    accounts.find((a) => a.id === accountId) ??
    accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID) ??
    accounts[0];
  const login = account.logins[provider];
  if (!login) return { available: false, account };
  return {
    available: true,
    account,
    configDir: account.id === DEFAULT_ACCOUNT_ID ? undefined : login.configDir,
  };
}

/**
 * The account a login belongs to: an absent dir (or the default account's own
 * dir) is the default account; an unregistered dir matches nothing.
 */
export function findAccountForLogin(
  accounts: Account[],
  provider: ProviderKind,
  configDir: string | null | undefined,
): Account | undefined {
  if (!configDir) return accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID);
  const target = normalizeConfigDir(configDir);
  return accounts.find((a) => {
    const login = a.logins[provider];
    return !!login && normalizeConfigDir(login.configDir) === target;
  });
}

/** Every distinct dir a provider's chats may live under — the default account's first. */
export function accountLoginRoots(accounts: Account[], provider: ProviderKind): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const account of accounts) {
    const dir = account.logins[provider]?.configDir;
    if (!dir) continue;
    const normalized = normalizeConfigDir(dir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

/**
 * The login root (config dir) a transcript lives under, derived from its path:
 * Claude `<root>/projects/<encoded cwd>/<id>.jsonl`, Codex
 * `<root>/sessions/YYYY/MM/DD/rollout-*.jsonl`. The last marker occurrence is
 * the boundary, so a root that itself sits under a `projects`/`sessions`
 * folder still resolves. Undefined for a path without the marker. Derived,
 * never stored: `sessions` rows keep only the JSONL path.
 */
export function loginRootForTranscriptPath(
  provider: string | null | undefined,
  jsonlPath: string | null | undefined,
): string | undefined {
  if (!jsonlPath) return undefined;
  const marker = provider === "claude" ? "/projects/" : provider === "codex" ? "/sessions/" : null;
  if (!marker) return undefined;
  const idx = jsonlPath.lastIndexOf(marker);
  if (idx <= 0) return undefined;
  return normalizeConfigDir(jsonlPath.slice(0, idx));
}

/** Trim/dedupe account ids; an empty list means the default account only. */
export function normalizeAccountIds(ids: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out.length ? out : [DEFAULT_ACCOUNT_ID];
}

/** Shape-level label check. Throws with a user-facing message. */
export function validateAccountLabel(
  label: unknown,
  existing: Account[],
  options: { excludeId?: string } = {},
): string {
  const value = typeof label === "string" ? label.trim() : "";
  if (!value) throw new Error("Enter a name for this account");
  if (value.length > ACCOUNT_LABEL_MAX)
    throw new Error(`Account names are at most ${ACCOUNT_LABEL_MAX} characters`);
  for (const account of existing) {
    if (account.id === options.excludeId) continue;
    if (account.label.toLowerCase() === value.toLowerCase())
      throw new Error(`An account named "${account.label}" already exists`);
  }
  return value;
}

/**
 * Shape-level check of an account's logins: at least one, only providers that
 * support account logins, absolute dirs, and no dir already used by another
 * account for the same provider (the default account's included). Filesystem
 * checks are the route's job. Throws with a user-facing message.
 */
export function validateAccountLogins(
  logins: unknown,
  existing: Account[],
  options: { excludeId?: string; loginProviders: readonly ProviderKind[] },
): Partial<Record<ProviderKind, AccountLogin>> {
  const out: Partial<Record<ProviderKind, AccountLogin>> = {};
  const entries = logins && typeof logins === "object" ? Object.entries(logins) : [];
  for (const [provider, login] of entries) {
    const rawDir =
      login && typeof login === "object" && typeof (login as AccountLogin).configDir === "string"
        ? (login as AccountLogin).configDir.trim()
        : "";
    if (!rawDir) continue;
    if (!options.loginProviders.includes(provider as ProviderKind))
      throw new Error(`${provider} does not support separate account logins`);
    const configDir = normalizeConfigDir(rawDir);
    if (!configDir.startsWith("/") && !configDir.startsWith("~"))
      throw new Error("Config directory must be an absolute path");
    for (const account of existing) {
      if (account.id === options.excludeId) continue;
      const other = account.logins[provider as ProviderKind];
      if (other && normalizeConfigDir(other.configDir) === configDir)
        throw new Error(`"${account.label}" already uses that ${provider} config directory`);
    }
    out[provider as ProviderKind] = { configDir };
  }
  if (Object.keys(out).length === 0) throw new Error("Add at least one provider login");
  return out;
}
