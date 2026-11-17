/** The desktop preload exposes capabilities only; renderer code has no Node access. */
export interface DesktopPreferences {
  launchAtLogin: boolean;
  notifications: boolean;
  closeToTray: boolean;
  globalShortcut: boolean;
  /** Absent on app shells that predate it. */
  stayAwake?: boolean;
}
export type DesktopCommand = "search" | "new-chat" | "new-project" | "toggle-sidebar" | "settings";
/** How local mode runs its own server. The password itself never reaches the page. */
export interface DesktopLocalServer {
  /** "shared" uses the Relay CLI's data; "private" keeps the app's own. */
  data: "private" | "shared";
  /** Serve browsers and phones too, like `relay start`. */
  share: boolean;
  port: number;
  hasPassword: boolean;
}
export interface DesktopConnection {
  mode: "local" | "existing";
  url: string | null;
  /** Absent on app shells older than shared local servers. */
  local?: DesktopLocalServer;
  sharedHome?: string;
  /** The app runs on the shared data and still has its own separate data. */
  privateData?: boolean;
  /** What the last import of that separate data did. */
  lastImport?: {
    ok: boolean;
    projects?: number;
    chats?: number;
    error?: string;
    at: number;
  } | null;
}
export interface RelayDesktop {
  platform: string;
  capabilities?: {
    launchAtLogin: boolean;
    multipleWindows?: boolean;
    attachedServer?: boolean;
    sharing?: boolean;
    localFiles?: boolean;
    /** The native folder chooser applies: local mode, or attached to a server on this computer. */
    chooseFolders?: boolean;
  };
  getConnection(): Promise<DesktopConnection>;
  setConnection(connection: {
    mode: "local" | "existing";
    url?: string;
    /** `password`: omit to keep, null to clear, a string to set. */
    local?: { data: "private" | "shared"; share: boolean; port: number; password?: string | null };
  }): Promise<void>;
  /** Merge the app's separate data into the shared data; restarts the app. */
  importPrivateData?(): Promise<void>;
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

/** Older shells only report `localFiles`; newer ones also allow a localhost-attached server. */
export function canChooseFolders(desktop: RelayDesktop | undefined): desktop is RelayDesktop {
  return Boolean(desktop?.capabilities?.chooseFolders ?? desktop?.capabilities?.localFiles);
}
