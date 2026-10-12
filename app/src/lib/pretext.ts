/**
 * Pretext integration for chat layout — bubble shrinkwrap + height estimation.
 *
 * Uses @chenglou/pretext to measure text layout via canvas.measureText()
 * instead of DOM reflow. Two use cases:
 *   1. Shrinkwrap: find tightest bubble width preserving line count
 *   2. Height estimation: predict row height before DOM render (virtualizer)
 */

import { prepare, layout, clearCache, type PreparedText } from "@chenglou/pretext";
import { estimateRetainedBytes } from "@/lib/inactive-chat-cache";
import { shouldSkipShrinkwrapForText } from "@/lib/message-rendering";

// ── Font constants matching CSS ─────────────────────────────────────
// text-sm = 0.875rem = 14px, leading-relaxed = 1.625, font-family: Outfit
const TEXT_FONT = '14px "Outfit", system-ui, sans-serif';
const TEXT_LINE_HEIGHT = 22.75; // 14 * 1.625
const PARAGRAPH_GAP = 9.1; // 0.65em * 14px (.markdown-content p margin-bottom)
const BUBBLE_CHROME = 18; // p-2 (16px) + border (2px)

// ── Text cleaning ───────────────────────────────────────────────────
const TERMINAL_RE = /<terminal_context[^>]*>[\s\S]*?<\/terminal_context>/g;
const IMAGE_RE = /\[Image: source: [^\]]+\]/g;
const FILE_RE = /\[File: source: [^\]]+\]/g;

function cleanUserText(raw: string): string {
  return raw.replace(TERMINAL_RE, "").replace(IMAGE_RE, "").replace(FILE_RE, "").trim();
}

// Block-level markdown that changes layout geometry
const MARKDOWN_BLOCK_RE = /^(#{1,4}\s|```|>\s|[-*+]\s|\d+\.\s)/m;
function isSimpleText(text: string): boolean {
  return !MARKDOWN_BLOCK_RE.test(text);
}

// ── Prepare cache ───────────────────────────────────────────────────
const MAX_PREPARED_BYTES = 2 * 1024 * 1024;
const MAX_PREPARED_ENTRIES = 1024;
const cache = new Map<string, { prepared: PreparedText; bytes: number }>();
let preparedBytes = 0;

export function getTextLayoutCacheStats() {
  return { preparedEntries: cache.size, estimatedBytes: preparedBytes };
}

function cachedPrepare(text: string): PreparedText {
  const cached = cache.get(text);
  if (cached) {
    cache.delete(text);
    cache.set(text, cached);
    return cached.prepared;
  }
  const prepared = prepare(text, TEXT_FONT);
  const bytes = estimateRetainedBytes([text, prepared], MAX_PREPARED_BYTES);
  if (bytes > MAX_PREPARED_BYTES) {
    // Pretext also caches token metrics/analysis internally. An oversized
    // one-off prompt must not remain there after its prepared result is used.
    clearCache();
    return prepared;
  }
  cache.set(text, { prepared, bytes });
  preparedBytes += bytes;
  let evicted = false;
  while (cache.size > MAX_PREPARED_ENTRIES || preparedBytes > MAX_PREPARED_BYTES) {
    const oldest = cache.keys().next().value!;
    preparedBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
    evicted = true;
  }
  if (evicted) clearCache();
  return prepared;
}

// ── Font readiness ──────────────────────────────────────────────────
let fontReady = false;

export function onFontReady(cb: () => void): () => void {
  if (fontReady) return () => {};
  const handler = () => {
    if (!fontReady) {
      fontReady = true;
      cache.clear();
      preparedBytes = 0;
      clearCache();
      cb();
    }
  };
  document.fonts.ready.then(handler);
  return () => {};
}

// ── Paragraph helpers ───────────────────────────────────────────────

function splitParagraphs(text: string): string[] {
  return text.split(/\n\n+/).filter(Boolean);
}

function layoutParagraphs(text: string, maxWidth: number): { height: number; lineCount: number } {
  const parts = splitParagraphs(text);
  if (parts.length === 0) return { height: 0, lineCount: 0 };

  let totalHeight = 0;
  let totalLines = 0;

  for (let i = 0; i < parts.length; i++) {
    const result = layout(cachedPrepare(parts[i]), maxWidth, TEXT_LINE_HEIGHT);
    totalHeight += result.height;
    totalLines += result.lineCount;
    if (i < parts.length - 1) totalHeight += PARAGRAPH_GAP;
  }

  return { height: totalHeight, lineCount: totalLines };
}

// ── Shrinkwrap ──────────────────────────────────────────────────────

/**
 * Compute the tightest bubble max-width (including padding/border) that
 * preserves line count. Returns undefined when shrinkwrap isn't applicable
 * (complex markdown, single-line, or savings < 12px).
 */
export function computeBubbleShrinkwrap(
  rawText: string,
  containerWidth: number,
): number | undefined {
  const text = cleanUserText(rawText);
  if (!text || !isSimpleText(text)) return undefined;
  if (shouldSkipShrinkwrapForText(text)) return undefined;

  const maxTextWidth = containerWidth * 0.8 - BUBBLE_CHROME;
  if (maxTextWidth <= 0) return undefined;

  const parts = splitParagraphs(text);
  if (parts.length === 0) return undefined;

  // Only shrinkwrap if at least one paragraph wraps (CSS handles single-line)
  let anyMultiLine = false;
  for (const part of parts) {
    if (layout(cachedPrepare(part), maxTextWidth, TEXT_LINE_HEIGHT).lineCount > 1) {
      anyMultiLine = true;
      break;
    }
  }
  if (!anyMultiLine) return undefined;

  // Binary search each paragraph for minimum width preserving line count
  let maxShrunk = 0;
  for (const part of parts) {
    const prepared = cachedPrepare(part);
    const target = layout(prepared, maxTextWidth, TEXT_LINE_HEIGHT).lineCount;

    let lo = 0;
    let hi = maxTextWidth;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (layout(prepared, mid, TEXT_LINE_HEIGHT).lineCount <= target) hi = mid;
      else lo = mid;
    }
    maxShrunk = Math.max(maxShrunk, hi);
  }

  // +4px safety margin for letter-spacing (-0.005em) discrepancy
  const result = Math.ceil(maxShrunk) + 4 + BUBBLE_CHROME;
  const maxBubbleWidth = containerWidth * 0.8;

  if (maxBubbleWidth - result < 12) return undefined;
  return result;
}

// ── Height estimation ───────────────────────────────────────────────

/**
 * Estimate user message row height using pretext layout.
 * Falls back to heuristic for complex markdown.
 */
export function estimateUserHeight(rawText: string, containerWidth: number): number {
  const text = cleanUserText(rawText);
  if (!text) return 44;

  const textWidth = containerWidth * 0.8 - BUBBLE_CHROME;
  if (textWidth <= 0) return 44;

  if (isSimpleText(text)) {
    const { height } = layoutParagraphs(text, textWidth);
    // text height + bubble chrome + timestamp row
    return Math.ceil(height) + BUBBLE_CHROME + 22;
  }

  // Heuristic fallback for markdown-heavy messages
  return 72 + Math.ceil(text.length / 80) * 20;
}
