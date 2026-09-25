import { useCallback, useSyncExternalStore } from "react";

/**
 * Experimental, per-browser opt-in: replace the Lexical composer with a plain
 * `<textarea>` on touch devices. iOS applies autocorrect/predictive text far
 * better to a native text field than to a JS-controlled contenteditable, so
 * this exists to A/B the two on a phone. Lives in localStorage (not global
 * settings) because it is a device-level experiment, not a user preference.
 */
const STORAGE_KEY = "relay.nativeMobileComposer.v1";
const CHANGE_EVENT = "relay:native-mobile-composer";

function read(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function write(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Quota / private mode: the toggle simply won't persist.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

export function useNativeMobileComposer(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, read, () => false);
  const setEnabled = useCallback((next: boolean) => write(next), []);
  return [enabled, setEnabled];
}
