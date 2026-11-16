/**
 * Per-browser Workstream sidebar state: which folders are expanded (persisted,
 * so the sidebar looks the same after a reload) and a one-shot "reveal" request
 * from a chip elsewhere in the app.
 */

import { create } from "zustand";
import type { Workstream } from "@shared/types";

/**
 * The one Workstream dialog on screen. It lives in the store because its
 * triggers are menu items, and a menu unmounts as it closes.
 */
export type WorkstreamDialog =
  | { kind: "create"; instanceId?: string }
  | { kind: "rename"; workstream: Workstream }
  | { kind: "delete"; workstream: Workstream }
  | { kind: "folder"; workstream: Workstream };

const STORAGE_KEY = "relay:workstreams-expanded";
const SECTION_KEY = "relay:workstreams-section-open";

function readExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) => value === true),
    ) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function readSectionOpen(): boolean {
  try {
    return localStorage.getItem(SECTION_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeExpanded(expanded: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded));
  } catch {
    // Storage full or unavailable: expansion just won't survive a reload.
  }
}

interface WorkstreamUiStore {
  /** Folder id → expanded. Absent means collapsed. */
  expanded: Record<string, boolean>;
  /** Folder a chip asked the sidebar to open and scroll to; cleared once handled. */
  revealId: string | null;
  /** Whether the sidebar's Workstreams section itself is open. */
  sectionOpen: boolean;
  dialog: WorkstreamDialog | null;
  setExpanded: (id: string, open: boolean) => void;
  setSectionOpen: (open: boolean) => void;
  openDialog: (dialog: WorkstreamDialog) => void;
  closeDialog: () => void;
  reveal: (id: string) => void;
  clearReveal: () => void;
}

export const useWorkstreamUiStore = create<WorkstreamUiStore>()((set, get) => ({
  expanded: readExpanded(),
  revealId: null,
  sectionOpen: readSectionOpen(),
  dialog: null,
  setSectionOpen: (open) => {
    try {
      localStorage.setItem(SECTION_KEY, open ? "1" : "0");
    } catch {
      // Not persisted; fine.
    }
    set({ sectionOpen: open });
  },
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setExpanded: (id, open) => {
    const expanded = { ...get().expanded };
    if (open) expanded[id] = true;
    else delete expanded[id];
    writeExpanded(expanded);
    set({ expanded });
  },
  reveal: (id) => {
    get().setExpanded(id, true);
    get().setSectionOpen(true);
    set({ revealId: id });
  },
  clearReveal: () => set({ revealId: null }),
}));
