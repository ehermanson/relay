/**
 * The persisted account list — the one reader/writer of
 * `global_settings.accounts_json`, shared by the account routes and
 * `InstanceManager` so creation, discovery and Settings can never disagree
 * about which accounts exist or which login an account has for a provider.
 *
 * Pure rules live in `accounts.ts`; this adds storage, the implicit default
 * account (whose logins are the server's own dirs for every installed
 * provider), the one-time read of the legacy per-provider profile list, and
 * change notification.
 */

import { randomUUID } from "node:crypto";
import {
  accountLoginRoots,
  accountsFromLegacyProfiles,
  findAccountForLogin,
  listAccounts,
  resolveAccountLogin,
  validateAccountLabel,
  validateAccountLogins,
  type DefaultLogins,
  type LegacyProviderProfile,
  type ResolvedAccountLogin,
} from "#core/accounts.js";
import type { SessionDB } from "#core/db.js";
import {
  DEFAULT_ACCOUNT_ID,
  type Account,
  type AccountLogin,
  type ProviderKind,
} from "#core/types.js";

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface AccountMutationOptions {
  /** Providers whose capabilities advertise `supportsAccountLogins`. */
  loginProviders: readonly ProviderKind[];
}

export class AccountStore {
  private db: SessionDB;
  private getDefaultLogins: () => DefaultLogins;
  private listeners = new Set<() => void>();

  constructor(db: SessionDB, getDefaultLogins: () => DefaultLogins) {
    this.db = db;
    this.getDefaultLogins = getDefaultLogins;
  }

  /** Stored entries: `accounts_json`, or the legacy profile list when it was never written. */
  private readStored(): Account[] {
    const row = this.db.getGlobalSettings();
    const stored = parseJson<Account[]>(row.accounts_json);
    if (Array.isArray(stored)) return stored;
    return accountsFromLegacyProfiles(
      parseJson<LegacyProviderProfile[]>(row.provider_profiles_json),
    );
  }

  private writeStored(accounts: Account[]): void {
    // Always a list — `null` means "never migrated" and would resurrect the
    // legacy profile entries after the last account is removed.
    this.db.updateGlobalSettings({ accounts_json: JSON.stringify(accounts) });
    for (const listener of this.listeners) listener();
  }

  /** Every account, default first. */
  list(): Account[] {
    return listAccounts(this.readStored(), this.getDefaultLogins());
  }

  get(id: string | null | undefined): Account | undefined {
    return this.list().find((account) => account.id === id);
  }

  /** The login a chat of `provider` uses in `accountId` (absent/unknown id = default). */
  resolveLogin(accountId: string | null | undefined, provider: ProviderKind): ResolvedAccountLogin {
    return resolveAccountLogin(this.list(), accountId, provider);
  }

  /** The account owning a login; an absent dir is the default account. */
  findForLogin(provider: ProviderKind, configDir: string | null | undefined): Account | undefined {
    return findAccountForLogin(this.list(), provider, configDir);
  }

  /** Every distinct dir a provider's chats may live under — the default account's first. */
  roots(provider: ProviderKind): string[] {
    return accountLoginRoots(this.list(), provider);
  }

  create(input: { label: unknown; logins: unknown }, options: AccountMutationOptions): Account {
    const accounts = this.list();
    const label = validateAccountLabel(input.label, accounts);
    const logins = validateAccountLogins(input.logins, accounts, options);
    const account: Account = { id: randomUUID(), label, logins };
    this.writeStored([...this.readStored(), account]);
    return account;
  }

  /** Rename and/or replace logins. The default account can only be renamed. */
  update(
    id: string,
    patch: { label?: unknown; logins?: unknown },
    options: AccountMutationOptions,
  ): Account {
    const accounts = this.list();
    const current = accounts.find((account) => account.id === id);
    if (!current) throw new Error("Account not found");
    const label =
      patch.label !== undefined
        ? validateAccountLabel(patch.label, accounts, { excludeId: id })
        : current.label;
    const stored = this.readStored().filter((account) => account.id !== id);
    if (id === DEFAULT_ACCOUNT_ID) {
      if (patch.logins !== undefined)
        throw new Error("The default account's logins are the server's own and cannot be edited");
      this.writeStored([{ id, label, logins: {} }, ...stored]);
      return { ...current, label };
    }
    const logins: Partial<Record<ProviderKind, AccountLogin>> =
      patch.logins !== undefined
        ? validateAccountLogins(patch.logins, accounts, { ...options, excludeId: id })
        : current.logins;
    const next: Account = { id, label, logins };
    // Preserve stored order: replace in place.
    const order = this.readStored().map((account) => (account.id === id ? next : account));
    this.writeStored(order.some((account) => account.id === id) ? order : [...stored, next]);
    return next;
  }

  /** Remove a non-default account. Returns false when it does not exist. */
  remove(id: string): boolean {
    if (id === DEFAULT_ACCOUNT_ID) throw new Error("The default account cannot be removed");
    const stored = this.readStored();
    if (!stored.some((account) => account.id === id)) return false;
    this.writeStored(stored.filter((account) => account.id !== id));
    return true;
  }

  /** Subscribe to account list changes (adds, renames, login edits, removals). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
