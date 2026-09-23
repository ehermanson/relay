import path from "node:path";
import type { Hono } from "hono";
import { fileResponse, indexResponse, isAuthenticated } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

export function registerUiRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  app.get("*", (c) => {
    const pathname = new URL(c.req.url).pathname;

    if (deps.config.serveUI) {
      if (
        pathname.startsWith("/assets/") ||
        pathname === "/favicon.svg" ||
        pathname === "/favicon.ico" ||
        pathname === "/manifest.json" ||
        pathname === "/sw.js" ||
        pathname === "/apple-touch-icon.png" ||
        pathname === "/icon-192.png" ||
        pathname === "/icon-512.png"
      ) {
        const filePath = path.join(deps.uiDistDir, pathname);
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(deps.uiDistDir)) {
          return c.html("<h1>Forbidden</h1>", 403);
        }
        return fileResponse(resolved, pathname.startsWith("/assets/"));
      }

      return indexResponse(deps.indexHtmlPath);
    }

    if (pathname === "/" || pathname === "/login") {
      return c.json({ status: "ok", authenticated: isAuthenticated(c) });
    }

    if (pathname.startsWith("/projects")) {
      if (!isAuthenticated(c)) {
        return c.redirect("/login", 302);
      }
      return c.json({ status: "ok", authenticated: true });
    }

    return c.html("<h1>404 Not Found</h1>", 404);
  });
}
