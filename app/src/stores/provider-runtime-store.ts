import { create } from "zustand";
import type { ProviderGlobalState, ProviderKind } from "@shared/types";
import { stateKeyFor } from "@/lib/account-scope";

/**
 * Provider global state (account identity, rate limits, MCP servers) is per
 * login, so it is keyed by `stateKeyFor(provider, configDir)` — the default
 * account's dir is empty. WS `provider_global_state` states carry `configDir`
 * only for non-default accounts.
 */
type ProviderRuntimeStateMap = Record<string, ProviderGlobalState>;

interface ProviderRuntimeStore {
  providerGlobalState: ProviderRuntimeStateMap;
  setProviderGlobalStateList: (states: ProviderGlobalState[]) => void;
  updateProviderGlobalState: (provider: ProviderKind, state: ProviderGlobalState) => void;
}

export const useProviderRuntimeStore = create<ProviderRuntimeStore>()((set) => ({
  providerGlobalState: {},

  setProviderGlobalStateList: (states) =>
    set({
      providerGlobalState: Object.fromEntries(
        states.map((state) => [stateKeyFor(state.provider, state.configDir), state]),
      ),
    }),

  updateProviderGlobalState: (provider, state) =>
    set((current) => ({
      providerGlobalState: {
        ...current.providerGlobalState,
        [stateKeyFor(provider, state.configDir)]: state,
      },
    })),
}));

/** The runtime state for one provider login (absent `configDir` = the default account). */
export function useProviderGlobalState(
  provider: ProviderKind | undefined,
  configDir?: string | null,
): ProviderGlobalState | undefined {
  return useProviderRuntimeStore((s) =>
    provider ? s.providerGlobalState[stateKeyFor(provider, configDir)] : undefined,
  );
}
