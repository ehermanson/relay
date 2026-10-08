import { useMemo, useState } from "react";
import {
  TerminalSquare,
  ChevronDown,
  ChevronRight,
  FileText,
  Forward,
  ArrowRightFromLine,
  Slash,
  MessageSquareReply,
} from "lucide-react";
import { formatTimestamp } from "../../lib/utils";
import { classifyLargeUserText, type LargeUserRenderMode } from "@/lib/message-rendering";
import { Popover } from "../ui/popover";
import { MarkdownContent, ImageThumbnail, IMAGE_PATTERN } from "./markdown-content";

interface UserMessageProps {
  text: string;
  timestamp?: number;
  shrinkwrapWidth?: number;
  renderMode?: LargeUserRenderMode;
}

// ── Extractors ───────────────────────────────────────────────────────

const TERMINAL_CONTEXT_PATTERN =
  /<terminal_context(?:\s+source="([^"]*)")?\s*>\n?([\s\S]*?)\n?<\/terminal_context>/g;

const TASK_REFERENCE_PATTERN =
  /<task_reference\s+id="([^"]*)"\s+title="([^"]*)">([\s\S]*?)\n?<\/task_reference>/g;

const INLINE_REPLY_PATTERN =
  /<inline_reply>\s*<quote>\n?([\s\S]*?)\n?<\/quote>\n?([\s\S]*?)\n?<\/inline_reply>/g;

const SOURCE_FILES_PATTERN = /\n*<source_files>\n?([\s\S]*?)\n?<\/source_files>\n*/g;

interface TerminalBlock {
  source: string;
  text: string;
}

interface InlineReplyBlock {
  quote: string;
  reply: string;
}

/** Reverse XML entity escaping applied by expandTaskReferences. */
function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // must be last
}

function splitContent(text: string): {
  textPart: string;
  images: string[];
  terminalBlocks: TerminalBlock[];
  inlineReplies: InlineReplyBlock[];
  sourceFiles: string[];
} {
  const images: string[] = [];
  const terminalBlocks: TerminalBlock[] = [];
  const inlineReplies: InlineReplyBlock[] = [];
  const sourceFiles: string[] = [];

  let cleaned = text
    .replace(INLINE_REPLY_PATTERN, (_match, quote: string, reply: string) => {
      inlineReplies.push({ quote: quote.trim(), reply: reply.trim() });
      return "";
    })
    .replace(TERMINAL_CONTEXT_PATTERN, (_match, source: string | undefined, content: string) => {
      terminalBlocks.push({ source: source || "Terminal", text: content });
      return "";
    })
    .replace(SOURCE_FILES_PATTERN, (_match, body: string) => {
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) sourceFiles.push(trimmed);
      }
      return "\n\n";
    })
    .replace(TASK_REFERENCE_PATTERN, (_match, id: string, title: string) => {
      return `@task:${id}:${encodeURIComponent(unescapeXml(title))}`;
    })
    .replace(IMAGE_PATTERN, (_match, filePath: string) => {
      images.push(filePath.trim());
      return "";
    })
    .trim();

  return { textPart: cleaned, images, terminalBlocks, inlineReplies, sourceFiles };
}

// ── Slash command detection ──────────────────────────────────────────

/** Match a leading `/command` or `$command` token and optional trailing text. */
const SLASH_RE = /^([/$]\S+)(\s[\s\S]*)?$/;

function parseSlashCommand(text: string): { command: string; rest: string } | null {
  const m = text.match(SLASH_RE);
  if (!m) return null;
  return { command: m[1], rest: (m[2] ?? "").trim() };
}

function SlashCommandChip({ command }: { command: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-2.5 py-1 text-[0.8125rem] font-medium text-accent">
      <Slash size={14} className="opacity-60" />
      {command.slice(1)}
    </span>
  );
}

// ── Components ───────────────────────────────────────────────────────

function ImageRow({ images }: { images: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((filePath, i) => (
        <ImageThumbnail
          key={i}
          src={`/api/file?path=${encodeURIComponent(filePath)}`}
          alt="Image"
        />
      ))}
    </div>
  );
}

function InlineReplyQuote({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-accent/10 px-2 py-1.5">
      <MessageSquareReply size={11} className="mt-[3px] shrink-0 text-accent/70" />
      <div className="min-w-0 flex-1 whitespace-pre-wrap text-[0.75rem] italic leading-snug text-muted">
        {text}
      </div>
    </div>
  );
}

