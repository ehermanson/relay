/**
 * Account scoping — pure rules for the top-level account switcher.
 *
 * An account (`Account`) is a named context ("Work", "Personal") owning one
 * login per provider it uses. A per-browser *active* account scopes everything
 * in view, like browser profiles. Every rule here is gated on `isMulti` (two or
 * more accounts registered): with a single account nothing filters, nothing
 * renders, and no request changes.
 */

import { normalizeConfigDir } from "@shared/accounts";
import {
  DEFAULT_ACCOUNT_ID,
  type AccountStatus,
  type InstanceInfo,
  type Project,
  type ProviderKind,
} from "@shared/types";

export const ACTIVE_ACCOUNT_STORAGE_KEY = "relay:active-account";

/** The switcher and every filter exist only from this many accounts up. */
export const MULTI_ACCOUNT_MIN = 2;

type AccountRef = Pick<AccountStatus, "id">;

export function isMultiAccount(accounts: ReadonlyArray<AccountRef>): boolean {
  return accounts.length >= MULTI_ACCOUNT_MIN;
}

/**
 * The account a stored id resolves to. An id that no longer exists (account
 * removed, or the list hasn't loaded) falls back to the default account rather
 * than leaving the UI scoped to nothing.
 */
export function resolveActiveAccountId(
  storedId: string | null | undefined,
  accounts: ReadonlyArray<AccountRef>,
): string {
  if (storedId && accounts.some((account) => account.id === storedId)) return storedId;
  return DEFAULT_ACCOUNT_ID;
}

/**
 * The config dir provider runtime state is keyed by for this account's login
 * of `provider`: absent for the default account (the server's own dir) and for
 * a provider the account has no login for.
 */
export function loginDirForAccount(
  account: Pick<AccountStatus, "id" | "logins"> | undefined,
  provider: ProviderKind | undefined,
): string | undefined {
  if (!account || !provider || account.id === DEFAULT_ACCOUNT_ID) return undefined;
  return account.logins[provider]?.configDir;
}

/**
 * Key for per-login provider runtime state (`useProviderRuntimeStore`):
 * `${provider}:${configDir}` with the default account's dir left empty, so the
 * single-account key is stable and a non-default dir compares normalized.
 */
export function stateKeyFor(provider: ProviderKind, configDir?: string | null): string {
  return `${provider}:${configDir ? normalizeConfigDir(configDir) : ""}`;
}

/**
 * Whether a chat shows under the active account: its `accountId` (absent =
 * the default account, terminal chats included) must be the active one.
 *
 * Callers apply this only with two or more accounts. When `accounts` is given,
 * a chat whose account no longer exists is filed under the default account —
 * otherwise removing an account would make its chats unreachable.
 */
export function chatBelongsToAccount(
  instance: Pick<InstanceInfo, "accountId">,
  activeId: string,
  accounts?: ReadonlyArray<AccountRef>,
): boolean {
  let owner = instance.accountId || DEFAULT_ACCOUNT_ID;
  if (accounts && !accounts.some((account) => account.id === owner)) owner = DEFAULT_ACCOUNT_ID;
  return owner === activeId;
}

/**
 * The account that owns a chat (`accountId`, absent = default; an id that no
 * longer exists files under default). Used by the mismatch guard, which only
 * fires with two or more accounts.
 */
export function chatOwnerAccount<A extends AccountRef>(
  instance: Pick<InstanceInfo, "accountId">,
  accounts: ReadonlyArray<A>,
): A | undefined {
  const ownerId = instance.accountId || DEFAULT_ACCOUNT_ID;
  return (
    accounts.find((account) => account.id === ownerId) ??
    accounts.find((account) => account.id === DEFAULT_ACCOUNT_ID)
  );
}

/**
 * The account a chat belongs to when that isn't the active one, else null —
 * the rule behind the "This chat belongs to <account>" guard for deep links
 * and tabs left open across a switch. Null below two accounts, so a
 * single-account install never sees the banner.
 */
export function chatAccountMismatch<A extends AccountRef>(
  instance: Pick<InstanceInfo, "accountId">,
  activeId: string,
  accounts: ReadonlyArray<A>,
): A | null {
  if (!isMultiAccount(accounts)) return null;
  if (chatBelongsToAccount(instance, activeId, accounts)) return null;
  return chatOwnerAccount(instance, accounts) ?? null;
}

/**
 * The account a project belongs to when the active one isn't among its
 * members, else null — the space-view analog of `chatAccountMismatch`. A
 * project with several owners names the first registered one (the switch
 * action needs a single target). Null below two accounts.
 */
export function projectAccountMismatch<A extends AccountRef>(
  project: Pick<Project, "accountIds">,
  activeId: string,
  accounts: ReadonlyArray<A>,
): A | null {
  if (!isMultiAccount(accounts)) return null;
  const ids = projectAccountIds(project);
  if (ids.includes(activeId)) return null;
  return (
    accounts.find((account) => ids.includes(account.id)) ??
    accounts.find((account) => account.id === DEFAULT_ACCOUNT_ID) ??
    null
  );
}

/**
 * Whether a pathname is inside a project (chat, space, project page). Switching
 * accounts leaves such routes for the app root, since what they show belongs
 * to the account just left; Settings and Home stay put.
 */
export function isProjectScopedPath(pathname: string): boolean {
  return /^\/projects(\/|$)/.test(pathname);
}

/** `Project.accountIds` normalized: an empty/missing list is the default account. */
export function projectAccountIds(project: Pick<Project, "accountIds">): string[] {
  const ids = project.accountIds;
  return Array.isArray(ids) && ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

/** Whether a project shows under the active account (membership is ignored below two accounts). */
export function projectBelongsToAccount(
  project: Pick<Project, "accountIds">,
  activeId: string,
  isMulti: boolean,
): boolean {
  if (!isMulti) return true;
  return projectAccountIds(project).includes(activeId);
}

/** Browser-safe read of the persisted choice (route loaders can't use hooks). */
export function readStoredActiveAccountId(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_ACCOUNT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredActiveAccountId(id: string): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, id);
  } catch {
    // Private mode / quota: the in-memory store still holds the choice.
  }
}

/**
 * Account label initial for avatar-style buttons (the collapsed rail has no
 * room for text). Falls back to "A" so the button never renders empty.
 */
export function accountInitial(label: string | undefined): string {
  const initial = label?.trim().charAt(0).toUpperCase();
  return initial || "A";
}
