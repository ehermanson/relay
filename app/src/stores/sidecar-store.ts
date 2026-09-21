/**
 * Zustand store for sidecar panel visibility.
 *
 * Header-tab model: each scope (chat / space) tracks the user's last-selected
 * tab plus an open/closed flag. Header buttons act as tab switches — clicking
 * one switches to that tab and opens the sidecar; clicking the active tab
 * closes the sidecar (preserving the selection so reopening goes back there).
 *
 * Preferences are GLOBAL: one tab/open state per scope, shared across chats
 * and spaces. Sidebar width is also global and shared between scopes.
 */

import { useCallback, useMemo } from "react";
import { create } from "zustand";

export type SidecarTab = "tasks" | "agents" | "files" | "plan" | "context" | "brief" | "review";
export type SidecarScope = "chat" | "space";

const VALID_TABS: ReadonlySet<SidecarTab> = new Set([
  "tasks",
  "agents",
  "files",
  "plan",
  "context",
  "brief",
  "review",
]);

// Priority for fallback when the selected tab has no content.
const FALLBACK_ORDER: readonly SidecarTab[] = [
  "tasks",
  "agents",
  "files",
  "plan",
  "context",
  "brief",
  "review",
];

// ── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "relay-sidecar-prefs";

interface PersistedState {
  chatTab: SidecarTab;
  chatOpen: boolean;
  spaceTab: SidecarTab;
  spaceOpen: boolean;
  sidebarWidth: number | null;
}

const DEFAULTS: PersistedState = {
  chatTab: "tasks",
  chatOpen: true,
  spaceTab: "brief",
  spaceOpen: true,
  sidebarWidth: null,
};

function isValidTab(value: unknown): value is SidecarTab {
  return typeof value === "string" && VALID_TABS.has(value as SidecarTab);
}

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      chatTab: isValidTab(parsed.chatTab) ? parsed.chatTab : DEFAULTS.chatTab,
      chatOpen: typeof parsed.chatOpen === "boolean" ? parsed.chatOpen : DEFAULTS.chatOpen,
      spaceTab: isValidTab(parsed.spaceTab) ? parsed.spaceTab : DEFAULTS.spaceTab,
      spaceOpen: typeof parsed.spaceOpen === "boolean" ? parsed.spaceOpen : DEFAULTS.spaceOpen,
      sidebarWidth: typeof parsed.sidebarWidth === "number" ? parsed.sidebarWidth : null,
    };
  } catch {
    return DEFAULTS;
  }
}

