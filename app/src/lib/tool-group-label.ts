/**
 * Kanna-style tool group labelling.
 * Instead of "Tool calls (5)" we produce "2 reads, 1 edit, 3 commands".
 */

import type { MergedActivity } from "@/lib/chat-types";

interface ToolCategory {
  singular: string;
  plural: string;
}

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  ExecuteCode: { singular: "code execution", plural: "code executions" },
  Read: { singular: "read", plural: "reads" },
  Edit: { singular: "edit", plural: "edits" },
  Write: { singular: "write", plural: "writes" },
  Bash: { singular: "command", plural: "commands" },
  Grep: { singular: "search", plural: "searches" },
  Glob: { singular: "glob", plural: "globs" },
  WebFetch: { singular: "web fetch", plural: "web fetches" },
  WebSearch: { singular: "web search", plural: "web searches" },
  Agent: { singular: "agent", plural: "agents" },
  Task: { singular: "task", plural: "tasks" },
  Skill: { singular: "skill", plural: "skills" },
  NotebookEdit: { singular: "notebook edit", plural: "notebook edits" },
  AskUserQuestion: { singular: "question", plural: "questions" },
  ExitPlanMode: { singular: "plan", plural: "plans" },
  EnterPlanMode: { singular: "plan", plural: "plans" },
  TodoWrite: { singular: "todo update", plural: "todo updates" },
  SendMessage: { singular: "message", plural: "messages" },
};

const OTHER_CATEGORY: ToolCategory = { singular: "tool call", plural: "tool calls" };

/**
 * Build a compact label from a flat list of activities.
 * Only counts tool_use entries (skips tool_result and permission denials).
 *
 * Examples:
 *   "1 read"
 *   "2 reads, 1 edit"
 *   "3 commands, 2 reads, 1 search"
 */
export function getToolGroupLabel(activities: MergedActivity[]): string | null {
  const counts = new Map<string, { category: ToolCategory; count: number }>();
  const order: string[] = [];

  for (const act of activities) {
    if (act.activity !== "tool_use") continue;
    if (act.permissionDenied) continue;

    const tool = act.tool ?? "unknown";
    const category = TOOL_CATEGORIES[tool] ?? OTHER_CATEGORY;
    const key = category.singular; // group by category, not tool name

    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { category, count: 1 });
      order.push(key);
    }
  }

  if (order.length === 0) return null;

  return order
    .map((key) => {
      const { category, count } = counts.get(key)!;
      return `${count} ${count === 1 ? category.singular : category.plural}`;
    })
    .join(", ");
}
