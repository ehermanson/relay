/**
 * Inline HTML pages an agent shows in its chat (`html_render` on Relay's MCP
 * server): a finished chart, diagram, or mockup rendered above its reply.
 *
 * fs-free and shared with the UI (`@shared/html-render`). The server stores
 * each page as a file, records a `html_render` system event (so it replays
 * like a model-switch divider, for every provider), and serves the page
 * sandboxed. The UI frames it in an iframe with no same-origin access, hands
 * it Relay's live theme, and fits the frame to the page's reported height.
 */

/** `SystemEventMessage.event` (and `session_events.event`) for a published page. */
export const HTML_RENDER_EVENT = "html_render";

export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_DEFAULT_HEIGHT = 360;
/**
 * The frame follows the page's own height up to this. It only stops a page
 * that grows with its frame (viewport heights are rejected at publish).
 */
export const HTML_RENDER_MAX_FIT_HEIGHT = 20_000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
/** Pages are self-contained but small; images belong on disk or a URL. */
export const HTML_RENDER_MAX_BYTES = 1024 * 1024;

/** Messages between the framed page and the chat (`window.postMessage`). */
export const HTML_RENDER_SIZE_MESSAGE = "relay-html-render:size";
export const HTML_RENDER_THEME_MESSAGE = "relay-html-render:theme";
const THEME_FRAGMENT_KEY = "relay-theme";

/** What a `html_render` event carries; the page itself lives on disk. */
export interface HtmlRenderReference {
  id: string;
  title: string;
  height: number;
}

const RENDER_ID_PATTERN = /^[a-f0-9-]{36}$/;

export function isHtmlRenderId(value: unknown): value is string {
  return typeof value === "string" && RENDER_ID_PATTERN.test(value);
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

/** Reads a reference from a system event payload; anything malformed is dropped. */
export function readHtmlRenderReference(payload: unknown): HtmlRenderReference | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { id, title, height } = payload as Record<string, unknown>;
  if (!isHtmlRenderId(id)) return undefined;
  return {
    id,
    title:
      (typeof title === "string" ? title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) : "") ||
      "HTML",
    height: clampHtmlRenderHeight(
      typeof height === "number" && Number.isFinite(height) ? height : HTML_RENDER_DEFAULT_HEIGHT,
    ),
  };
}

/** URL the chat frames (and opens in a new tab). Same-origin, cookie-authenticated. */
export function htmlRenderUrl(instanceId: string, renderId: string): string {
  return `/api/html-renders/${encodeURIComponent(instanceId)}/${encodeURIComponent(renderId)}`;
}

/**
 * Served with every page. `sandbox` without `allow-same-origin` gives the page
 * an opaque origin even when opened directly in a tab, so its scripts can't
 * read Relay's cookies or call its API. Popups may escape the sandbox so
 * ordinary links open as normal pages.
 */
export const HTML_RENDER_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

// ── Validation ──────────────────────────────────────────────────────

// Check only stylesheets and style attributes; skip comments whole. Unclosed
// comments, tags, or quotes run to EOF so the scan stays linear.
const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64 runs, such as an inlined image containing "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

/**
 * The first viewport-height length in the page's CSS, if any. The frame grows
 * to fit the page, so a height that follows the viewport grows it forever.
 */
export function findViewportHeightUnit(html: string): string | undefined {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    const css = sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const found = VIEWPORT_HEIGHT_UNIT.exec(css)?.[0];
    if (found !== undefined) return found;
  }
  return undefined;
}

// ── Theme ───────────────────────────────────────────────────────────

/**
 * Variables a page styles itself with, and the Relay token each one reads.
 * The UI resolves the live values from the document, so pages follow the
 * user's theme (and a theme switch) without Relay's own token names leaking
 * into agent-written pages.
 */
export const HTML_RENDER_THEME_TOKENS: ReadonlyArray<readonly [page: string, relay: string]> = [
  ["--background", "--color-bg"],
  ["--foreground", "--color-text"],
  ["--foreground-strong", "--color-text-bright"],
  ["--muted", "--color-muted"],
  ["--surface", "--color-surface-raised"],
  ["--surface-hover", "--color-surface-hover"],
  ["--border", "--color-border"],
  ["--accent", "--color-accent"],
  ["--accent-surface", "--color-accent-dim"],
  ["--success", "--color-success"],
  ["--warning", "--color-warning"],
  ["--warning-surface", "--color-warning-dim"],
  ["--error", "--color-error"],
  ["--error-surface", "--color-error-dim"],
  ["--info", "--color-tool-use-text"],
  ["--code-background", "--color-pre-bg"],
  ["--chart-1", "--color-chart-1"],
  ["--chart-2", "--color-chart-2"],
  ["--chart-3", "--color-chart-3"],
  ["--chart-4", "--color-chart-4"],
  ["--chart-5", "--color-chart-5"],
  ["--chart-6", "--color-chart-6"],
  ["--chart-7", "--color-chart-7"],
  ["--chart-8", "--color-chart-8"],
];

