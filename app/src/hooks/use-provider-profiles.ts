import { useQuery } from "@tanstack/react-query";
import type { ProviderAccountProfileStatus, ProviderKind } from "@shared/types";
import { fetchProviderProfiles } from "@/lib/api";
import { hasUnsettledProbe } from "@/lib/account-profiles";

export const PROVIDER_PROFILES_QUERY_KEY = "provider-profiles";

export function providerProfilesQueryKey(provider: ProviderKind | undefined) {
  return [PROVIDER_PROFILES_QUERY_KEY, provider] as const;
}

/** While a probe is unsettled, poll every 3s; otherwise leave the list alone. */
export function providerProfilesRefetchInterval(
  data: ProviderAccountProfileStatus[] | undefined,
): number | false {
  return hasUnsettledProbe(data) ? 3_000 : false;
}

interface UseProviderProfilesOptions {
  /** Gate on `ProviderCapabilities.supportsAccountProfiles` at the call site. */
  enabled?: boolean;
  /** Settings polls while probes settle; passive readers (chat header) don't. */
  poll?: boolean;
  staleTime?: number;
}

/**
 * The provider's account profiles (default first) with their probed identity.
 * One query key per provider, shared by Settings, Project Settings, and the
 * chat header so a rename or probe result reaches every surface.
 */
export function useProviderProfiles(
  provider: ProviderKind | undefined,
  { enabled = true, poll = false, staleTime = 60_000 }: UseProviderProfilesOptions = {},
) {
  return useQuery({
    queryKey: providerProfilesQueryKey(provider),
    // queryFn only runs when `enabled` is true, so the non-null assertion is safe.
    queryFn: () => fetchProviderProfiles(provider!),
    enabled: enabled && !!provider,
    staleTime,
    refetchInterval: poll ? (query) => providerProfilesRefetchInterval(query.state.data) : false,
  });
}