function persist(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

interface SidecarState {
  chatTab: SidecarTab;
  chatOpen: boolean;
  spaceTab: SidecarTab;
  spaceOpen: boolean;
  sidebarWidth: number | null;
  mobileOpen: boolean;

  /** Click-tab semantics: same+open ⇒ close; otherwise switch to and open. */
  selectTab: (scope: SidecarScope, panel: SidecarTab) => void;
  /** Force the sidecar closed without changing the remembered tab. */
  closeSidecar: (scope: SidecarScope) => void;
  setMobileOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
}

function tabKey(scope: SidecarScope): "chatTab" | "spaceTab" {
  return scope === "chat" ? "chatTab" : "spaceTab";
}
function openKey(scope: SidecarScope): "chatOpen" | "spaceOpen" {
  return scope === "chat" ? "chatOpen" : "spaceOpen";
}

export const useSidecarStore = create<SidecarState>()((set, get) => {
  const loaded = loadPersisted();

  const snapshot = (): PersistedState => {
    const s = get();
    return {
      chatTab: s.chatTab,
      chatOpen: s.chatOpen,
      spaceTab: s.spaceTab,
      spaceOpen: s.spaceOpen,
      sidebarWidth: s.sidebarWidth,
    };
  };

  return {
    chatTab: loaded.chatTab,
    chatOpen: loaded.chatOpen,
    spaceTab: loaded.spaceTab,
    spaceOpen: loaded.spaceOpen,
    sidebarWidth: loaded.sidebarWidth,
    mobileOpen: false,

    selectTab: (scope, panel) =>
      set((state) => {
        const tk = tabKey(scope);
        const ok = openKey(scope);
        const sameAsActive = state[tk] === panel;
        const isOpen = state[ok];
        const next =
          sameAsActive && isOpen
            ? { ...state, [ok]: false }
            : { ...state, [tk]: panel, [ok]: true };
        persist({
          chatTab: next.chatTab,
          chatOpen: next.chatOpen,
          spaceTab: next.spaceTab,
          spaceOpen: next.spaceOpen,
          sidebarWidth: next.sidebarWidth,
        });
        return next;
      }),

    closeSidecar: (scope) =>
      set((state) => {
        const ok = openKey(scope);
        if (!state[ok]) return state;
        const next = { ...state, [ok]: false };
        persist({
          chatTab: next.chatTab,
          chatOpen: next.chatOpen,
          spaceTab: next.spaceTab,
          spaceOpen: next.spaceOpen,
          sidebarWidth: next.sidebarWidth,
        });
        return next;
      }),

    setMobileOpen: (open) => set({ mobileOpen: open }),

    setSidebarWidth: (width) => {
      set({ sidebarWidth: width });
      persist(snapshot());
    },
  };
});

// ── Hook ────────────────────────────────────────────────────────────────────

interface UseSidecarPanelsOptions {
  scope: SidecarScope;
  isMobile: boolean;
  hasTasksContent: boolean;
  hasFilesContent: boolean;
  hasPlanContent: boolean;
  hasStats: boolean;
  hasBriefContent?: boolean;
  /** Delegated agents exist AND the provider advertises `supportsAgentActivity`. */
  hasAgentsContent?: boolean;
  /**
   * When true, suppress the fallback to other content-bearing tabs. Used during
   * initial hydration so the sidecar doesn't flash to e.g. "context" before the
   * user's remembered tab finishes lazy-loading its content.
   */
  contentLoading?: boolean;
  hasReviewContent?: boolean;
}

export interface UseSidecarPanelsResult {
  /** The tab the user last selected (preserved even when closed). */
  activeTab: SidecarTab;
  /** Whether the sidecar is open (regardless of content availability). */
  isOpen: boolean;
  /**
   * The tab to actually render: activeTab if it has content; otherwise the
   * first content-bearing panel; null if nothing has content.
   */
  effectiveTab: SidecarTab | null;
  /** Toggle/switch the active tab (header-tab semantics). */
  selectTab: (panel: SidecarTab) => void;
  /** Force the sidecar closed without losing the remembered tab. */
  closeSidecar: () => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  /** Number of panel kinds with content (for mobile badge). */
  sidecarContentCount: number;
  /** All panels with content (for mobile overlay tab strip). */
  allContentPanels: ReadonlySet<SidecarTab>;
  /** Whether the desktop sidecar should render right now. */
  showDesktopSidecar: boolean;
}

export function useSidecarPanels({
  scope,
  isMobile,
  hasTasksContent,
  hasFilesContent,
  hasPlanContent,
  hasStats,
  hasBriefContent = false,
  hasAgentsContent = false,
  contentLoading = false,
  hasReviewContent = false,
}: UseSidecarPanelsOptions): UseSidecarPanelsResult {
  const activeTab = useSidecarStore((s) => (scope === "chat" ? s.chatTab : s.spaceTab));
  const isOpen = useSidecarStore((s) => (scope === "chat" ? s.chatOpen : s.spaceOpen));
  const mobileOpen = useSidecarStore((s) => s.mobileOpen);
  const storeSelectTab = useSidecarStore((s) => s.selectTab);
  const storeCloseSidecar = useSidecarStore((s) => s.closeSidecar);
  const storeSetMobileOpen = useSidecarStore((s) => s.setMobileOpen);

  const selectTab = useCallback(
    (panel: SidecarTab) => storeSelectTab(scope, panel),
    [storeSelectTab, scope],
  );
  const closeSidecar = useCallback(() => storeCloseSidecar(scope), [storeCloseSidecar, scope]);
  const setMobileOpen = useCallback(
    (open: boolean) => storeSetMobileOpen(open),
    [storeSetMobileOpen],
  );

  const hasContent = useCallback(
    (tab: SidecarTab): boolean => {
      switch (tab) {
        case "tasks":
          return hasTasksContent;
        case "agents":
          return hasAgentsContent;
        case "files":
          return hasFilesContent;
        case "plan":
          return hasPlanContent;
        case "context":
          return hasStats;
        case "brief":
          return hasBriefContent;
        case "review":
          return hasReviewContent;
      }
    },
    [
      hasTasksContent,
      hasAgentsContent,
      hasFilesContent,
      hasPlanContent,
      hasStats,
      hasBriefContent,
      hasReviewContent,
    ],
  );

  const allContentPanels = useMemo(() => {
    const s = new Set<SidecarTab>();
    for (const tab of FALLBACK_ORDER) {
      if (hasContent(tab)) s.add(tab);
    }
    return s;
  }, [hasContent]);

  const sidecarContentCount = allContentPanels.size;

  const effectiveTab = useMemo<SidecarTab | null>(() => {
    if (hasContent(activeTab)) return activeTab;
    // While content is still hydrating, return activeTab anyway so the sidecar
    // is present from first paint (no animation). The panel will show a loading
    // state until content arrives, rather than flashing to a different tab.
    if (contentLoading) return activeTab;
    for (const tab of FALLBACK_ORDER) {
      if (hasContent(tab)) return tab;
    }
    return null;
  }, [activeTab, hasContent, contentLoading]);

  const showDesktopSidecar = !isMobile && isOpen && effectiveTab !== null;

  return {
    activeTab,
    isOpen,
    effectiveTab,
    selectTab,
    closeSidecar,
    mobileOpen,
    setMobileOpen,
    sidecarContentCount,
    allContentPanels,
    showDesktopSidecar,
  };
}