export interface HtmlRenderTheme {
  appearance: "light" | "dark";
  variables: Record<string, string>;
}

/**
 * Rarely seen: the UI always passes the live theme before first paint. Covers
 * every page-facing token, for a page opened outside the chat frame. Values
 * mirror app/src/index.css.
 */
const FALLBACK_THEMES: Record<"light" | "dark", Record<string, string>> = {
  dark: {
    "--background": "hsl(231 4% 12%)",
    "--foreground": "hsl(240 5% 84%)",
    "--foreground-strong": "hsl(0 0% 98%)",
    "--muted": "hsl(240 4% 46%)",
    "--surface": "hsl(231 4% 16%)",
    "--surface-hover": "hsl(231 4% 15%)",
    "--border": "hsl(240 13% 20%)",
    "--accent": "hsl(160 84% 39%)",
    "--accent-surface": "hsl(160 84% 39% / 0.1)",
    "--success": "hsl(160 84% 39%)",
    "--warning": "hsl(38 92% 50%)",
    "--warning-surface": "hsl(38 92% 50% / 0.1)",
    "--error": "hsl(0 91% 71%)",
    "--error-surface": "hsl(0 91% 71% / 0.08)",
    "--info": "hsl(213 94% 68%)",
    "--code-background": "hsl(240 10% 8%)",
    "--chart-1": "hsl(160 84% 39%)",
    "--chart-2": "hsl(255 92% 76%)",
    "--chart-3": "hsl(213 94% 68%)",
    "--chart-4": "hsl(38 92% 50%)",
    "--chart-5": "hsl(0 91% 71%)",
    "--chart-6": "hsl(329 86% 70%)",
    "--chart-7": "hsl(83 78% 55%)",
    "--chart-8": "hsl(198 93% 60%)",
  },
  light: {
    "--background": "hsl(0 0% 100%)",
    "--foreground": "hsl(218 17% 27%)",
    "--foreground-strong": "hsl(222 47% 11%)",
    "--muted": "hsl(220 9% 46%)",
    "--surface": "hsl(0 0% 100%)",
    "--surface-hover": "hsl(220 10% 96.5%)",
    "--border": "hsl(220 13% 91%)",
    "--accent": "hsl(161 94% 30%)",
    "--accent-surface": "hsl(161 94% 30% / 0.07)",
    "--success": "hsl(161 94% 30%)",
    "--warning": "hsl(32 95% 44%)",
    "--warning-surface": "hsl(32 95% 44% / 0.06)",
    "--error": "hsl(0 72% 51%)",
    "--error-surface": "hsl(0 72% 51% / 0.05)",
    "--info": "hsl(217 91% 60%)",
    "--code-background": "hsl(220 14% 97%)",
    "--chart-1": "hsl(160 84% 39%)",
    "--chart-2": "hsl(255 92% 76%)",
    "--chart-3": "hsl(213 94% 68%)",
    "--chart-4": "hsl(38 92% 50%)",
    "--chart-5": "hsl(0 91% 71%)",
    "--chart-6": "hsl(329 86% 70%)",
    "--chart-7": "hsl(83 78% 55%)",
    "--chart-8": "hsl(198 93% 60%)",
  },
};

