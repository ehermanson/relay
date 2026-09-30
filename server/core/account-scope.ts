/**
 * Account scoping for request paths — the one place an `accountId` query/body
 * param becomes a provider config dir.
 *
 * Every account-scoped route (`/api/provider-models`, MCP lists, artifacts,
 * skills, …) accepts `accountId` and resolves it here. The contract is
 * deliberately lenient: an absent id, the implicit `default` id, an id that
 * no longer exists, or an account with no login for the provider all resolve
 * to `undefined` — the caller then takes exactly the single-account path, so
 * an unknown id can never 404 a picker or a settings page. (Whether a provider
 * is *offered* in an account is `GET /api/providers?accountId=`'s job.)
 */

import type { AccountStore } from "#core/account-store.js";
import { DEFAULT_ACCOUNT_ID, type ProviderKind } from "#core/types.js";

/** What the resolver needs from `InstanceManager` (kept narrow for tests). */
export interface AccountScopeSource {
  accounts: Pick<AccountStore, "resolveLogin">;
}

type ScopeLogger = { debug(message: string): void };

/**
 * The config dir `accountId`'s login for `provider` names, or `undefined` for
 * the default account, an unknown id (logged at debug, never an error), or an
 * account with no login for the provider.
 */
export function resolveAccountConfigDir(
  source: AccountScopeSource,
  provider: ProviderKind,
  accountId: string | null | undefined,
  logger?: ScopeLogger,
): string | undefined {
  const id = typeof accountId === "string" ? accountId.trim() : "";
  if (!id || id === DEFAULT_ACCOUNT_ID) return undefined;
  const resolved = source.accounts.resolveLogin(id, provider);
  if (resolved.account.id !== id) {
    logger?.debug(`[AccountScope] Unknown account "${id}"; using the default account`);
    return undefined;
  }
  return resolved.available ? resolved.configDir : undefined;
}

/**
 * Roots a provider-specific read (plans, memory, user skills) should cover
 * for a request: `undefined` when no account was asked for (the caller's
 * aggregate/legacy behaviour), the account's own login root when it has one
 * — the default account's server dir included — and `[]` when the account has
 * no login for the provider, so another account's files never leak in.
 */
export function resolveAccountLoginRoots(
  source: AccountScopeSource,
  provider: ProviderKind,
  accountId: string | null | undefined,
  logger?: ScopeLogger,
): string[] | undefined {
  const id = typeof accountId === "string" ? accountId.trim() : "";
  if (!id) return undefined;
  const resolved = source.accounts.resolveLogin(id, provider);
  if (resolved.account.id !== id && id !== DEFAULT_ACCOUNT_ID) {
    logger?.debug(`[AccountScope] Unknown account "${id}"; reading as the default account`);
  }
  const login = resolved.account.logins[provider];
  return login ? [login.configDir] : [];
}
