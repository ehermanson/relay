/**
 * Local images in an `html_render` page, inlined as `data:` URLs at publish.
 *
 * The framed page has an opaque origin and can't reach the filesystem, so an
 * absolute path an agent wrote (a screenshot it just took, a generated plot)
 * would otherwise be a broken image. References are absolute paths, or
 * `file://` URLs, inside quotes (`src="…"`, JS strings) or CSS `url(…)`, ending
 * in an image extension. The file's bytes must be an image, not just its
 * name, so a renamed or symlinked non-image can't be copied into a page.
 */
import { open, stat } from "node:fs/promises";

export const HTML_RENDER_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** The stored page, with images inlined. The HTML the agent sends has its own, smaller cap. */
export const HTML_RENDER_MAX_PAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// `/path` (not `//host`), `C:\path` or `C:/path`, optionally as a file:// URL.
const ABSOLUTE_PATH = String.raw`(?:file://)?(?:/(?!/)|[a-z]:[\\/])`;
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);
// A srcset value is a comma-separated list of `url [descriptor]` candidates.
const SRCSET_PATTERN = /\bsrcset\s*=\s*(["'])((?:(?!\1)[^\r\n]){0,8192})\1/dgi;
const SRCSET_CANDIDATE = new RegExp(
  String.raw`(?:^|,)\s*(${ABSOLUTE_PATH}[^\s,]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))(?=[\s,]|$)`,
  "gid",
);

/** A page refers to images that can't be inlined. Messages are written for the agent. */
export class HtmlRenderImageError extends Error {}

interface Reference {
  start: number;
  end: number;
  reference: string;
}

function findLocalImages(html: string): Reference[] {
  const srcsetSpans: Array<[number, number]> = [];
  const srcsetRefs: Reference[] = [];
  for (const match of html.matchAll(SRCSET_PATTERN)) {
    const span = match.indices?.[2];
    if (!span) continue;
    srcsetSpans.push(span);
    const value = html.slice(span[0], span[1]);
    for (const candidate of value.matchAll(SRCSET_CANDIDATE)) {
      const at = candidate.indices?.[1];
      if (!at) continue;
      srcsetRefs.push({
        start: span[0] + at[0],
        end: span[0] + at[1],
        reference: value.slice(at[0], at[1]),
      });
    }
  }
  const others = Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    if (!span) return [];
    // A srcset list is read candidate by candidate above, never as one path.
    if (srcsetSpans.some(([start, end]) => span[0] < end && span[1] > start)) return [];
    return [{ start: span[0], end: span[1], reference: html.slice(span[0], span[1]) }];
  });
  return [...others, ...srcsetRefs].sort((a, b) => a.start - b.start);
}

/** The path on disk: file:// URLs are decoded, and escaped backslashes in JS strings collapse. */
function filePathFor(reference: string): string {
  let path = reference;
  if (path.startsWith("file://")) {
    path = path.slice("file://".length);
    try {
      path = decodeURIComponent(path);
    } catch {
      // Not percent-encoded; use it as written.
    }
  }
  return /^[a-z]:/i.test(path) ? path.replaceAll("\\\\", "\\") : path;
}

function mimeTypeFor(reference: string): string {
  return (
    IMAGE_MIME_TYPES[reference.slice(reference.lastIndexOf(".") + 1).toLowerCase()] ??
    "application/octet-stream"
  );
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Validate bytes, not file names. */
export function isImageBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
}

function after(text: string, token: string, from: number): number {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
}

/** The first element is `<svg`, after any XML declaration, comments, and doctype. */
function hasSvgRoot(text: string): boolean {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
}

function afterDoctype(text: string, from: number): number {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
}

const formatMib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Read at most `limit + 1` bytes, so a file that grew after `stat` is still caught. */
async function readBounded(path: string, limit: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/**
 * Replace every local image reference with a `data:` URL. Throws
 * `HtmlRenderImageError` when an image is missing, not an image, too large,
 * or would push the page past its limit — the agent fixes the page and calls
 * again, rather than the user seeing a broken image.
 */
export async function inlineLocalImages(html: string): Promise<string> {
  const references = findLocalImages(html);
  if (references.length === 0) return html;

  const unique = [...new Set(references.map((ref) => ref.reference))];
  const missing: string[] = [];
  const unreadable: string[] = [];
  const notImages: string[] = [];
  const dataUris = new Map<string, string>();
  let pageBytes = Buffer.byteLength(html);
  for (const reference of unique) {
    const path = filePathFor(reference);
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => error);
    if (info instanceof Error) {
      const absent = info.code === "ENOENT" || info.code === "ENOTDIR";
      (absent ? missing : unreadable).push(reference);
      continue;
    }
    if (!info.isFile()) {
      notImages.push(reference);
      continue;
    }
    if (info.size > HTML_RENDER_MAX_IMAGE_BYTES) {
      throw new HtmlRenderImageError(
        `${reference} is ${formatMib(info.size)}; each local image must be at most ${formatMib(HTML_RENDER_MAX_IMAGE_BYTES)}. Use a smaller image.`,
      );
    }
    const bytes = await readBounded(path, HTML_RENDER_MAX_IMAGE_BYTES).catch(() => undefined);
    if (!bytes) {
      unreadable.push(reference);
      continue;
    }
    if (bytes.byteLength > HTML_RENDER_MAX_IMAGE_BYTES) {
      throw new HtmlRenderImageError(
        `${reference} is over ${formatMib(HTML_RENDER_MAX_IMAGE_BYTES)}; use a smaller image.`,
      );
    }
    if (!isImageBytes(bytes)) {
      notImages.push(reference);
      continue;
    }
    const uri = `data:${mimeTypeFor(reference)};base64,${Buffer.from(bytes).toString("base64")}`;
    const uses = references.filter((ref) => ref.reference === reference).length;
    pageBytes += uses * (uri.length - Buffer.byteLength(reference));
    if (pageBytes > HTML_RENDER_MAX_PAGE_BYTES) {
      throw new HtmlRenderImageError(
        `With its images inlined the page is over ${formatMib(HTML_RENDER_MAX_PAGE_BYTES)}. Use fewer or smaller images.`,
      );
    }
    dataUris.set(reference, uri);
  }
  if (missing.length > 0 || unreadable.length > 0 || notImages.length > 0) {
    const parts = [
      missing.length > 0 ? `Images not found: ${missing.join(", ")}.` : "",
      unreadable.length > 0 ? `Can't read: ${unreadable.join(", ")}.` : "",
      notImages.length > 0 ? `Not image files: ${notImages.join(", ")}.` : "",
    ];
    throw new HtmlRenderImageError(
      `${parts.filter(Boolean).join(" ")} Use absolute paths to existing image files.`,
    );
  }

  let out = "";
  let at = 0;
  for (const ref of references) {
    out += html.slice(at, ref.start) + dataUris.get(ref.reference)!;
    at = ref.end;
  }
  return out + html.slice(at);
}
