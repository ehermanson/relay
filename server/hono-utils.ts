import { VIDEO_MIME_BY_EXT } from "#core/video-attachments.js";
import fs from "node:fs";
import path from "node:path";
import type { Context, Next } from "hono";
import type { Session } from "#core/types.js";
import type { AuthManager } from "#server/auth.js";
import type { AppEnv } from "#server/route-types.js";

export type AppContext = Context<AppEnv>;

export async function sessionMiddleware(
  auth: AuthManager,
  c: AppContext,
  next: Next,
): Promise<void> {
  if (!auth.authRequired) {
    // Open mode — everyone is authenticated
    c.set("session", null);
    c.set("isAuthenticated", true);
    await next();
    return;
  }

  const session = auth.getSessionFromCookies(c.req.header("cookie"));
  c.set("session", session);
  c.set("isAuthenticated", session !== null);
  await next();
}

export function getSession(c: AppContext): Session | null {
  return c.get("session");
}

export function isAuthenticated(c: AppContext): boolean {
  return c.get("isAuthenticated");
}

export async function requireAuthMiddleware(c: AppContext, next: Next): Promise<Response | void> {
  // isAuthenticated is already true in open mode (set by sessionMiddleware)
  if (!c.get("isAuthenticated")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}

export async function readJsonBody<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
}

export async function readBodyBuffer(c: AppContext, maxBytes: number): Promise<Buffer> {
  const stream = c.req.raw.body;
  if (!stream) {
    return Buffer.alloc(0);
  }

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error("Body too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

export function getMimeType(filePath: string): string {
  const mimeTypes: Record<string, string> = {
    ...VIDEO_MIME_BY_EXT,
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
    ".bmp": "image/bmp",
    ".pdf": "application/pdf",
    ".csv": "text/csv; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".yaml": "application/yaml; charset=utf-8",
    ".yml": "application/yaml; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".diff": "text/plain; charset=utf-8",
    ".patch": "text/plain; charset=utf-8",
    ".sql": "application/sql; charset=utf-8",
  };

  return mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function fileResponse(filePath: string, isAsset: boolean): Response {
  try {
    const data = fs.readFileSync(filePath);
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": getMimeType(filePath),
        "Content-Length": String(data.length),
        "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export function indexResponse(indexHtmlPath: string): Response {
  try {
    const html = fs.readFileSync(indexHtmlPath, "utf-8");
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response("<h1>UI not built. Run: pnpm build:ui</h1>", {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
