import { useQuery } from "@tanstack/react-query";
import { fetchGlobalSettings } from "@/lib/api";
import type { GlobalSettings, SidebarLayout } from "@shared/types";

export const DEFAULT_SETTINGS: GlobalSettings = {
  theme: "dark",
  defaultOpenTarget: null,
  defaultProvider: null,
  defaultModel: null,
  defaultSpaceBranch: null,
  spaceBranchSource: "local",
  providerDefaults: {},
  customInstructions: null,
  projectOrder: null,
  suggestions: null,
  maxProcesses: null,
  sidebarLayout: "inbox",
  providerProfiles: [],
};

export function useGlobalSettings() {
  return useQuery({
    queryKey: ["global-settings"],
    queryFn: fetchGlobalSettings,
    staleTime: 60_000,
    placeholderData: DEFAULT_SETTINGS,
  });
}

/**
 * Which sidebar to render. The `global-settings` query is persisted to
 * localStorage, so this resolves to the user's real choice on first paint
 * instead of flashing the default layout.
 */
export function useSidebarLayout(): SidebarLayout {
  const { data } = useGlobalSettings();
  // Inbox is the default; only an explicit "projects" choice opts out.
  return data?.sidebarLayout === "projects" ? "projects" : "inbox";
}
