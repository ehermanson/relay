import { useQuery } from "@tanstack/react-query";
import type { AccountStatus } from "@shared/types";
import { fetchAccounts } from "@/lib/api";
import { hasUnsettledProbe } from "@/lib/account-identity";

export const ACCOUNTS_QUERY_KEY = ["accounts"] as const;

/** While a login probe is unsettled, poll every 3s; otherwise leave the list alone. */
export function accountsRefetchInterval(data: AccountStatus[] | undefined): number | false {
  return hasUnsettledProbe(data) ? 3_000 : false;
}

/**
 * Every Relay account (default first) with each login's probed identity. One
 * query shared by Settings, Project Settings and the switcher
 * (`useActiveAccount`), so a rename or probe result reaches every surface.
 */
export function useAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => fetchAccounts(),
    staleTime: 60_000,
    refetchInterval: (query) => accountsRefetchInterval(query.state.data),
  });
}
