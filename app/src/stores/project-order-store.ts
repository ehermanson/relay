import { useCallback } from "react";
import { create } from "zustand";

// ── Server sync ───────────────────────────────────────────────────────────────

function syncOrderToServer(order: string[]): void {
  fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectOrder: order }),
  }).catch(() => {});
}

// ── Store ────────────────────────────────────────────────────────────────────

const ORDER_CACHE_KEY = "relay:project-order";
const COLLAPSED_KEY = "relay:project-collapsed";

// The server-backed settings row is the canonical order; localStorage is only a
// bootstrap cache so the first paint renders in the last known order instead of
// flashing an alphabetical fallback while `/api/settings` is in flight.
function loadOrderCache(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_CACHE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveOrderCache(order: string[]): void {
  try {
    localStorage.setItem(ORDER_CACHE_KEY, JSON.stringify(order));
  } catch {
    // quota exceeded — silently ignore
  }
}

function loadCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveCollapsed(dirs: string[]): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(dirs));
  } catch {}
}

interface ProjectOrderState {
  order: string[];
  hydrated: boolean;
  setOrder: (next: string[] | ((prev: string[]) => string[])) => void;
  hydrateFromServer: (order: string[]) => void;
  moveToTop: (dir: string) => void;
  moveUp: (dir: string, visibleDirs: string[]) => void;
  moveDown: (dir: string, visibleDirs: string[]) => void;
  moveToBottom: (dir: string) => void;
  collapsed: Set<string>;
  toggleCollapsed: (dir: string) => void;
  setCollapsed: (dir: string, collapsed: boolean) => void;
}

/**
 * Swap the canonical positions of two dirs within `order`. Returns a new array,
 * or null if either dir is missing. Any dirs between them keep their slots, so
 * the swap only flips the relative order of `a` and `b`.
 */
function swapInOrder(order: string[], a: string, b: string): string[] | null {
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  if (ai === -1 || bi === -1) return null;
  const next = [...order];
  [next[ai], next[bi]] = [next[bi], next[ai]];
  return next;
}

/** Wrapper that persists after every mutation. */
function persistSet(
  set: (fn: (s: ProjectOrderState) => Partial<ProjectOrderState>) => void,
  fn: (s: ProjectOrderState) => Partial<ProjectOrderState>,
) {
  set((state) => {
    const patch = fn(state);
    if (patch.order) saveOrderCache(patch.order);
    return patch;
  });
}

const useProjectOrderStore = create<ProjectOrderState>()((set, get) => ({
  order: loadOrderCache(),
  hydrated: false,

  setOrder: (next) => {
    const order = typeof next === "function" ? next(get().order) : next;
    saveOrderCache(order);
    syncOrderToServer(order);
    set({ order });
  },

  /** Apply the server-backed canonical order without echoing it back. */
  hydrateFromServer: (order) => {
    saveOrderCache(order);
    set({ order, hydrated: true });
  },

  moveToTop: (dir) =>
    persistSet(set, ({ order }) => {
      const next = [dir, ...order.filter((d) => d !== dir)];
      syncOrderToServer(next);
      return { order: next };
    }),

  // moveUp/moveDown swap `dir` with its adjacent *visible* neighbor. The stored
  // `order` can contain hidden dirs (removed projects, projects without chats)
  // interleaved with visible ones, so swapping raw-array neighbors may swap
  // against a hidden dir and produce no visible change. We swap the canonical
  // positions of the two visible dirs instead, leaving hidden dirs untouched.
  moveUp: (dir, visibleDirs) =>
    persistSet(set, ({ order }) => {
      const vIdx = visibleDirs.indexOf(dir);
      if (vIdx <= 0) return { order };
      const next = swapInOrder(order, dir, visibleDirs[vIdx - 1]);
      if (!next) return { order };
      syncOrderToServer(next);
      return { order: next };
    }),

  moveDown: (dir, visibleDirs) =>
    persistSet(set, ({ order }) => {
      const vIdx = visibleDirs.indexOf(dir);
      if (vIdx === -1 || vIdx >= visibleDirs.length - 1) return { order };
      const next = swapInOrder(order, dir, visibleDirs[vIdx + 1]);
      if (!next) return { order };
      syncOrderToServer(next);
      return { order: next };
    }),

  moveToBottom: (dir) =>
    persistSet(set, ({ order }) => {
      const next = [...order.filter((d) => d !== dir), dir];
      syncOrderToServer(next);
      return { order: next };
    }),

  collapsed: new Set(loadCollapsed()),

  toggleCollapsed: (dir) =>
    set((state) => {
      const next = new Set(state.collapsed);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      saveCollapsed([...next]);
      return { collapsed: next };
    }),

  setCollapsed: (dir, value) =>
    set((state) => {
      const next = new Set(state.collapsed);
      if (value) next.add(dir);
      else next.delete(dir);
      saveCollapsed([...next]);
      return { collapsed: next };
    }),
}));

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Persists a shared project ordering via the server-backed global settings row.
 *
 * Every component that calls this hook shares the same store, so Sidebar and
 * Dashboard always agree on project order.
 *
 * Projects present in the stored order are sorted to match it;
 * any new (unseen) projects are appended at the end in alphabetical order.
 */
export function useProjectOrder() {
  const {
    order,
    hydrated,
    setOrder,
    hydrateFromServer,
    moveToTop,
    moveUp,
    moveDown,
    moveToBottom,
    collapsed,
    toggleCollapsed,
    setCollapsed,
  } = useProjectOrderStore();

  /**
   * Given a list of directory paths currently visible, returns them sorted
   * according to the stored order.  Unknown directories are appended
   * alphabetically at the end, and the stored order is updated to include them.
   */
  const applyOrder = useCallback(
    (dirs: string[]): string[] => {
      const dirSet = new Set(dirs);
      const storedSet = new Set(order);

      // Directories that are in the stored order (in stored sequence)
      const known = order.filter((d) => dirSet.has(d));

      // New directories not yet in the stored order
      const unknown = dirs
        .filter((d) => !storedSet.has(d))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      return [...known, ...unknown];
    },
    [order],
  );

  const syncVisibleDirs = useCallback(
    (dirs: string[]) => {
      if (!hydrated) return;
      const storedSet = new Set(order);
      const unknown = dirs
        .filter((d) => !storedSet.has(d))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      // Preserve directories that are temporarily absent so we don't wipe the
      // saved order during initial empty renders before websocket sync finishes.
      if (unknown.length > 0) {
        setOrder([...order, ...unknown]);
      }
    },
    [hydrated, order, setOrder],
  );

  /** Sort a `[dir, T][]` entries array according to the stored project order. */
  const sortEntries = useCallback(
    <T>(entries: [string, T][]): [string, T][] => {
      const dirs = entries.map(([d]) => d);
      const sorted = applyOrder(dirs);
      const map = new Map(entries);
      return sorted.map((d) => [d, map.get(d)!]);
    },
    [applyOrder],
  );

  return {
    order,
    hydrated,
    sortEntries,
    hydrateFromServer,
    moveToTop,
    moveUp,
    moveDown,
    moveToBottom,
    syncVisibleDirs,
    collapsed,
    toggleCollapsed,
    setCollapsed,
  };
}

export function resetProjectOrderStoreForTests(): void {
  // Mirror initial-load behavior: bootstrap from the local cache, unhydrated.
  useProjectOrderStore.setState({
    order: loadOrderCache(),
    hydrated: false,
    collapsed: new Set(),
  });
}