const FIXED_VARIABLES: Record<string, string> = {
  "--radius": "0.5rem",
  "--font-sans": 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "--font-mono": '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};

export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

function rootRule(appearance: "light" | "dark", variables: Record<string, string>): string {
  const declarations = Object.entries({ ...FIXED_VARIABLES, ...variables })
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${appearance};${declarations}}`;
}

const BASE_CSS =
  "html{box-sizing:border-box;padding:8px;background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}" +
  // The frame fits the page, so only an in-chat page hides its scrollbar.
  "html[data-relay-framed]{scrollbar-width:none}html[data-relay-framed]::-webkit-scrollbar{display:none}" +
  "*,*::before,*::after{box-sizing:inherit}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

// ── Bootstrap ───────────────────────────────────────────────────────

/**
 * Runs first in every page. Stringified into a `<script>`, so it must stay
 * plain browser JavaScript with no closure over this module.
 */
function relayHtmlRenderBootstrap(
  fragmentKey: string,
  sizeMessage: string,
  themeMessage: string,
  baseCss: string,
  fixed: Record<string, string>,
) {
  const style = document.getElementById("relay-html-render-theme");
  const apply = (theme: unknown) => {
    if (!style || typeof theme !== "object" || theme === null) return;
    const { appearance, variables } = theme as { appearance?: unknown; variables?: unknown };
    if (typeof variables !== "object" || variables === null) return;
    let css = `:root{color-scheme:${appearance === "light" ? "light" : "dark"};`;
    const all = { ...fixed, ...(variables as Record<string, unknown>) };
    for (const name of Object.keys(all)) {
      if (/^--[a-z0-9-]+$/.test(name))
        css += `${name}:${String(all[name]).replace(/[;{}<>]/g, "")};`;
    }
    style.textContent = `${css}}${baseCss}`;
  };
  try {
    const match = new RegExp(`[#&]${fragmentKey}=([^&]*)`).exec(location.hash);
    if (match) apply(JSON.parse(decodeURIComponent(match[1]!)));
  } catch {
    // A malformed fragment keeps the fallback theme.
  }
  const framed = window.parent !== window;
  if (framed) document.documentElement.setAttribute("data-relay-framed", "");
  window.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; theme?: unknown } | null;
    if (framed && event.source === window.parent && data?.type === themeMessage) apply(data.theme);
  });
  // Links open as ordinary pages, outside the frame.
  document.addEventListener(
    "click",
    (event) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!link) return;
      let url: URL;
      try {
        url = new URL(link.getAttribute("href") ?? "", document.baseURI);
      } catch {
        return;
      }
      if (!/^https?:$/.test(url.protocol)) return;
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    },
    true,
  );
  if (!framed) return;
  let reported = -1;
  const report = () => {
    const root = document.documentElement;
    const height = Math.ceil(
      root.scrollHeight > root.clientHeight
        ? root.scrollHeight
        : root.getBoundingClientRect().height,
    );
    if (height === reported) return;
    reported = height;
    window.parent.postMessage({ type: sizeMessage, height }, "*");
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(report) : undefined;
  observer?.observe(document.documentElement);
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body) observer?.observe(document.body);
    report();
  });
  window.addEventListener("load", report);
}

function bootstrapMarkup(scan: string): string {
  const fallback =
    rootRule("dark", FALLBACK_THEMES.dark) +
    `@media (prefers-color-scheme: light){${rootRule("light", FALLBACK_THEMES.light)}}` +
    BASE_CSS;
  const args = [
    THEME_FRAGMENT_KEY,
    HTML_RENDER_SIZE_MESSAGE,
    HTML_RENDER_THEME_MESSAGE,
    BASE_CSS,
    FIXED_VARIABLES,
  ]
    .map((arg) => JSON.stringify(arg))
    .join(",");
  // `</` can't appear inside the inline script: it would close the tag early.
  const script = `(${relayHtmlRenderBootstrap.toString()})(${args});`.replace(/<\//g, "<\\/");
  return [
    /<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="relay-html-render-theme">${fallback}</style>`,
    `<script>${script}</script>`,
  ].join("");
}

/** Blank content that can't hold the bootstrap (scripts, comments, …) without shifting offsets. */
function blankNonMarkup(html: string): string {
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
}

/**
 * The stored page: the agent's HTML with the theme and bootstrap injected at
 * the top of `<head>`, so they apply before the page's own styles and paint.
 */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><html><head>${markup}</head><body>${html}</body></html>`;
}

// ── Agent guidance ──────────────────────────────────────────────────

export const HTML_RENDER_TOOL_DESCRIPTION = [
  "Show a finished, self-contained HTML page (chart, diagram, table, mockup) inline in this chat, above your reply. Do not describe or restate it afterwards.",
  "Inline all CSS and JavaScript; remote scripts, styles, fonts, and images load from their URLs (e.g. a charting library from a CDN). Local images by absolute path (in src, srcset, CSS url(), or a script string) are embedded when published, up to 10 MB each; other local files are not reachable.",
  "Frame width is the reply column (about 760px on desktop, 360px on phones); the frame grows to fit the page. Let content set the height: never use vh units or height:100% on html/body. Give charts fixed pixel heights.",
  "Leave html and body without a background, border, or outer card; Relay adds an 8px gutter. A box that needs its own background gets 16px padding and var(--radius) corners.",
  "Use the theme CSS variables, not fixed colors, so the page matches light and dark mode: --background, --foreground, --foreground-strong, --muted, --surface, --surface-hover, --border, --accent, --accent-surface, --success, --warning, --warning-surface, --error, --error-surface, --info, --code-background, --chart-1 to --chart-8, --radius, --font-sans, --font-mono. The base sheet already sets background, text color, and font.",
  "The page runs sandboxed: no cookies, storage, or access to Relay.",
].join(" ");
