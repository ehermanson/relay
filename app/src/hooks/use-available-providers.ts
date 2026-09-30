import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { ProviderDescriptor } from "@shared/types";
import { fetchProviders } from "@/lib/api";
import { useActiveAccount } from "@/hooks/use-active-account";

// Server probes provider CLI versions every 30 min in the background; mirror
// that steady-state cadence on the client so a stale `versionAdvisory`
// eventually refreshes without a manual reload, while keeping request volume
// tiny.
const STEADY_REFETCH_INTERVAL_MS = 30 * 60 * 1_000;

// Bootstrap cadence: the first `GET /api/providers` typically returns before
// the server's async probe has populated any `versionAdvisory`, so the launch
// toast and settings card can't render yet. Poll quickly until at least one
// provider carries an advisory (success or "unknown" — either way the probe
// has resolved), then drop to the steady-state interval.
const BOOTSTRAP_REFETCH_INTERVAL_MS = 5_000;

function anyAdvisoryPopulated(providers: ReadonlyArray<ProviderDescriptor>): boolean {
  return providers.some((p) => p.capabilities.versionAdvisory != null);
}

/**
 * `["providers"]` is every installed provider (the default account's view and
 * the single-account key); `["providers", accountId]` is the subset a
 * non-default account has a login for.
 */
export function providersQueryKey(accountId?: string) {
  return accountId ? (["providers", accountId] as const) : (["providers"] as const);
}

/**
 * Store a provider list the server returned for *every* provider (update /
 * recheck responses) and refresh any account-scoped subsets derived from it.
 */
export function setAllProvidersData(queryClient: QueryClient, providers: ProviderDescriptor[]) {
  queryClient.setQueryData(providersQueryKey(), providers);
  void queryClient.invalidateQueries({
    queryKey: ["providers"],
    predicate: (query) => query.queryKey.length > 1,
  });
}

function useProvidersQuery(accountId: string | undefined) {
  const { data: providers = [], isLoading } = useQuery<ProviderDescriptor[]>({
    queryKey: providersQueryKey(accountId),
    queryFn: () => fetchProviders(accountId),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const data = query.state.data ?? [];
      if (data.length === 0) return BOOTSTRAP_REFETCH_INTERVAL_MS;
      return anyAdvisoryPopulated(data)
        ? STEADY_REFETCH_INTERVAL_MS
        : BOOTSTRAP_REFETCH_INTERVAL_MS;
    },
  });

  return { providers, isLoading };
}

/**
 * Providers usable in the active account — only those it has a login for, so
 * pickers, defaults and provider rows never offer a provider the account can't
 * run. Below two accounts (and for the default account) this is the plain
 * `GET /api/providers`.
 */
export function useAvailableProviders() {
  const { accountIdParam } = useActiveAccount();
  return useProvidersQuery(accountIdParam);
}

/** Every installed provider regardless of the active account (Settings → Accounts). */
export function useInstalledProviders() {
  return useProvidersQuery(undefined);
}
