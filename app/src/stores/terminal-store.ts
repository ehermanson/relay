import { create } from "zustand";
import type { TerminalInfo, TerminalScope, TerminalScopeSummary } from "@shared/types";

const PANEL_HEIGHT_KEY = "relay-terminal-panel-height";
const PANEL_VISIBLE_KEY = "relay-terminal-panel-visible";
const NAMES_KEY = "relay-terminal-names";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 600;

/**
 * Panel visibility state — global, applies to whichever scope is in view.
 * "visible" renders the full panel; "collapsed" keeps terminals alive
 * but hides the panel (a collapsed bar is rendered instead when the scope
 * has at least one terminal).
 */
export type PanelVisibility = "visible" | "collapsed";

function loadHeight(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
    if (v >= MIN_HEIGHT && v <= MAX_HEIGHT) return v;
  } catch {
    // ignore
  }
  return DEFAULT_HEIGHT;
}

function loadPanelVisibility(): PanelVisibility {
  try {
    const raw = localStorage.getItem(PANEL_VISIBLE_KEY);
    if (raw === "visible" || raw === "collapsed") return raw;
  } catch {
    // ignore
  }
  return "visible";
}

function persistPanelVisibility(v: PanelVisibility): void {
  try {
    localStorage.setItem(PANEL_VISIBLE_KEY, v);
  } catch {
    // ignore
  }
}

function loadNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function persistNames(names: Record<string, string>): void {
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify(names));
  } catch {}
}

export function scopeKey(scope: TerminalScope): string {
  return `instance:${scope.instanceId}`;
}

export interface TerminalContextAttachment {
  id: string;
  terminalName: string;
  text: string;
}

let attachmentCounter = 0;

interface TerminalState {
  /** All known terminal sessions. */
  terminals: Map<string, TerminalInfo>;
  /** Active terminal per scope key. */
  activeTerminalId: Record<string, string | null>;
  /** Global panel visibility preference — applies whenever a scope has terminals. */
  panelVisibility: PanelVisibility;
  /** Panel height in pixels (shared across all scopes). */
  panelHeight: number;
  /** Terminal output snippets attached to the next chat message, keyed by instance ID. */
  terminalContexts: Record<string, TerminalContextAttachment[]>;
  /** Custom terminal names (terminalId → name). Persisted to localStorage. */
  terminalNames: Record<string, string>;
  /**
   * Global count of live terminals per scope key (`instance:<id>`).
   * Sourced from the server's `terminal_scopes` broadcast so the sidebar can
   * flag scopes with running terminals without opening each one.
   */
  activeScopeCounts: Record<string, number>;

  // ── Actions ──────────────────────────────────────────────────────
  /** Replace all terminals for a scope — removes stale entries not in the new list. */
  setTerminalsForScope: (scope: TerminalScope, terminals: TerminalInfo[]) => void;
  addTerminal: (terminal: TerminalInfo) => void;
  removeTerminal: (terminalId: string) => void;
  updateTerminal: (terminalId: string, update: Partial<TerminalInfo>) => void;
  setActiveTerminal: (scopeKey: string, terminalId: string) => void;
  /** Cycle between "visible" and "collapsed". Terminals are never killed. */
  togglePanel: () => void;
  openPanel: () => void;
  /** Alias for collapsePanel — terminals keep running in the background. */
  closePanel: () => void;
  collapsePanel: () => void;
  expandPanel: () => void;
  setPanelHeight: (height: number) => void;
  persistHeight: () => void;
  addTerminalContext: (instanceId: string, terminalName: string, text: string) => void;
  removeTerminalContext: (instanceId: string, id: string) => void;
  clearTerminalContexts: (instanceId: string) => void;
  getTerminalContexts: (instanceId: string) => TerminalContextAttachment[];
  renameTerminal: (terminalId: string, name: string) => void;
  /** Replace the global live-terminal scope snapshot. */
  setActiveScopes: (scopes: TerminalScopeSummary[]) => void;

  // ── Selectors ────────────────────────────────────────────────────
  getTerminalsForScope: (scope: TerminalScope) => TerminalInfo[];
  getActiveTerminal: (scope: TerminalScope) => TerminalInfo | undefined;
  getTerminalName: (terminalId: string, index: number) => string;
  /** True when the panel should be rendered (visible pref + scope has terminals). */
  isPanelOpen: (scope: TerminalScope) => boolean;
  /** True when the panel is collapsed (terminals alive but minimized). */
  isPanelCollapsed: (scope: TerminalScope) => boolean;
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  terminals: new Map(),
  activeTerminalId: {},
  panelVisibility: loadPanelVisibility(),
  panelHeight: loadHeight(),
  terminalContexts: {},
  terminalNames: loadNames(),
  activeScopeCounts: {},

  setTerminalsForScope: (scope, terminals) =>
    set((s) => {
      const key = scopeKey(scope);
      // Start from current map, remove all entries for this scope, then add the fresh list
      const map = new Map(s.terminals);
      for (const [id, t] of map) {
        if (scopeKey(t.scope) === key) map.delete(id);
      }
      for (const t of terminals) map.set(t.id, t);
      // Fix up active terminal for this scope
      const currentActive = s.activeTerminalId[key];
      const activeStillExists = currentActive && map.has(currentActive);
      const firstForScope = terminals[0]?.id ?? null;
      return {
        terminals: map,
        activeTerminalId: {
          ...s.activeTerminalId,
          [key]: activeStillExists ? currentActive : firstForScope,
        },
      };
    }),

