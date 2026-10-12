/** The desktop preload exposes capabilities only; renderer code has no Node access. */
export interface DesktopPreferences {
  launchAtLogin: boolean;
  notifications: boolean;
  closeToTray: boolean;
  globalShortcut: boolean;
}
export type DesktopCommand = "search" | "new-chat" | "new-project" | "toggle-sidebar" | "settings";
export interface DesktopConnection {
  mode: "local" | "existing";
  url: string | null;
}
export interface RelayDesktop {
  platform: string;
  capabilities?: {
    launchAtLogin: boolean;
    multipleWindows?: boolean;
    attachedServer?: boolean;
    sharing?: boolean;
    localFiles?: boolean;
  };
  getConnection(): Promise<DesktopConnection>;
  setConnection(connection: { mode: "local" | "existing"; url?: string }): Promise<void>;
  fullscreen?: boolean;
  onFullscreen(callback: (fullscreen: boolean) => void): () => void;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
  revealPath(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  newWindow(path?: string): Promise<void>;
  onNavigate(callback: (path: string) => void): () => void;
  chooseDirectory(): Promise<string | null>;
  setBadge(count: number): Promise<void>;
  setTheme(theme: "dark" | "light"): Promise<void>;
  setActivity(activity: { running: number; needsInput: number; failed: number }): Promise<void>;
  notify(notification: { title: string; body: string; path: string }): Promise<void>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
}
declare global {
  interface Window {
    relayDesktop?: RelayDesktop;
  }
}
export function getDesktop(): RelayDesktop | undefined {
  return typeof window === "undefined" ? undefined : window.relayDesktop;
}
