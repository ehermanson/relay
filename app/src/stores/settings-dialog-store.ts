/**
 * Global Settings opens as a dialog over whatever is on screen, so tweaking a
 * setting never costs the user their place. Any surface opens it through this
 * store; `SettingsDialog` is mounted once in the app layout.
 */

import { create } from "zustand";

export const SETTINGS_SECTIONS = ["general", "providers", "suggestions"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly unknown[]).includes(value);
}

interface SettingsDialogStore {
  open: boolean;
  /** `null` is the section list, which only phones show. */
  section: SettingsSection | null;
  /** Without a section, reopens where the user last was. */
  openSettings: (section?: SettingsSection) => void;
  setSection: (section: SettingsSection | null) => void;
  close: () => void;
}

export const useSettingsDialog = create<SettingsDialogStore>((set) => ({
  open: false,
  section: null,
  openSettings: (section) => set((state) => ({ open: true, section: section ?? state.section })),
  setSection: (section) => set({ section }),
  close: () => set({ open: false }),
}));

/** For callers outside React (route redirects, toasts). */
export function openSettings(section?: SettingsSection): void {
  useSettingsDialog.getState().openSettings(section);
}
