import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ListChecks } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "../../lib/markdown";
import { openNativePath } from "../../lib/api";
import { FileIcon } from "@/components/ui/file-icon";
import { videoContentType } from "@shared/video-attachments";

interface MarkdownContentProps {
  text: string;
}

// Convert [Image: source: /path/to/file.png] → markdown image syntax
export const IMAGE_PATTERN = /\[Image: source: ([^\]]+)\]/g;

// Convert [File: source: /path/to/file.pdf] → relay-file-attachment link
// (rendered as a chip with file icon + filename, opens via /api/file in a new tab)
export const FILE_PATTERN = /\[File: source: ([^\]]+)\]/g;

function preprocessAttachments(text: string): string {
  return text
    .replace(IMAGE_PATTERN, (_match, filePath: string) => {
      const encoded = encodeURIComponent(filePath.trim());
      return `![Image](/api/file?path=${encoded})`;
    })
    .replace(FILE_PATTERN, (_match, filePath: string) => {
      const trimmed = filePath.trim();
      const basename = trimmed.split("/").pop() || trimmed;
      return `[${basename}](relay-file-attachment:${encodeURIComponent(trimmed)})`;
    });
}

// ── Remark plugin: convert @mentions and /skill chips in text nodes into link nodes ──
// Operates on the parsed mdast tree so it never touches text inside links,
// code blocks, or inline code — only bare prose text nodes.

// Matches @file/@task mentions OR /skill-name tokens, both requiring word boundaries.
// Group 1: leading whitespace. Group 2: @mention token. Group 3: /skill name (no slash).
const TOKEN_AST_RE =
  /((?:^|\s))(?:@(task:[a-f0-9]{8}(?::[^\s@]*)?|[^\s@]+)|\/((?=[a-zA-Z])[\w-]+))(?=\s|$)/g;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdastNode = any;

function remarkMentions() {
  return (tree: MdastNode) => {
    walkMentions(tree, false);
  };
}

function walkMentions(node: MdastNode, insideLink: boolean): void {
  if (!node.children) return;

  const next: MdastNode[] = [];
  for (const child of node.children as MdastNode[]) {
    if (child.type === "text" && !insideLink) {
      const parts = splitTokenText(child.value as string);
      next.push(...parts);
    } else {
      walkMentions(child, insideLink || child.type === "link");
      next.push(child);
    }
  }
  node.children = next;
}

