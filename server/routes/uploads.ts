import { MAX_VIDEO_UPLOAD, VIDEO_MIME_BY_EXT, videoContentType } from "#core/video-attachments.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { homedir, tmpdir } from "node:os";
import type { Hono } from "hono";
import { relayDir } from "#core/config.js";
import { getMimeType, readBodyBuffer } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

// Content-Type -> file extension. Includes image types (rendered inline in
// the transcript) and file types (rendered as a clickable chip).
const ALLOWED_MIMES: Record<string, string> = {
  // videos
  ...Object.fromEntries(Object.entries(VIDEO_MIME_BY_EXT).map(([ext, mime]) => [mime, ext])),
  // images
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  // documents / structured text
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/yaml": ".yaml",
  "application/x-yaml": ".yaml",
  "application/sql": ".sql",
  "application/x-sql": ".sql",
  // text/*
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/xml": ".xml",
  "text/yaml": ".yaml",
  "text/x-diff": ".diff",
  "text/x-patch": ".patch",
};

const ALLOWED_EXTS = new Set([
  ...Object.keys(VIDEO_MIME_BY_EXT),
  // images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
  ".ico",
  // documents / structured text
  ".pdf",
  ".json",
  ".csv",
  ".md",
  ".txt",
  ".log",
  ".html",
  ".yaml",
  ".yml",
  ".xml",
  ".diff",
  ".patch",
  ".sql",
]);

const MAX_UPLOAD = 10 * 1024 * 1024;

export function registerUploadRoutes(app: Hono<AppEnv>, _: HttpDeps): void {
  app.post("/api/upload", async (c) => {
    // Content-Type from the browser may include a charset or boundary param —
    // strip everything after the first `;` before matching the allowlist.
    const rawContentType = c.req.header("content-type") || "";
    const contentType = rawContentType.split(";")[0]!.trim().toLowerCase();
    const ext = ALLOWED_MIMES[contentType];
    if (!ext) {
      return c.json({ error: "Unsupported file type" }, 400);
    }

    const limit = videoContentType(`upload${ext}`) ? MAX_VIDEO_UPLOAD : MAX_UPLOAD;
    const sizeError = `File too large (${limit / (1024 * 1024)}MB limit)`;
    const contentLength = parseInt(c.req.header("content-length") || "0", 10);
    if (contentLength > limit) {
      return c.json({ error: sizeError }, 413);
    }

    try {
      const body = await readBodyBuffer(c, limit);
      const uploadsDir = path.join(relayDir, "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      const filePath = path.join(uploadsDir, `${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(filePath, body);
      return c.json({ path: filePath });
    } catch (err) {
      if (err instanceof Error && err.message === "Body too large") {
        return c.json({ error: sizeError }, 413);
      }
      return c.json({ error: "Upload failed" }, 500);
    }
  });

  app.get("/api/file", (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing path parameter" }, 400);
    }

    const resolved = path.resolve(filePath);
    // Allow files under the home directory or the system temp dirs (agents
    // commonly write screenshots to /tmp).
    const allowedRoots = [homedir(), tmpdir(), "/tmp", "/private/tmp"];
    const allowed = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!allowed) {
      return c.json({ error: "Access denied: file must be under home or temp directory" }, 403);
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return c.json({ error: "File type not allowed" }, 400);
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return c.json({ error: "File not found" }, 404);
      const limit = videoContentType(resolved) ? MAX_VIDEO_UPLOAD : MAX_UPLOAD;
      if (stat.size > limit) {
        return c.json({ error: `File too large (${limit / (1024 * 1024)}MB limit)` }, 413);
      }
      if (videoContentType(resolved)) {
        const headers: Record<string, string> = {
          "Content-Type": getMimeType(resolved),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=3600",
        };
        const range = c.req.header("range");
        let start = 0;
        let end = stat.size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (match && (match[1] || match[2])) {
            start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
            end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          } else {
            start = stat.size;
          }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
            return new Response(null, {
              status: 416,
              headers: { ...headers, "Content-Range": `bytes */${stat.size}` },
            });
          }
          headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
        }
        headers["Content-Length"] = String(Math.max(0, end - start + 1));
        const body = stat.size
          ? (Readable.toWeb(
              fs.createReadStream(resolved, { start, end }),
            ) as ReadableStream<Uint8Array>)
          : null;
        return new Response(body, { status: range ? 206 : 200, headers });
      }
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    try {
      const data = fs.readFileSync(resolved);
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": getMimeType(resolved),
          "Content-Length": String(data.length),
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  });
}
