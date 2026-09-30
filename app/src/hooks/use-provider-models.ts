import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  ProviderCapabilities,
  ProviderKind,
  ProviderModelOption,
  ProviderModelsResponse,
} from "@shared/types";
import { getDefaultProviderCapabilities } from "@shared/provider-catalog";
import { fetchProviderModels } from "@/lib/api";
import { useActiveAccount } from "@/hooks/use-active-account";

// Discovered models change rarely; cache for a minute so opening the picker for
// several providers doesn't refire discovery on every render/mount.
const PROVIDER_MODELS_STALE_TIME = 60_000;
const PROVIDER_MODELS_BOOTSTRAP_REFETCH_INTERVAL = 5_000;

export function providerModelsRefetchInterval(data: ProviderModelsResponse | undefined) {
  return data?.capabilities.versionAdvisory ? false : PROVIDER_MODELS_BOOTSTRAP_REFETCH_INTERVAL;
}

/**
 * Model discovery is per login (config dir), so the key carries the active
 * account's id — undefined below two accounts and for the default account.
 */
export function providerModelsQueryKey(provider: ProviderKind | undefined, accountId?: string) {
  return ["providerModels", provider, accountId ?? null] as const;
}

export function useProviderModels(provider?: ProviderKind) {
  const [showModelMenu, setShowModelMenu] = useState(false);
  const { accountIdParam: accountId } = useActiveAccount();

  const { data } = useQuery({
    // queryFn only runs when `enabled` is true, so the non-null assertion is safe.
    queryKey: providerModelsQueryKey(provider, accountId),
    queryFn: () => fetchProviderModels(provider!, accountId),
    enabled: !!provider,
    staleTime: PROVIDER_MODELS_STALE_TIME,
    refetchInterval: (query) => providerModelsRefetchInterval(query.state.data),
  });

  const availableProviderModels: ProviderModelOption[] =
    data?.models.filter((model) => !model.hidden) ?? [];
  const capabilities: ProviderCapabilities =
    data?.capabilities ?? getDefaultProviderCapabilities(provider ?? "claude");
  const defaultModel = data?.defaultModel;

  return {
    showModelMenu,
    setShowModelMenu,
    availableProviderModels,
    capabilities,
    defaultModel,
  };
}

export interface ProviderModelsEntry {
  models: ProviderModelOption[];
  /** Backend-resolved default for this provider (may differ from any model's
   *  `isDefault` flag), used to render default labels/badges. */
  defaultModel?: ProviderModelOption;
}

/**
 * Fetch discovered (non-hidden) models for several providers at once, keyed by
 * provider. Shares React Query's cache with `useProviderModels` (same query
 * key), so the currently-active provider's fetch is deduplicated. Providers
 * whose discovery hasn't resolved yet are simply absent from the map — callers
 * should fall back to the builtin catalog for those.
 *
 * Pass `enabled: false` to keep the queries idle (e.g. until the model picker
 * is opened) — discovery can spawn provider processes, so it should not run on
 * every chat render.
 */
export function useProviderModelsMap(
  providers: ProviderKind[],
  options: { enabled?: boolean } = {},
): Partial<Record<ProviderKind, ProviderModelsEntry>> {
  const enabled = options.enabled ?? true;
  const { accountIdParam: accountId } = useActiveAccount();
  const results = useQueries({
    queries: providers.map((provider) => ({
      queryKey: providerModelsQueryKey(provider, accountId),
      queryFn: () => fetchProviderModels(provider, accountId),
      staleTime: PROVIDER_MODELS_STALE_TIME,
      enabled,
    })),
  });

  const map: Partial<Record<ProviderKind, ProviderModelsEntry>> = {};
  providers.forEach((provider, index) => {
    const data = results[index]?.data;
    if (data) {
      map[provider] = {
        models: data.models.filter((model) => !model.hidden),
        defaultModel: data.defaultModel,
      };
    }
  });
  return map;
}