function splitTokenText(text: string): MdastNode[] {
  const result: MdastNode[] = [];
  let last = 0;

  for (const m of text.matchAll(TOKEN_AST_RE)) {
    const leading = m[1] ?? "";
    const mentionToken = m[2]; // defined for @mentions
    const skillName = m[3]; // defined for /skill tokens
    const tokenPos = (m.index ?? 0) + leading.length;

    if (tokenPos > last) {
      result.push({ type: "text", value: text.slice(last, tokenPos) });
    }

    if (mentionToken !== undefined) {
      const url = mentionToken.startsWith("task:")
        ? `relay-task-mention:${mentionToken.slice(5)}`
        : `relay-file-mention:${mentionToken}`;
      result.push({ type: "link", url, children: [{ type: "text", value: mentionToken }] });
      last = tokenPos + 1 + mentionToken.length; // skip @ + token
    } else if (skillName !== undefined) {
      result.push({
        type: "link",
        url: `relay-skill-mention:${skillName}`,
        children: [{ type: "text", value: skillName }],
      });
      last = tokenPos + 1 + skillName.length; // skip / + skillName
    }
  }

  if (last < text.length) {
    result.push({ type: "text", value: text.slice(last) });
  }

  return result.length > 0 ? result : [{ type: "text", value: text }];
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // The app viewport disables pinch-zoom (user-scalable=no) for an app-like
  // feel, which also blocks zoom gestures on the fullscreen image. Relax it
  // while the lightbox is open so native pinch-zoom works; restoring the
  // original content on close also snaps the page back to scale 1.
  useEffect(() => {
    const viewport = document.querySelector('meta[name="viewport"]');
    const original = viewport?.getAttribute("content");
    if (!viewport || !original) return;
    viewport.setAttribute("content", "width=device-width, initial-scale=1.0, viewport-fit=cover");
    return () => viewport.setAttribute("content", original);
  }, []);

  // Portal to document.body so it escapes overflow-hidden / transform parents
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex cursor-pointer flex-col bg-black/80 backdrop-blur-md pt-[env(safe-area-inset-top,0px)] pr-[env(safe-area-inset-right,0px)] pb-[env(safe-area-inset-bottom,0px)] pl-[env(safe-area-inset-left,0px)]"
      onClick={onClose}
    >
      {/* The close button gets its own row rather than being absolutely
          positioned over the image — a centered image large enough to reach
          the top corner would otherwise sit on top of it and swallow taps. */}
      <div className="flex shrink-0 justify-end p-3">
        <button
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white sm:h-9 sm:w-9"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>
      {/* Link to the raw image: the lightbox fits the image to the viewport
          (so browser page-zoom just re-fits it), while the browser's native
          image viewer in a new tab gives real zoom with no custom UI. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          title="Open full size in new tab"
          className="flex min-h-0 max-w-full items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={src}
            alt={alt}
            className="max-w-full rounded-xl object-contain shadow-2xl max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-6rem)]"
          />
        </a>
      </div>
    </div>,
    document.body,
  );
}

export function ImageThumbnail({
  src,
  alt,
  hideOnError,
  node: _,
  ...rest
}: React.ComponentProps<"img"> & { node?: unknown; hideOnError?: boolean }) {
  const [lightbox, setLightbox] = useState(false);
  const [error, setError] = useState(false);

  if (!src || error) {
    if (hideOnError) return null;
    return <span className="text-xs italic text-muted">[Image: failed to load]</span>;
  }

  return (
    <>
      <img
        src={src}
        alt={alt || "Image"}
        className="inline-block h-[120px] w-[120px] object-cover cursor-pointer rounded-lg border border-border transition-all hover:border-accent hover:shadow-md"
        onClick={() => setLightbox(true)}
        onError={() => setError(true)}
        {...rest}
      />
      {lightbox && (
        <ImageLightbox src={src} alt={alt || "Image"} onClose={() => setLightbox(false)} />
      )}
    </>
  );
}

function CopyButton({ preRef }: { preRef: React.RefObject<HTMLPreElement | null> }) {
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleCopy = () => {
    const code = preRef.current?.querySelector("code");
    const text = code?.textContent || preRef.current?.textContent || "";
    navigator.clipboard.writeText(text).then(
      () => {
        if (!btnRef.current) return;
        btnRef.current.textContent = "Copied!";
        btnRef.current.classList.add("copied");
        setTimeout(() => {
          if (!btnRef.current) return;
          btnRef.current.textContent = "Copy";
          btnRef.current.classList.remove("copied");
        }, 1500);
      },
      () => {
        if (!btnRef.current) return;
        btnRef.current.textContent = "Failed";
        setTimeout(() => {
          if (!btnRef.current) return;
          btnRef.current.textContent = "Copy";
        }, 1500);
      },
    );
  };

  return (
    <button ref={btnRef} className="code-copy-btn" onClick={handleCopy}>
      Copy
    </button>
  );
}

function CodeBlock({
  className,
  children,
  ...props
}: React.ComponentProps<"code"> & { node?: unknown }) {
  const { node: _, ...rest } = props;
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1];
  const code = String(children).replace(/\n$/, "");

  if (!match) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }

  let highlighted: string;
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(code, { language: lang }).value;
    } catch {
      highlighted = code;
    }
  } else {
    highlighted = code;
  }

  // ReactMarkdown already wraps fenced code in <pre>, so just return <code>
  return (
    <code
      className={`hljs${lang ? ` language-${lang}` : ""}`}
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}

function PreBlock({
  children,
  node: _,
  ...rest
}: React.ComponentProps<"pre"> & { node?: unknown }) {
  const preRef = useRef<HTMLPreElement>(null);

  return (
    <pre ref={preRef} {...rest}>
      {children}
      <CopyButton preRef={preRef} />
    </pre>
  );
}

function parseNativeFileHref(
  href: string,
): { path: string; line?: number; column?: number } | null {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("/api/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(href)
  ) {
    if (!href.startsWith("file://")) return null;
  }

  let rawPath = href;
  let hash = "";

  if (href.startsWith("file://")) {
    const url = new URL(href);
    rawPath = decodeURIComponent(url.pathname);
    hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (/^\/[A-Za-z]:\//.test(rawPath)) {
      rawPath = rawPath.slice(1);
    }
  } else {
    if (!(href.startsWith("/") || /^[A-Za-z]:[\\/]/.test(href))) {
      return null;
    }
    const hashIndex = href.indexOf("#");
    if (hashIndex >= 0) {
      rawPath = href.slice(0, hashIndex);
      hash = href.slice(hashIndex + 1);
    }
  }

  const path = decodeURIComponent(rawPath);
  const lineMatch = hash.match(/^L(\d+)(?:C(\d+))?$/i);
  return {
    path,
    line: lineMatch ? Number.parseInt(lineMatch[1], 10) : undefined,
    column: lineMatch?.[2] ? Number.parseInt(lineMatch[2], 10) : undefined,
  };
}

function MentionChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-accent/8 px-1.5 py-px align-middle text-[0.75rem] font-medium leading-tight text-text">
      {children}
    </span>
  );
}

function MarkdownLink({
  href = "",
  children,
  ...props
}: React.ComponentProps<"a"> & { node?: unknown }) {
  if (href.startsWith("relay-file-attachment:")) {
    const encodedPath = href.slice("relay-file-attachment:".length);
    let path: string;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      path = encodedPath;
    }
    const basename = path.split("/").pop() || path;
    const url = `/api/file?path=${encodeURIComponent(path)}`;
    if (videoContentType(path)) {
      return (
        <span className="inline-flex max-w-full flex-col gap-1 align-middle">
          <video
            src={url}
            aria-label={basename}
            controls
            playsInline
            preload="metadata"
            className="max-h-80 max-w-full rounded-lg border border-border bg-black"
          />
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-[0.8125rem]">
            {basename}
          </a>
        </span>
      );
    }
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-surface-hover/40 px-2 py-1 align-middle text-[0.8125rem] font-medium text-text no-underline hover:border-border hover:bg-surface-hover"
      >
        <FileIcon path={path} size={14} className="h-3.5 w-3.5" />
        <span className="max-w-[16rem] truncate">{basename}</span>
      </a>
    );
  }

  if (href.startsWith("relay-file-mention:")) {
    const path = href.slice("relay-file-mention:".length);
    const basename = path.split("/").pop() || path;
    return (
      <MentionChip>
        <FileIcon path={path} size={12} className="h-3 w-3" />
        <span className="max-w-[12rem] truncate">{basename}</span>
      </MentionChip>
    );
  }

  if (href.startsWith("relay-task-mention:")) {
    const encoded = href.slice("relay-task-mention:".length);
    // encoded is "taskId" or "taskId:EncodedTitle"
    const colonIdx = encoded.indexOf(":");
    let title: string;
    if (colonIdx === -1) {
      title = encoded;
    } else {
      try {
        title = decodeURIComponent(encoded.slice(colonIdx + 1));
      } catch {
        title = encoded.slice(colonIdx + 1);
      }
    }
    return (
      <MentionChip>
        <ListChecks size={12} className="h-3 w-3 shrink-0 text-muted" />
        <span className="text-muted">task:</span>
        <span className="max-w-[12rem] truncate">{title}</span>
      </MentionChip>
    );
  }

  if (href.startsWith("relay-skill-mention:")) {
    const name = href.slice("relay-skill-mention:".length);
    return (
      <MentionChip>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3 w-3 shrink-0 text-muted"
        >
          <path d="M22 2 2 22" />
        </svg>
        <span className="max-w-[12rem] truncate">{name}</span>
      </MentionChip>
    );
  }

  const nativeTarget = parseNativeFileHref(href);

  if (nativeTarget) {
    return (
      <a
        href={href}
        {...props}
        onClick={async (event) => {
          event.preventDefault();
          try {
            await openNativePath(nativeTarget);
          } catch {
            // Keep the link inert on failure instead of routing the SPA to a filesystem-looking path.
          }
        }}
      >
        {children}
      </a>
    );
  }

  const external = /^https?:\/\//i.test(href);
  const isAnchor = href.startsWith("#");
  return (
    <a
      href={href}
      {...props}
      target={external ? "_blank" : props.target}
      rel={external ? "noreferrer" : props.rel}
      onClick={
        !external && !isAnchor
          ? (e) => {
              // Relative links would navigate the SPA to a bogus route — just suppress.
              e.preventDefault();
            }
          : undefined
      }
    >
      {children}
    </a>
  );
}

const REMARK_PLUGINS = [remarkGfm, remarkMentions];
const MD_COMPONENTS = {
  code: CodeBlock,
  pre: PreBlock,
  img: ImageThumbnail,
  a: MarkdownLink,
};

export const MarkdownContent = memo(function MarkdownContent({ text }: MarkdownContentProps) {
  const processed = useMemo(() => preprocessAttachments(text), [text]);

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={MD_COMPONENTS}
        urlTransform={(url) => (url.startsWith("relay-") ? url : defaultUrlTransform(url))}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
});