  addTerminal: (terminal) =>
    set((s) => {
      const map = new Map(s.terminals);
      const alreadyExists = map.has(terminal.id);
      map.set(terminal.id, terminal);
      const key = scopeKey(terminal.scope);
      // Only auto-activate if this is a genuinely new terminal, or there's no active one
      const currentActive = s.activeTerminalId[key];
      const shouldActivate = !alreadyExists || !currentActive || !map.has(currentActive);
      return {
        terminals: map,
        activeTerminalId: shouldActivate
          ? { ...s.activeTerminalId, [key]: terminal.id }
          : s.activeTerminalId,
      };
    }),

  removeTerminal: (terminalId) =>
    set((s) => {
      const map = new Map(s.terminals);
      const removed = map.get(terminalId);
      map.delete(terminalId);
      if (!removed) return { terminals: map };

      const key = scopeKey(removed.scope);
      const active = s.activeTerminalId[key];
      const remaining = Array.from(map.values()).find((t) => scopeKey(t.scope) === key);
      const newActive = active === terminalId ? (remaining?.id ?? null) : active;

      return {
        terminals: map,
        activeTerminalId: { ...s.activeTerminalId, [key]: newActive ?? null },
      };
    }),

  updateTerminal: (terminalId, update) =>
    set((s) => {
      const existing = s.terminals.get(terminalId);
      if (!existing) return s;
      const map = new Map(s.terminals);
      map.set(terminalId, { ...existing, ...update });
      return { terminals: map };
    }),

  setActiveTerminal: (key, terminalId) =>
    set((s) => ({ activeTerminalId: { ...s.activeTerminalId, [key]: terminalId } })),

  togglePanel: () =>
    set((s) => {
      const next: PanelVisibility = s.panelVisibility === "visible" ? "collapsed" : "visible";
      persistPanelVisibility(next);
      return { panelVisibility: next };
    }),

  openPanel: () =>
    set((s) => {
      if (s.panelVisibility === "visible") return s;
      persistPanelVisibility("visible");
      return { panelVisibility: "visible" };
    }),

  closePanel: () =>
    set((s) => {
      if (s.panelVisibility === "collapsed") return s;
      persistPanelVisibility("collapsed");
      return { panelVisibility: "collapsed" };
    }),

  collapsePanel: () =>
    set((s) => {
      if (s.panelVisibility === "collapsed") return s;
      persistPanelVisibility("collapsed");
      return { panelVisibility: "collapsed" };
    }),

  expandPanel: () =>
    set((s) => {
      if (s.panelVisibility === "visible") return s;
      persistPanelVisibility("visible");
      return { panelVisibility: "visible" };
    }),

  setPanelHeight: (height) =>
    set({ panelHeight: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)) }),

  persistHeight: () => {
    try {
      localStorage.setItem(PANEL_HEIGHT_KEY, String(get().panelHeight));
    } catch {}
  },

  addTerminalContext: (instanceId, terminalName, text) =>
    set((s) => {
      const existing = s.terminalContexts[instanceId] ?? [];
      return {
        terminalContexts: {
          ...s.terminalContexts,
          [instanceId]: [...existing, { id: `tc-${++attachmentCounter}`, terminalName, text }],
        },
      };
    }),

  removeTerminalContext: (instanceId, id) =>
    set((s) => {
      const existing = s.terminalContexts[instanceId] ?? [];
      return {
        terminalContexts: {
          ...s.terminalContexts,
          [instanceId]: existing.filter((c) => c.id !== id),
        },
      };
    }),

  clearTerminalContexts: (instanceId) =>
    set((s) => {
      const next = { ...s.terminalContexts };
      delete next[instanceId];
      return { terminalContexts: next };
    }),

  getTerminalContexts: (instanceId) => get().terminalContexts[instanceId] ?? [],

  setActiveScopes: (scopes) =>
    set(() => {
      const counts: Record<string, number> = {};
      for (const s of scopes) counts[scopeKey(s.scope)] = s.count;
      return { activeScopeCounts: counts };
    }),

  renameTerminal: (terminalId, name) =>
    set((s) => {
      const trimmed = name.trim();
      const next = { ...s.terminalNames };
      if (trimmed) {
        next[terminalId] = trimmed;
      } else {
        delete next[terminalId];
      }
      persistNames(next);
      return { terminalNames: next };
    }),

  getTerminalsForScope: (scope) => {
    const key = scopeKey(scope);
    return Array.from(get().terminals.values()).filter((t) => scopeKey(t.scope) === key);
  },

  getTerminalName: (terminalId, index) => {
    return get().terminalNames[terminalId] || `Terminal ${String.fromCharCode(65 + index)}`;
  },

  getActiveTerminal: (scope) => {
    const key = scopeKey(scope);
    const activeId = get().activeTerminalId[key];
    if (!activeId) return undefined;
    return get().terminals.get(activeId);
  },

  isPanelOpen: (scope) => {
    const s = get();
    if (s.panelVisibility !== "visible") return false;
    const key = scopeKey(scope);
    for (const t of s.terminals.values()) {
      if (scopeKey(t.scope) === key) return true;
    }
    return false;
  },
  isPanelCollapsed: (scope) => {
    const s = get();
    if (s.panelVisibility !== "collapsed") return false;
    const key = scopeKey(scope);
    for (const t of s.terminals.values()) {
      if (scopeKey(t.scope) === key) return true;
    }
    return false;
  },
}));
