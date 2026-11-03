import { useEffect, useRef, useState } from "react";
import { ExternalLink, PanelTop } from "lucide-react";
import {
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_SIZE_MESSAGE,
  HTML_RENDER_THEME_MESSAGE,
  HTML_RENDER_THEME_TOKENS,
  htmlRenderThemeFragment,
  htmlRenderUrl,
  type HtmlRenderReference,
  type HtmlRenderTheme,
} from "@shared/html-render";
import { getHtmlRenderHeight, setHtmlRenderHeight } from "@/lib/html-render-heights";
import { useTheme } from "@/stores/theme-store";

/** Relay's live theme, resolved from the document, under the page-facing names. */
function readHtmlRenderTheme(appearance: "light" | "dark"): HtmlRenderTheme {
  const style = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const [page, relay] of HTML_RENDER_THEME_TOKENS) {
    const value = style.getPropertyValue(relay).trim();
    if (value) variables[page] = value;
  }
  return { appearance, variables };
}

/**
 * A page an agent showed with `html_render`. The iframe has no same-origin
 * access (the server's CSP sandboxes it too), so the page can't reach
 * Relay's cookies or API. It gets the live theme through its URL fragment
 * before first paint and by message on a theme switch, and reports its own
 * height so the frame never scrolls inside the chat.
 */
export function HtmlRenderCard({
  instanceId,
  render,
}: {
  instanceId: string;
  render: HtmlRenderReference;
}) {
  const { theme } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The first URL is kept: a new fragment would reload the page.
  const [src] = useState(
    () =>
      htmlRenderUrl(instanceId, render.id) + htmlRenderThemeFragment(readHtmlRenderTheme(theme)),
  );
  const [contentHeight, setContentHeight] = useState(() => getHtmlRenderHeight(render.id));

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type !== HTML_RENDER_SIZE_MESSAGE || typeof data.height !== "number") return;
      if (!Number.isFinite(data.height)) return;
      const height = Math.min(
        HTML_RENDER_MAX_FIT_HEIGHT,
        Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(data.height)),
      );
      setHtmlRenderHeight(render.id, height);
      setContentHeight(height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [render.id]);

  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(
      { type: HTML_RENDER_THEME_MESSAGE, theme: readHtmlRenderTheme(theme) },
      "*",
    );
  };
  // Theme switches restyle the page in place. Reading the document in an
  // effect sees the new theme's values, which are applied before paint.
  useEffect(postTheme, [theme]);

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted">
        <PanelTop size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{render.title}</span>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-muted transition-colors hover:text-text max-[768px]:min-h-10 max-[768px]:px-2"
          aria-label={`Open ${render.title} in a new tab`}
        >
          <ExternalLink size={12} />
          <span className="max-[768px]:hidden">Open</span>
        </a>
      </div>
      <iframe
        ref={frameRef}
        src={src}
        title={render.title}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        loading="lazy"
        onLoad={postTheme}
        className="block w-full border-0 bg-transparent"
        style={{ height: contentHeight ?? render.height }}
      />
    </div>
  );
}
