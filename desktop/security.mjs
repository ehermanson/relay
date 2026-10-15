export function isLocalURL(value, origin) {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}
export function externalURL(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function chatPath(value) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\r\n]/.test(value)
    ? value
    : "/";
}

/** A native window may load only UI routes, never executable file responses. */
export function applicationPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value)
  )
    return null;
  try {
    const url = new URL(value, "http://relay.invalid");
    if (
      url.origin !== "http://relay.invalid" ||
      !/^\/(?:projects(?:\/|$)|settings(?:\/|$)|login\/?$|sandbox\/?$|$)/.test(url.pathname)
    )
      return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

/** Preserve ordinary Copy actions without granting clipboard reads or media access. */
export function allowedPermission(permission, url, origin) {
  return permission === "clipboard-sanitized-write" && isLocalURL(url, origin);
}