function SourceFilesAttachment({ files }: { files: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="flex items-center gap-1.5 self-end rounded-full border border-border/50 bg-surface-inset/60 px-2.5 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-surface-hover hover:text-text">
        <FileText size={11} className="shrink-0" />
        <span className="tabular-nums">
          {files.length} source file{files.length === 1 ? "" : "s"}
        </span>
      </Popover.Trigger>
      <Popover.Content side="top" align="end" className="max-w-[28rem] p-0">
        <div className="max-h-72 overflow-auto py-1.5">
          <ul className="flex flex-col">
            {files.map((path) => (
              <li
                key={path}
                className="px-3 py-1 font-mono text-[0.6875rem] leading-snug text-text/80"
              >
                {path}
              </li>
            ))}
          </ul>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

function TerminalAttachment({ block }: { block: TerminalBlock }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = block.text.split("\n").length;

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border/50 bg-surface-inset/60">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover/50"
      >
        <TerminalSquare size={12} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-text">
          {block.source}
        </span>
        <span className="text-[0.625rem] text-muted">
          {lineCount} line{lineCount !== 1 ? "s" : ""}
        </span>
        {expanded ? (
          <ChevronDown size={12} className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-muted" />
        )}
      </button>
      {expanded && (
        <pre className="max-h-48 overflow-auto border-t border-border/30 px-2.5 py-2 font-mono text-[0.625rem] leading-relaxed text-text/70">
          {block.text}
        </pre>
      )}
    </div>
  );
}

function CollapsedJsonMessage({
  text,
  lineCount,
  charCount,
  label,
}: {
  text: string;
  lineCount: number;
  charCount: number;
  label: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full rounded-xl border border-border/50 bg-surface-inset/45">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[0.75rem] text-muted transition-colors hover:bg-surface-hover/40"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-muted" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-muted" />
        )}
        <span className="font-medium text-text">{label}</span>
        <span className="tabular-nums">
          {lineCount} lines · {charCount.toLocaleString()} chars
        </span>
      </button>
      {open && (
        <pre className="max-h-96 overflow-auto border-t border-border/30 px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-text/80">
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}

export function UserMessage({ text, timestamp, shrinkwrapWidth, renderMode }: UserMessageProps) {
  const effectiveRenderMode = useMemo(() => {
    if (renderMode && renderMode.kind !== "markdown") return renderMode;
    if (text.length < 1_500) return renderMode;
    return classifyLargeUserText(text);
  }, [renderMode, text]);

  if (effectiveRenderMode?.kind === "json" || effectiveRenderMode?.kind === "text") {
    return (
      <div className={`flex max-w-[80%] flex-col items-end gap-1.5 self-end`}>
        <div className="w-full rounded-2xl rounded-br-sm border border-border/50 bg-user-bg p-2 text-user-text">
          <CollapsedJsonMessage
            text={effectiveRenderMode.formattedText ?? text}
            lineCount={effectiveRenderMode.lineCount ?? 0}
            charCount={effectiveRenderMode.charCount ?? text.length}
            label={
              effectiveRenderMode.kind === "json" ? "Large JSON payload" : "Large text payload"
            }
          />
        </div>
        <div className="flex items-center gap-1.5 px-1">
          {timestamp && (
            <span className="text-[0.625rem] text-muted/45">{formatTimestamp(timestamp)}</span>
          )}
        </div>
      </div>
    );
  }

  const { textPart, images, terminalBlocks, inlineReplies, sourceFiles } = useMemo(
    () => splitContent(text),
    [text],
  );
  const hasText = textPart.length > 0;
  const hasImages = images.length > 0;
  const hasTerminal = terminalBlocks.length > 0;
  const hasInlineReplies = inlineReplies.length > 0;
  const hasSourceFiles = sourceFiles.length > 0;

  // Detect spin-off messages, including the legacy handoff prefix for compatibility.
  const spinOffMatch = textPart.match(/^\[(?:Handoff|Spun off) from:\s+(.+?)\]\s*/);
  const spinOffSource = spinOffMatch?.[1] ?? null;
  const spinOffContent = spinOffSource ? textPart.slice(spinOffMatch![0].length) : null;

  // Detect relayed messages: [From: Chat Name] content
  const relayMatch = !spinOffSource ? textPart.match(/^\[From:\s+(.+?)\]\s*/) : null;
  const relaySource = relayMatch?.[1] ?? null;
  const relayContent = relaySource ? textPart.slice(relayMatch![0].length) : textPart;

  // Detect slash-command messages (e.g. "/simplify", "$skill-creator some args")
  const displayText = relaySource ? relayContent : textPart;
  const slashParsed = !relaySource && !spinOffSource ? parseSlashCommand(displayText) : null;

  // Spin-off messages get full-width card rendering
  if (spinOffSource && spinOffContent) {
    return (
      <div className="flex w-full flex-col gap-1.5">
        <div className="rounded-lg border border-accent/30 bg-accent/5">
          <div className="flex items-center gap-1.5 border-b border-accent/20 px-3 py-2">
            <ArrowRightFromLine size={12} className="shrink-0 text-accent" />
            <span className="text-[0.75rem] font-medium text-accent">
              Spun off from {spinOffSource}
            </span>
          </div>
          <div className="px-3 py-2.5 text-sm leading-relaxed text-text/80 max-[768px]:text-[16px]">
            <MarkdownContent text={spinOffContent} />
          </div>
        </div>
        {timestamp && (
          <span className="px-1 text-[0.625rem] text-muted/45">{formatTimestamp(timestamp)}</span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex max-w-[80%] flex-col items-end gap-1.5 self-end`}>
      {hasTerminal && (
        <div className="flex w-full flex-col gap-1.5">
          {terminalBlocks.map((block, i) => (
            <TerminalAttachment key={i} block={block} />
          ))}
        </div>
      )}
      {hasSourceFiles && <SourceFilesAttachment files={sourceFiles} />}
      {relaySource && (
        <div className="flex items-center gap-1 px-1 text-[0.6875rem] text-accent">
          <Forward size={11} />
          <span>From: {relaySource}</span>
        </div>
      )}
      {hasInlineReplies ? (
        <div
          className={`rounded-2xl rounded-br-sm border p-2 text-sm leading-relaxed max-[768px]:text-[16px] ${"border-border/50 bg-user-bg text-user-text"}`}
          style={shrinkwrapWidth ? { maxWidth: shrinkwrapWidth } : undefined}
        >
          <div className="flex flex-col gap-2.5">
            {inlineReplies.map((block, i) => (
              <div key={i} className="flex flex-col gap-1.5 border-l-2 border-accent/40 pl-2.5">
                <InlineReplyQuote text={block.quote} />
                {block.reply.length > 0 && <MarkdownContent text={block.reply} />}
              </div>
            ))}
            {hasText && (
              <div className="border-t border-border/40 pt-2">
                <MarkdownContent text={displayText} />
              </div>
            )}
          </div>
        </div>
      ) : hasText && slashParsed && !slashParsed.rest ? (
        <SlashCommandChip command={slashParsed.command} />
      ) : hasText && slashParsed?.rest ? (
        <div
          className={`rounded-2xl rounded-br-sm border p-2 text-sm leading-relaxed max-[768px]:text-[16px] ${"border-border/50 bg-user-bg text-user-text"}`}
          style={shrinkwrapWidth ? { maxWidth: shrinkwrapWidth } : undefined}
        >
          <div className="mb-1.5">
            <SlashCommandChip command={slashParsed.command} />
          </div>
          <MarkdownContent text={slashParsed.rest} />
        </div>
      ) : hasText ? (
        <div
          className={`rounded-2xl rounded-br-sm border p-2 text-sm leading-relaxed max-[768px]:text-[16px] ${
            relaySource
              ? "border-accent/30 bg-accent/5 text-user-text"
              : "border-border/50 bg-user-bg text-user-text"
          }`}
          style={shrinkwrapWidth ? { maxWidth: shrinkwrapWidth } : undefined}
        >
          <MarkdownContent text={displayText} />
        </div>
      ) : null}
      {hasImages && <ImageRow images={images} />}
      <div className="flex items-center gap-1.5 px-1">
        {timestamp && (
          <span className="text-[0.625rem] text-muted/45">{formatTimestamp(timestamp)}</span>
        )}
      </div>
    </div>
  );
}
