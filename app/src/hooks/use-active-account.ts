/**
 * The per-browser active account — the highest layer of the UI.
 *
 * Accounts (`AccountStatus`) are named contexts owning one login per provider.
 * The choice persists in localStorage (`relay:active-account`) and falls back
 * to the default account when the stored id no longer exists.
 *
 * Hard rule: with fewer than two accounts (including a failed or still-loading
 * accounts query) `isMulti` is false, `accountIdParam` is undefined,
 * `loginDirFor()` returns undefined, and no surface or filter that consumes
 * this hook changes anything.
 */

import { useCallback, useMemo } from "react";
import { create } from "zustand";
import { DEFAULT_ACCOUNT_ID, type AccountStatus, type ProviderKind } from "@shared/types";
import { useAccounts } from "@/hooks/use-accounts";
import {
  ACTIVE_ACCOUNT_STORAGE_KEY,
  isMultiAccount,
  loginDirForAccount,
  readStoredActiveAccountId,
  resolveActiveAccountId,
  writeStoredActiveAccountId,
} from "@/lib/account-scope";

interface ActiveAccountStore {
  storedId: string | null;
  setStoredId: (id: string) => void;
}

export const useActiveAccountStore = create<ActiveAccountStore>()((set) => ({
  storedId: readStoredActiveAccountId(),
  setStoredId: (id) => {
    writeStoredActiveAccountId(id);
    set({ storedId: id });
  },
}));

// Another tab switching accounts should not leave this one scoped differently.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === ACTIVE_ACCOUNT_STORAGE_KEY) {
      useActiveAccountStore.setState({ storedId: event.newValue });
    }
  });
}

const EMPTY_ACCOUNTS: AccountStatus[] = [];

export interface ActiveAccount {
  /** Every registered account (default first); empty until loaded. */
  accounts: AccountStatus[];
  /** The active account's record, if the list has loaded. */
  active: AccountStatus | undefined;
  /** Resolved active id — `default` whenever the stored choice doesn't exist. */
  activeId: string;
  setActiveId: (id: string) => void;
  /** Two or more accounts: the switcher renders and views are scoped. */
  isMulti: boolean;
  /**
   * The config dir provider runtime state is keyed by for the active
   * account's login of `provider`. Undefined below two accounts, for the
   * default account, and for a provider the account has no login for.
   */
  loginDirFor: (provider: ProviderKind | undefined) => string | undefined;
  /**
   * `accountId` to send on account-scoped requests. Undefined below two
   * accounts and for the default account, so the single-account wire never
   * changes.
   */
  accountIdParam: string | undefined;
}

export function useActiveAccount(): ActiveAccount {
  const { data } = useAccounts();
  const accounts = data ?? EMPTY_ACCOUNTS;
  const storedId = useActiveAccountStore((s) => s.storedId);
  const setActiveId = useActiveAccountStore((s) => s.setStoredId);

  const isMulti = isMultiAccount(accounts);
  const activeId = resolveActiveAccountId(storedId, accounts);
  const active = accounts.find((account) => account.id === activeId);
  const accountIdParam = isMulti && activeId !== DEFAULT_ACCOUNT_ID ? activeId : undefined;

  const loginDirFor = useCallback(
    (provider: ProviderKind | undefined) =>
      isMulti ? loginDirForAccount(active, provider) : undefined,
    [isMulti, active],
  );

  return useMemo(
    () => ({ accounts, active, activeId, setActiveId, isMulti, loginDirFor, accountIdParam }),
    [accounts, active, activeId, setActiveId, isMulti, loginDirFor, accountIdParam],
  );
}
