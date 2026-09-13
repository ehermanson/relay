import { videoContentType } from "@shared/video-attachments";
import type { ProviderModelOption } from "@shared/types";

export const SLASH_COMMANDS = [
  {
    id: "model",
    title: "/model",
    description: "Switch the model used for the next turn",
    category: "Relay Commands",
  },
  {
    id: "effort",
    title: "/effort",
    description: "Set the reasoning effort level",
    category: "Relay Commands",
  },
] as const;

export type ComposerCommandPrefix = "/" | "$";

interface CommandContext {
  prefix: ComposerCommandPrefix;
  commandQuery: string;
  argQuery: string;
  hasArgument: boolean;
}

export interface SlashMenuItem {
  key: string;
  category: string;
  title: string;
  description: string;
  commandText?: string;
  hint?: string;
  actionHint?: string;
  accent?: boolean;
  onSelect: () => void;
}

export type MentionEntry =
  | { kind: "file" | "directory"; path: string }
  | {
      kind: "task";
      taskId: string;
      title: string;
      description: string;
      priority: number;
      type: string;
    };

export function mentionEntryKey(entry: MentionEntry): string {
  return entry.kind === "task" ? `task:${entry.taskId}` : entry.path;
}

/**
 * A staged composer attachment. `kind: "image"` renders inline as a thumbnail
 * (and as `<img>` in the transcript); `kind: "file"` renders as a clickable
 * file chip. Videos have a playable preview and are sent as files.
 */
export interface FileAttachment {
  file: File;
  kind: "image" | "video" | "file";
  preview?: string;
}

// Allowlist of non-image MIME types and extensions accepted as file attachments.
// Mirrors the server's `ALLOWED_MIMES` / `ALLOWED_EXTS` in server/routes/uploads.ts.
const FILE_MIME_ALLOWLIST = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/sql",
  "application/x-sql",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "text/yaml",
  "text/x-diff",
  "text/x-patch",
]);

const FILE_EXT_ALLOWLIST = new Set([
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

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function classifyAttachment(file: File): "image" | "video" | "file" | null {
  if (videoContentType(file.name, file.type)) return "video";
  if (file.type.startsWith("image/")) return "image";
  const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (FILE_MIME_ALLOWLIST.has(mime)) return "file";
  // Browsers don't always set a useful Content-Type for dragged files (e.g.
  // .log, .md). Fall back to extension matching.
  if (FILE_EXT_ALLOWLIST.has(fileExtension(file.name))) return "file";
  return null;
}

export function getCommandContext(text: string): CommandContext | null {
  const normalized = text.trimStart();
  const prefix = normalized[0] as ComposerCommandPrefix | undefined;
  if ((prefix !== "/" && prefix !== "$") || normalized.includes("\n")) return null;

  const body = normalized.slice(1);
  const firstWhitespace = body.search(/\s/);
  if (firstWhitespace === -1) {
    return {
      prefix,
      commandQuery: body.toLowerCase(),
      argQuery: "",
      hasArgument: false,
    };
  }

  return {
    prefix,
    commandQuery: body.slice(0, firstWhitespace).toLowerCase(),
    argQuery: body
      .slice(firstWhitespace + 1)
      .trimStart()
      .toLowerCase(),
    hasArgument: true,
  };
}

export function matchesQuery(query: string, values: readonly string[]): boolean {
  if (!query) return true;
  return values.some((value) => value.includes(query));
}

export function buildModelLabelLookup(models: readonly ProviderModelOption[]): Map<string, string> {
  return new Map(models.map((model) => [model.id, model.label]));
}
