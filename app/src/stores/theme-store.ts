import { create } from "zustand";

export type ThemePreference = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "relay-theme";

function getSystemTheme(): ResolvedTheme {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

function loadPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "system") return stored;
    return "dark";
  } catch {
    return "dark";
  }
}

/** Header background (--color-bg) per theme; iOS paints the status bar with it. */
const THEME_COLORS: Record<ResolvedTheme, string> = { dark: "#1d1e20", light: "#ffffff" };

/** Apply theme class and status-bar color to the document. */
function applyTheme(resolved: ResolvedTheme) {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("light", resolved === "light");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_COLORS[resolved]);
  }
}

function persistPreference(preference: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {}
}

interface ThemeState {
  /** The user's preference (may be "system"). */
  preference: ThemePreference;
  /** The resolved theme actually applied to the DOM. */
  theme: ResolvedTheme;
  toggle: () => void;
  setTheme: (preference: ThemePreference) => void;
}

export const useThemeStore = create<ThemeState>()((set, get) => {
  const initial = loadPreference();
  const resolved = resolveTheme(initial);
  applyTheme(resolved);

  // Listen for OS theme changes when preference is "system"
  if (typeof window !== "undefined" && window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (get().preference === "system") {
        const newResolved = getSystemTheme();
        applyTheme(newResolved);
        set({ theme: newResolved });
      }
    });
  }

  return {
    preference: initial,
    theme: resolved,
    toggle: () =>
      set((s) => {
        const next = s.theme === "dark" ? "light" : "dark";
        applyTheme(next);
        persistPreference(next);
        return { preference: next, theme: next };
      }),
    setTheme: (preference: ThemePreference) => {
      if (get().preference !== preference) {
        const resolved = resolveTheme(preference);
        applyTheme(resolved);
        persistPreference(preference);
        set({ preference, theme: resolved });
      }
    },
  };
});

/** Drop-in replacement for the old useTheme() hook. */
export function useTheme() {
  return useThemeStore();
}
