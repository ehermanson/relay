/** Relay's route for serving local files (uploads, agent screenshots) to the browser. */
export function localFileUrl(path: string): string {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

/**
 * Agents often embed images by filesystem path — `![shot](/tmp/shot.png)` or
 * `file:///tmp/shot.png`. The browser would resolve those against Relay's
 * origin (404) or refuse the protocol, so route them through `/api/file`.
 * Returns null when `src` isn't a local filesystem path.
 */
export function localImageSrc(src: string): string | null {
  let path: string | null = null;
  if (src.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(src).pathname);
    } catch {
      return null;
    }
  } else if (src.startsWith("/") && !src.startsWith("//") && !src.startsWith("/api/")) {
    path = src;
  }
  return path ? localFileUrl(path) : null;
}
