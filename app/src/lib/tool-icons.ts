/**
 * Shared utilities for chat message components.
 *
 * Centralizes tool icon mappings so ActivityEntry and LiveStatusStrip
 * use the same icons.
 */

import {
  Terminal,
  FileText,
  Pencil,
  FilePlus,
  FolderSearch,
  Search,
  Globe,
  GitBranch,
  MessageCircleQuestion,
  ClipboardCheck,
  ClipboardList,
  BookOpen,
  Send,
  UserPlus,
  UserMinus,
  Wrench,
  Image as ImageIcon,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";

// ── Tool icon registry ──────────────────────────────────────────────

/** Canonical icon for each tool name. */
export const TOOL_ICONS: Record<string, LucideIcon> = {
  Bash: Terminal,
  Read: FileText,
  Edit: Pencil,
  Write: FilePlus,
  Glob: FolderSearch,
  Grep: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: GitBranch,
  Agent: GitBranch,
  AskUserQuestion: MessageCircleQuestion,
  ExitPlanMode: ClipboardCheck,
  EnterPlanMode: ClipboardList,
  NotebookEdit: BookOpen,
  SendMessage: Send,
  TeamCreate: UserPlus,
  TeamDelete: UserMinus,
  GenerateImage: ImageIcon,
  Advisor: Lightbulb,
};

/** Default icon when a tool name isn't in the registry. */
export const DEFAULT_TOOL_ICON: LucideIcon = Wrench;

/** Look up the icon for a tool, falling back to the default wrench. */
export function getToolIcon(tool: string | undefined): LucideIcon {
  if (!tool) return DEFAULT_TOOL_ICON;
  return TOOL_ICONS[tool] ?? DEFAULT_TOOL_ICON;
}
