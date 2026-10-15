import { applicationPath } from "./security.mjs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, sep } from "node:path";
export const DEFAULT_PREFERENCES = {
  launchAtLogin: false,
  notifications: false,
  closeToTray: true,
  globalShortcut: false,
};
export function validatePreferences(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_PREFERENCES, key)) ||
    Object.values(value).some((entry) => typeof entry !== "boolean")
  )
    throw new Error("Invalid desktop preferences");
  return value;
}
export function restoreBounds(value, displays) {
  const fallback = displays[0]?.workArea || { x: 0, y: 0, width: 1280, height: 860 };
  const finite = (key) => Number.isFinite(value?.[key]);
  const area =
    displays.find(
      (display) =>
        finite("x") &&
        finite("y") &&
        value.x >= display.workArea.x &&
        value.y >= display.workArea.y &&
        value.x < display.workArea.x + display.workArea.width &&
        value.y < display.workArea.y + display.workArea.height,
    )?.workArea || fallback;
  const width = Math.min(area.width, Math.max(800, finite("width") ? value.width : 1280));
  const height = Math.min(area.height, Math.max(600, finite("height") ? value.height : 860));
  const result = {
    width: Math.round(width),
    height: Math.round(height),
    x: Math.max(
      area.x,
      Math.min(
        finite("x") ? value.x : area.x + (area.width - width) / 2,
        area.x + area.width - width,
      ),
    ),
    y: Math.max(
      area.y,
      Math.min(
        finite("y") ? value.y : area.y + (area.height - height) / 2,
        area.y + area.height - height,
      ),
    ),
  };
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Math.round(value)]));
}
export function deepLinkPath(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "relay:" ||
      url.hostname !== "open" ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const path = url.searchParams.get("path") || "/";
    return applicationPath(path);
  } catch {
    return null;
  }
}
export async function authorizedPath(value, roots) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 8192)
    throw new Error("Choose a local Project file");
  const resolved = await realpath(value);
  for (const root of roots) {
    try {
      const base = await realpath(root);
      const inside = relative(base, resolved);
      if (
        inside === "" ||
        (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))
      )
        return resolved;
    } catch {
      /* Missing Project root. */
    }
  }
  throw new Error("This path is outside registered Projects");
}
export async function safeOpenPath(value, roots) {
  const resolved = await authorizedPath(value, roots);
  const info = await stat(resolved);
  if (
    !info.isDirectory() &&
    !new Set([
      ".txt",
      ".md",
      ".pdf",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
      ".svg",
      ".mp4",
      ".mov",
      ".webm",
      ".docx",
      ".xlsx",
      ".csv",
    ]).has(extname(resolved).toLowerCase())
  )
    throw new Error("Use your configured editor or Reveal for this file type");
  return resolved;
}
