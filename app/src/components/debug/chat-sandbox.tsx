/**
 * Chat Sandbox — standalone route for previewing every UI state the chat
 * instance view can display, without affecting real chats.
 *
 * Renders real components (InstanceHeader, banners, MessageList) against a
 * mock InstanceInfo that can be overridden from the control panel.
 */

import { useCallback, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  MessageSquare,
  Bot,
  Brain,
  Wrench,
  AlertTriangle,
  Info,
  Minus,
  UserIcon,
  Trash2,
  RotateCcw,
  HelpCircle,
  ClipboardList,
  Square,
  Paperclip,
  Image,
  Terminal,
  ListChecks,
  FileCode,
  AtSign,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { InstanceHeader } from "@/components/chat/instance-header";
import { BranchChangeBanner } from "@/components/chat/branch-change-banner";
import { ConnectionStatusBanner } from "@/components/chat/connection-status-banner";
import { ExternalSessionBar } from "@/components/chat/external-session-bar";
import { PermissionBanner } from "@/components/chat/permission-banner";
import { TerminalInputBanner } from "@/components/chat/terminal-input-banner";
import { MessageList } from "@/components/chat/message-list";
import { PlanReviewPanel, type PlanComment } from "@/components/chat/plan-review-card";
import { AskUserQuestionPanel } from "@/components/chat/input-area/ask-user-question-panel";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ViewHeader, ViewHeaderTitle, MobileSidebarToggle } from "@/components/ui/view-header";
import type { ChatItem } from "@/hooks/use-instance-messages";
import type { MergedActivity } from "@/lib/chat-types";
import { toggleAnswerSelection } from "@/lib/utils";
import type {
  InstanceInfo,
  InstanceStatus,
  ProviderRequest,
  UserInputQuestion,
} from "@shared/types";

// ── Default mock instance ───────────────────────────────────────────

const DEFAULT_INSTANCE: InstanceInfo = {
  id: "sandbox-instance",
  provider: "claude",
  name: "Sandbox Chat",
  workingDirectory: "/Users/dev/project",
  status: "idle" as InstanceStatus,
  createdAt: Date.now() - 60_000,
  lastActivityAt: Date.now(),
  gitBranch: "main",
  gitInfo: { branch: "main", isWorktree: false },
  preferredModel: "claude-sonnet-4-20250514",
};

// ── Sample data (hoisted so presets can reference them) ─────────────

const PLAN_SAMPLE = `## Implementation Plan

1. **Refactor the debug panel** — Extract shared tabs into a reusable \`DebugTabs\` component
2. **Add JSON tree viewer** — Interactive expand/collapse with search and path copy
3. **Unify chat and space debug** — Both surfaces share the drawer shell and core tabs
4. **Add state overrides** — Preset-based and manual field toggles for previewing UI states

### Notes
- All changes should be backwards compatible
- Run the full test suite before merging
- Consider adding snapshot tests for the tree viewer`;

// ── Presets ──────────────────────────────────────────────────────────

interface Preset {
  label: string;
  description: string;
  overrides: Partial<InstanceInfo>;
}

const PRESETS: Preset[] = [
  {
    label: "Processing",
    description: "Agent is actively responding",
    overrides: { status: "processing" as InstanceStatus },
  },
  {
    label: "Stopped",
    description: "Agent was interrupted mid-response",
    overrides: { status: "stopped" as InstanceStatus },
  },
  {
    label: "Branch changed",
    description: "Git branch switched mid-chat",
    overrides: {
      branchChanged: { originalBranch: "main", currentBranch: "feature/debug-tools" },
    },
  },
  {
    label: "External session",
    description: "Chat owned by another client",
    overrides: {
      external: true,
      sessionId: "ext-debug-preview",
      status: "processing" as InstanceStatus,
    },
  },
  {
    label: "Pending plan",
    description: "Plan review waiting for approval",
    overrides: {
      pendingPlan: PLAN_SAMPLE,
      runtimeMode: "plan" as const,
    },
  },
  {
    label: "Approval request",
    description: "Tool permission banner",
    overrides: {
      status: "processing" as InstanceStatus,
      pendingPermission: {
        requestId: "debug-approval-1",
        kind: "approval",
        category: "command",
        source: "agent",
        tool: "bash",
        command: "rm -rf node_modules && pnpm install",
        cwd: "/Users/dev/project",
        description: "Run shell command",
      } as ProviderRequest,
    },
  },
  {
    label: "Terminal input",
    description: "Terminal input request",
    overrides: {
      status: "processing" as InstanceStatus,
      pendingPermission: {
        requestId: "debug-terminal-1",
        kind: "terminal_input",
        source: "command",
        tool: "terminal",
        prompt: "Enter your API key:",
      } as ProviderRequest,
    },
  },
  {
    label: "User input (MCP)",
    description: "MCP elicitation request",
    overrides: {
      status: "processing" as InstanceStatus,
      pendingPermission: {
        requestId: "debug-user-input-1",
        kind: "user_input",
        source: "mcp",
        server: "github-mcp",
        tool: "create_pull_request",
        description: "The MCP server needs additional information",
        questions: [
          { id: "title", header: "PR Title", question: "Enter the pull request title" },
          { id: "draft", header: "Draft?", question: "Create as draft pull request?" },
        ],
      } as ProviderRequest,
    },
  },
  {
    label: "Provider notice",
    description: "Config warning in header",
    overrides: {
      providerStatus: {
        notices: [
          {
            level: "warning",
            code: "config_warning",
            source: "configWarning",
            message: "API key expires in 3 days",
            detail: "Update your credentials in settings to avoid interruption.",
          },
        ],
      },
    },
  },
  {
    label: "Model reroute",
    description: "Rerouted model badge",
    overrides: {
      providerStatus: {
        effectiveModel: "claude-sonnet-4-20250514",
        reroutedFromModel: "claude-opus-4-20250115",
      },
    },
  },
];

// ── Composer mode ───────────────────────────────────────────────────

type ComposerMode = "idle" | "plan-review" | "ask-user";

// ── Sample data (continued) ──────────────────────────────────────────

const ASK_USER_QUESTIONS: UserInputQuestion[] = [
  {
    id: "approach",
    header: "Implementation approach",
    question: "How should we handle the migration?",
    options: [
      {
        label: "Incremental",
        description: "Migrate one component at a time, keeping both old and new working",
      },
      { label: "Big bang", description: "Rewrite everything at once and switch over" },
      {
        label: "Feature flag",
        description: "Use a feature flag to gradually roll out the new implementation",
      },
    ],
  },
  {
    id: "testing",
    header: "Testing strategy",
    question: "Which test types should we add? (multi-select)",
    multiSelect: true,
    options: [
      { label: "Unit tests", description: "Fast, focused tests for individual functions" },
      { label: "Integration tests", description: "Test component interactions and data flow" },
      { label: "Full E2E", description: "End-to-end browser tests for critical paths" },
    ],
  },
];

// ── Message templates ────────────────────────────────────────────────

interface MessageTemplate {
  label: string;
  icon: typeof MessageSquare;
  description: string;
  create: () => ChatItem;
}

let _counter = 0;
const nextId = () => ++_counter;

const TEMPLATES: MessageTemplate[] = [
  {
    label: "User message",
    icon: UserIcon,
    description: "Plain text from the user",
    create: () => ({
      kind: "user" as const,
      text: `This is a sample user message (#${nextId()}).`,
      timestamp: Date.now(),
    }),
  },
  {
    label: "User (queued)",
    icon: UserIcon,
    description: "Queued message while agent is busy",
    create: () => ({
      kind: "user" as const,
      text: `This queued message (#${nextId()}) was sent while the agent was processing.`,
      timestamp: Date.now(),
      queued: true,
    }),
  },
  {
    label: "User (image)",
    icon: Image,
    description: "Message with image attachment",
    create: () => ({
      kind: "user" as const,
      text: `Here's what the UI looks like (#${nextId()}).\n\n[Image: source: /Users/erichermanson/.relay/worktrees/space-44c21e73/app/public/favicon.svg]`,
      timestamp: Date.now(),
    }),
  },
  {
    label: "User (terminal)",
    icon: Terminal,
    description: "Message with terminal context attached",
    create: () => ({
      kind: "user" as const,
      text: `<terminal_context source="Terminal 1">\n$ pnpm typecheck\n\nsrc/components/debug-panel.tsx(42,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\nsrc/lib/utils.ts(18,10): error TS7006: Parameter 'x' implicitly has an 'any' type.\n\nFound 2 errors in 2 files.\n</terminal_context>\n\nCan you fix these type errors? (#${nextId()})`,
      timestamp: Date.now(),
    }),
  },
  {
    label: "User (task ref)",
    icon: ListChecks,
    description: "Message referencing a task",
    create: () => ({
      kind: "user" as const,
      text: `<task_reference id="a1b2c3d4" title="Refactor debug panel">\nExtract shared tabs into a reusable DebugTabs component\n</task_reference>\n\nCan you pick up where this task left off? (#${nextId()})`,
      timestamp: Date.now(),
    }),
  },
  {
    label: "User (file ref)",
    icon: FileCode,
    description: "Message mentioning a file path",
    create: () => ({
      kind: "user" as const,
      text: `Can you look at \`app/src/components/chat/debug-tabs.tsx\` and refactor the tab rendering? The file is getting too long. Also check \`app/src/components/chat/instance-view-content.tsx\` for the banner ordering. (#${nextId()})`,
      timestamp: Date.now(),
    }),
  },
  {
    label: "Assistant text",
    icon: Bot,
    description: "Plain assistant response",
    create: () => ({
      kind: "assistant" as const,
      text: `Here's a sample assistant response (#${nextId()}).\n\nIt can include **markdown**, \`inline code\`, and more.\n\n\`\`\`typescript\nconst greeting = "Hello from the sandbox!";\nconsole.log(greeting);\n\`\`\``,
      timestamp: Date.now(),
    }),
  },
  {
    label: "Assistant (long)",
    icon: Bot,
    description: "Multi-paragraph response with formatting",
    create: () => ({
      kind: "assistant" as const,
      text: `# Analysis Complete (#${nextId()})\n\nI've reviewed the codebase and found several areas for improvement.\n\n## Key Findings\n\n1. **Performance**: The main rendering loop has O(n²) complexity due to nested iteration over the item list.\n2. **Type Safety**: Several \`any\` casts could be replaced with proper generics.\n3. **Error Handling**: The WebSocket reconnection logic doesn't handle all edge cases.\n\n## Recommendations\n\n- Refactor the rendering loop to use a map-based lookup\n- Add \`strict: true\` to the TypeScript config\n- Implement exponential backoff for WS reconnection\n\n\`\`\`diff\n- for (const item of items) {\n-   for (const child of items) {\n+ const lookup = new Map(items.map(i => [i.id, i]));\n+ for (const item of items) {\n+   const child = lookup.get(item.parentId);\n\`\`\``,
      timestamp: Date.now(),
    }),
  },
  {
    label: "Assistant (mentions)",
    icon: AtSign,
    description: "Response with @task and @file mentions",
    create: () => ({
      kind: "assistant" as const,
      text: `I've updated the implementation based on @task:a1b2c3d4:refactor-debug-panel.\n\nThe main changes are in @debug-tabs.tsx and @instance-view.tsx. Both files needed the new tab interface. (#${nextId()})`,
      timestamp: Date.now(),
    }),
  },
  {
    label: "Thinking block",
    icon: Brain,
    description: "Internal reasoning / chain of thought",
    create: () => ({
      kind: "thinking-block" as const,
      text: `Let me think about this step by step (#${nextId()})...\n\nThe user wants to modify the debug panel. I should:\n1. First check the current implementation\n2. Identify the component tree\n3. Plan the changes carefully`,
    }),
  },
  {
    label: "Tool use (bash)",
    icon: Wrench,
    description: "Shell command execution with result",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Bash",
            description: `Running command (#${id})`,
            detail: "ls -la src/components/",
            input: { command: "ls -la src/components/" },
            inputDescription: "List src/components/",
            mergedResultDetail:
              "total 48\ndrwxr-xr-x  12 dev  staff   384 Apr  5 10:23 .\n-rw-r--r--   1 dev  staff  1420 Apr  5 10:23 debug-drawer.tsx\n-rw-r--r--   1 dev  staff  2840 Apr  5 10:23 chat-debug.tsx",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (file edit)",
    icon: Wrench,
    description: "File modification with diff",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Edit",
            description: `Editing debug-panel.tsx (#${id})`,
            detail: "src/components/debug-panel.tsx",
            input: {
              file_path: "src/components/debug-panel.tsx",
              old_string: "const TABS = ['raw', 'processed'];",
              new_string: "const TABS = ['raw', 'processed', 'tree'];",
            },
            inputDescription: "Edit debug-panel.tsx",
            mergedResultDetail: "File updated successfully — 1 replacement made.",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (error)",
    icon: Wrench,
    description: "Failed tool execution",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Bash",
            description: `Running command (#${id})`,
            detail: "pnpm build",
            input: { command: "pnpm build" },
            inputDescription: "Run pnpm build",
            mergedResultDetail:
              "Error: TypeScript compilation failed\n\nsrc/lib/utils.ts(42,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
            mergedResultStatus: "error",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (write)",
    icon: Wrench,
    description: "Creating a new file",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Write",
            description: `Creating new test file (#${id})`,
            detail: "app/src/components/chat/__tests__/debug-tabs.test.tsx",
            input: {
              file_path: "app/src/components/chat/__tests__/debug-tabs.test.tsx",
              content:
                "import { describe, it, expect } from 'vitest';\nimport { render } from '@testing-library/react';\nimport { DebugTabs } from '../debug-tabs';\n\ndescribe('DebugTabs', () => {\n  it('renders provider tab by default', () => {\n    // ...\n  });\n});",
            },
            inputDescription: "Write debug-tabs.test.tsx",
            mergedResultDetail: "File created successfully (8 lines).",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (read)",
    icon: Wrench,
    description: "Reading a file",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Read",
            description: `Reading instance-view.tsx (#${id})`,
            detail: "app/src/components/chat/instance-view.tsx",
            input: { file_path: "app/src/components/chat/instance-view.tsx" },
            inputDescription: "Read instance-view.tsx",
            mergedResultDetail: "File contents read (436 lines).",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (glob)",
    icon: Wrench,
    description: "File pattern search",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Glob",
            description: `Finding test files (#${id})`,
            detail: "**/*.test.{ts,tsx}",
            input: { pattern: "**/*.test.{ts,tsx}", path: "app/src/" },
            inputDescription: "Glob for test files",
            mergedResultDetail: "Found 23 matching files.",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (web search)",
    icon: Wrench,
    description: "Searching the web",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "WebSearch",
            description: `Searching the web (#${id})`,
            detail: "tanstack virtual scroll dynamic row height",
            input: { query: "tanstack virtual scroll dynamic row height", max_results: 5 },
            inputDescription: "Search for TanStack Virtual scroll docs",
            mergedResultDetail:
              "Found 5 results:\n1. TanStack Virtual - Dynamic Row Heights (tanstack.com)\n2. useVirtualizer with variable sizes - GitHub Discussion\n3. React Virtual: Dynamic sizing example",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (web fetch)",
    icon: Wrench,
    description: "Fetching a web page",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "WebFetch",
            description: `Fetching documentation (#${id})`,
            detail: "https://tanstack.com/virtual/latest/docs/api/virtualizer",
            input: { url: "https://tanstack.com/virtual/latest/docs/api/virtualizer" },
            inputDescription: "Fetch TanStack Virtual docs",
            mergedResultDetail: "Page fetched successfully (12,480 chars).",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (todo write)",
    icon: Wrench,
    description: "Updating task list",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "TodoWrite",
            description: `Updating todo list (#${id})`,
            detail: "3 tasks",
            input: {
              todos: [
                { id: "1", content: "Add collapsible sections to sidebar", status: "completed" },
                { id: "2", content: "Add missing tool call templates", status: "in_progress" },
                { id: "3", content: "Hook sandbox into debug drawer", status: "pending" },
              ],
            },
            inputDescription: "Update task list",
            mergedResultDetail: "Todo list updated (3 items).",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (notebook)",
    icon: Wrench,
    description: "Editing a Jupyter notebook cell",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "NotebookEdit",
            description: `Editing notebook cell (#${id})`,
            detail: "analysis.ipynb — cell 3",
            input: {
              notebook_path: "analysis.ipynb",
              cell_index: 3,
              new_source: "import pandas as pd\ndf = pd.read_csv('data.csv')\ndf.describe()",
            },
            inputDescription: "Edit notebook cell 3",
            mergedResultDetail: "Cell updated successfully.",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Tool use (denied)",
    icon: Wrench,
    description: "Tool call the user denied",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Bash",
            description: `Running command (#${id})`,
            detail: "rm -rf /tmp/build-cache",
            input: { command: "rm -rf /tmp/build-cache" },
            inputDescription: "Delete build cache",
            permissionDenied: "User denied permission to run this command.",
            mergedResultStatus: "error",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "Multi-tool group",
    icon: Wrench,
    description: "Several tool calls in one activity group",
    create: () => {
      const id = nextId();
      return {
        kind: "activity-group" as const,
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Read",
            description: `Reading package.json (#${id})`,
            detail: "package.json",
            input: { file_path: "package.json" },
            inputDescription: "Read package.json",
            mergedResultDetail: "File contents read successfully (42 lines)",
            mergedResultStatus: "success",
          } as MergedActivity,
          {
            type: "activity",
            activity: "tool_use",
            tool: "Grep",
            description: "Searching for debug references",
            detail: 'pattern: "debug" in src/',
            input: { pattern: "debug", path: "src/" },
            inputDescription: 'Grep for "debug"',
            mergedResultDetail: "Found 12 matches across 4 files",
            mergedResultStatus: "success",
          } as MergedActivity,
          {
            type: "activity",
            activity: "tool_use",
            tool: "Edit",
            description: "Updating debug-panel.tsx",
            detail: "src/components/debug-panel.tsx",
            input: {
              file_path: "src/components/debug-panel.tsx",
              old_string: "// TODO",
              new_string: "const [search, setSearch] = useState('');",
            },
            inputDescription: "Edit debug-panel.tsx",
            mergedResultDetail: "File updated successfully",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      };
    },
  },
  {
    label: "System event",
    icon: Info,
    description: "System notification message",
    create: () => ({
      kind: "system" as const,
      text: `Session resumed after reconnection (#${nextId()}).`,
    }),
  },
  {
    label: "Error event",
    icon: AlertTriangle,
    description: "Error system message",
    create: () => ({
      kind: "system" as const,
      text: `Provider error: Rate limit exceeded. Please wait before retrying. (#${nextId()})`,
      isError: true,
    }),
  },
  {
    label: "Compact boundary",
    icon: Minus,
    description: "Visual separator between conversation turns",
    create: () => ({
      kind: "compact-boundary" as const,
      timestamp: Date.now(),
    }),
  },
  {
    label: "Agent transcript",
    icon: Bot,
    description: "Sub-agent spawned and completed",
    create: () => ({
      kind: "agent-transcript" as const,
      title: `Sub-agent: review code (#${nextId()})`,
      result:
        "Reviewed 3 files, found 2 issues. Applied fixes to debug-panel.tsx and chat-debug.tsx.",
      timestamp: Date.now(),
    }),
  },
];

// ── Grouped templates ────────────────────────────────────────────────

interface TemplateGroup {
  label: string;
  templates: MessageTemplate[];
}

const TEMPLATE_GROUPS: TemplateGroup[] = [
  { label: "User Messages", templates: TEMPLATES.filter((t) => t.label.startsWith("User")) },
  {
    label: "Assistant Messages",
    templates: TEMPLATES.filter(
      (t) => t.label.startsWith("Assistant") || t.label === "Thinking block",
    ),
  },
  {
    label: "Tools — Files & Search",
    templates: TEMPLATES.filter(
      (t) =>
        [
          "Tool use (bash)",
          "Tool use (file edit)",
          "Tool use (write)",
          "Tool use (read)",
          "Tool use (glob)",
        ].includes(t.label) || t.label === "Multi-tool group",
    ),
  },
  {
    label: "Tools — Web & Other",
    templates: TEMPLATES.filter((t) =>
      [
        "Tool use (web search)",
        "Tool use (web fetch)",
        "Tool use (todo write)",
        "Tool use (notebook)",
        "Tool use (error)",
        "Tool use (denied)",
      ].includes(t.label),
    ),
  },
  {
    label: "System",
    templates: TEMPLATES.filter((t) =>
      ["System event", "Error event", "Compact boundary", "Agent transcript"].includes(t.label),
    ),
  },
];

// ── Quick scenes ─────────────────────────────────────────────────────

interface Scene {
  label: string;
  description: string;
  build: () => ChatItem[];
}

const SCENES: Scene[] = [
  {
    label: "Empty chat",
    description: "Clear all messages and reset to blank state",
    build: () => [],
  },
  {
    label: "Simple conversation",
    description: "User question → thinking → answer",
    build: () => [
      {
        kind: "user",
        text: "How do I add a new route in this project?",
        timestamp: Date.now() - 5000,
      },
      {
        kind: "thinking-block",
        text: "The user wants to know about adding routes. This project uses TanStack Router with file-based routing...",
      },
      {
        kind: "assistant",
        text: "To add a new route, create a file in `app/src/routes/`. The file path becomes the URL path.\n\n```typescript\nimport { createFileRoute } from '@tanstack/react-router';\n\nexport const Route = createFileRoute('/_app/sandbox')({\n  component: SandboxPage,\n});\n```",
        timestamp: Date.now(),
      },
    ],
  },
  {
    label: "Tool-heavy turn",
    description: "Multiple tool calls with mixed results",
    build: () => [
      {
        kind: "user",
        text: "Find all TODO comments and fix the most critical one.",
        timestamp: Date.now() - 10000,
      },
      {
        kind: "thinking-block",
        text: "I'll search for TODOs first, then prioritize and fix the most critical one.",
      },
      {
        kind: "activity-group",
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Grep",
            description: "Searching for TODO comments",
            detail: "TODO|FIXME|HACK",
            input: { pattern: "TODO|FIXME|HACK", path: "src/" },
            inputDescription: "Grep for TODOs",
            mergedResultDetail: "Found 8 matches across 5 files",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      },
      {
        kind: "activity-group",
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Read",
            description: "Reading src/lib/api.ts",
            detail: "src/lib/api.ts",
            input: { file_path: "src/lib/api.ts" },
            inputDescription: "Read api.ts",
            mergedResultDetail: "File contents read (142 lines)",
            mergedResultStatus: "success",
          } as MergedActivity,
          {
            type: "activity",
            activity: "tool_use",
            tool: "Edit",
            description: "Fixing race condition in api.ts",
            detail: "src/lib/api.ts",
            input: {
              file_path: "src/lib/api.ts",
              old_string: "// TODO: handle concurrent requests",
              new_string: "const queue = new RequestQueue();",
            },
            inputDescription: "Edit api.ts",
            mergedResultDetail: "File updated successfully",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      },
      {
        kind: "assistant",
        text: "I found 8 TODO comments. The most critical was a race condition in `src/lib/api.ts`. I've fixed it by adding a request queue with deduplication.",
        timestamp: Date.now(),
      },
    ],
  },
  {
    label: "Error recovery",
    description: "Failed command → retry → success",
    build: () => [
      { kind: "user", text: "Run the test suite.", timestamp: Date.now() - 8000 },
      {
        kind: "activity-group",
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Bash",
            description: "Running tests",
            detail: "pnpm test",
            input: { command: "pnpm test" },
            inputDescription: "Run pnpm test",
            mergedResultDetail: "Error: Cannot find module 'vitest'",
            mergedResultStatus: "error",
          } as MergedActivity,
        ],
      },
      {
        kind: "thinking-block",
        text: "Tests failed because vitest isn't installed. I need to install it first.",
      },
      {
        kind: "activity-group",
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Bash",
            description: "Installing vitest",
            detail: "pnpm add -D vitest",
            input: { command: "pnpm add -D vitest" },
            inputDescription: "Install vitest",
            mergedResultDetail: "Added vitest@3.1.0",
            mergedResultStatus: "success",
          } as MergedActivity,
          {
            type: "activity",
            activity: "tool_use",
            tool: "Bash",
            description: "Running tests",
            detail: "pnpm test",
            input: { command: "pnpm test" },
            inputDescription: "Run pnpm test",
            mergedResultDetail: "✓ 42 tests passed\n✗ 0 tests failed\n\nDuration: 3.2s",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      },
      {
        kind: "assistant",
        text: "The test suite wasn't set up — `vitest` was missing. I installed it and all **42 tests pass** ✓",
        timestamp: Date.now(),
      },
    ],
  },
  {
    label: "Rich content",
    description: "Images, terminal context, task refs, mentions",
    build: () => [
      {
        kind: "user",
        text: `<task_reference id="a1b2c3d4" title="Refactor debug panel">\nExtract shared tabs into a reusable DebugTabs component\n</task_reference>\n\nPicking up this task — here's the error I'm seeing:\n\n[Image: source: /Users/dev/screenshots/type-error.png]`,
        timestamp: Date.now() - 12000,
      },
      {
        kind: "thinking-block",
        text: "The user shared a screenshot of a type error related to the debug panel refactor task. Let me look at the relevant files.",
      },
      {
        kind: "activity-group",
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Read",
            description: "Reading debug-tabs.tsx",
            detail: "src/components/chat/debug-tabs.tsx",
            input: { file_path: "src/components/chat/debug-tabs.tsx" },
            inputDescription: "Read debug-tabs.tsx",
            mergedResultDetail: "File contents read (228 lines)",
            mergedResultStatus: "success",
          } as MergedActivity,
          {
            type: "activity",
            activity: "tool_use",
            tool: "Edit",
            description: "Fixing type export",
            detail: "src/components/chat/debug-tabs.tsx",
            input: {
              file_path: "src/components/chat/debug-tabs.tsx",
              old_string: "type ViewMode = 'tree' | 'raw'",
              new_string: "export type ViewMode = 'tree' | 'raw'",
            },
            inputDescription: "Edit debug-tabs.tsx",
            mergedResultDetail: "File updated successfully",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      },
      {
        kind: "assistant",
        text: "Fixed the type error from @task:a1b2c3d4:refactor-debug-panel. The issue was that `ViewMode` wasn't exported from @debug-tabs.tsx — other consumers couldn't import it.\n\nThe fix was a one-line change to add the `export` keyword.",
        timestamp: Date.now() - 5000,
      },
      {
        kind: "user",
        text: `<terminal_context source="Terminal 1">\n$ pnpm typecheck\n✓ No errors found\n</terminal_context>\n\nLooks like the fix worked. Can you also update the tests?`,
        timestamp: Date.now() - 2000,
      },
      {
        kind: "activity-group",
        activities: [
          {
            type: "activity",
            activity: "tool_use",
            tool: "Edit",
            description: "Adding test for ViewMode export",
            detail: "src/components/chat/debug-tabs.test.tsx",
            input: {
              file_path: "src/components/chat/debug-tabs.test.tsx",
              old_string: "// tests",
              new_string:
                "import { type ViewMode } from './debug-tabs';\n\ntest('ViewMode export', () => {\n  const m: ViewMode = 'tree';\n  expect(m).toBe('tree');\n});",
            },
            inputDescription: "Edit test file",
            mergedResultDetail: "File updated successfully",
            mergedResultStatus: "success",
          } as MergedActivity,
        ],
      },
      {
        kind: "assistant",
        text: "Done — added a test verifying the `ViewMode` type export in @debug-tabs.test.tsx.",
        timestamp: Date.now(),
      },
    ],
  },
];

// ── Main component ───────────────────────────────────────────────────

export function ChatSandbox() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [instanceOverrides, setInstanceOverrides] = useState<Partial<InstanceInfo>>({});
  const [composerMode, setComposerMode] = useState<ComposerMode>("idle");
  const [planComments, setPlanComments] = useState<PlanComment[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string[]>>({});
  const [connectionBanner, setConnectionBanner] = useState<"reconnecting" | "interrupted" | null>(
    null,
  );
  const [showBranchBanner, setShowBranchBanner] = useState(false);

  const instance = useMemo<InstanceInfo>(
    () => ({ ...DEFAULT_INSTANCE, ...instanceOverrides }),
    [instanceOverrides],
  );

  const addItem = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const removeLastItem = useCallback(() => {
    setItems((prev) => prev.slice(0, -1));
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
    setInstanceOverrides({});
    setComposerMode("idle");
    setConnectionBanner(null);
    setShowBranchBanner(false);
    setPlanComments([]);
    setSelectedAnswers({});
  }, []);

  const clearPreset = useCallback(() => {
    setInstanceOverrides({});
    setShowBranchBanner(false);
    setConnectionBanner(null);
    setComposerMode("idle");
    setPlanComments([]);
    setSelectedAnswers({});
  }, []);

  const applyPreset = useCallback((preset: Preset) => {
    setInstanceOverrides(preset.overrides);
    // Auto-show branch banner if preset sets branchChanged
    setShowBranchBanner(!!preset.overrides.branchChanged);
    // Auto-set composer mode based on preset
    const perm = preset.overrides.pendingPermission as ProviderRequest | undefined;
    if (preset.overrides.pendingPlan) {
      setComposerMode("plan-review");
    } else if (perm?.kind === "user_input") {
      setComposerMode("ask-user");
    } else {
      setComposerMode("idle");
    }
    // Auto-load "Simple conversation" so presets aren't shown over empty state
    setItems((prev) => (prev.length > 0 ? prev : SCENES[1]!.build()));
  }, []);

  const toggleComposerMode = useCallback((mode: ComposerMode) => {
    setComposerMode((prev) => (prev === mode ? "idle" : mode));
    setPlanComments([]);
    setSelectedAnswers({});
  }, []);

  const isProcessing = instance.status === "processing";

  // Derive which banners to show
  const pendingPermission = instance.pendingPermission;
  const isApprovalRequest = pendingPermission?.kind === "approval";
  const isTerminalInput = pendingPermission?.kind === "terminal_input";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Sandbox control header */}
      <ViewHeader>
        <MobileSidebarToggle />
        <Link
          to="/"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          <ArrowLeft size={15} />
        </Link>
        <ViewHeaderTitle>
          <h1 className="text-sm font-semibold tracking-tight text-text-bright">Chat Sandbox</h1>
          <span className="text-[0.6875rem] text-muted">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        </ViewHeaderTitle>
        <div className="flex items-center gap-1">
          {(items.length > 0 || Object.keys(instanceOverrides).length > 0) && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={removeLastItem}
                className="gap-1 text-[0.6875rem]"
              >
                <RotateCcw size={11} />
                Undo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAll}
                className="gap-1 text-[0.6875rem] text-error"
              >
                <Trash2 size={11} />
                Reset
              </Button>
            </>
          )}
        </div>
      </ViewHeader>

      {/* Split layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: controls */}
        <div className="w-[280px] shrink-0 overflow-y-auto border-r border-border/70 bg-surface">
          <div className="p-4">
            {/* Instance presets */}
            <Section title="Instance Presets">
              <p className="mb-2 text-[0.6875rem] text-muted">
                Override instance state to preview headers, banners, and badges.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => {
                  const isActive =
                    JSON.stringify(instanceOverrides) === JSON.stringify(preset.overrides);
                  return (
                    <button
                      key={preset.label}
                      onClick={() => (isActive ? clearPreset() : applyPreset(preset))}
                      title={preset.description}
                      className={`rounded-md border px-2 py-1 text-[0.6875rem] transition-colors ${
                        isActive
                          ? "border-accent/40 bg-accent/10 text-accent"
                          : "border-border/50 text-muted hover:border-border hover:text-text"
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </Section>

            {/* Banners */}
            <Section title="Banners">
              <div className="flex flex-col gap-1">
                <ToggleRow
                  label="Branch changed"
                  checked={showBranchBanner}
                  onChange={(v) => {
                    setShowBranchBanner(v);
                    if (v)
                      setInstanceOverrides((prev) => ({
                        ...prev,
                        branchChanged: { originalBranch: "main", currentBranch: "feature/debug" },
                      }));
                    else
                      setInstanceOverrides((prev) => {
                        const { branchChanged: _, ...rest } = prev;
                        return rest;
                      });
                  }}
                />
                <ToggleRow
                  label="Reconnecting"
                  checked={connectionBanner === "reconnecting"}
                  onChange={(v) => setConnectionBanner(v ? "reconnecting" : null)}
                />
                <ToggleRow
                  label="Interrupted"
                  checked={connectionBanner === "interrupted"}
                  onChange={(v) => setConnectionBanner(v ? "interrupted" : null)}
                />
              </div>
            </Section>

            {/* Composer state */}
            <Section title="Composer">
              <div className="flex flex-col gap-1">
                <ComposerModeButton
                  label="Plan review"
                  description="Approve or reject a proposed plan"
                  icon={ClipboardList}
                  active={composerMode === "plan-review"}
                  onClick={() => toggleComposerMode("plan-review")}
                />
                <ComposerModeButton
                  label="Ask user question"
                  description="Multiple-choice elicitation UI"
                  icon={HelpCircle}
                  active={composerMode === "ask-user"}
                  onClick={() => toggleComposerMode("ask-user")}
                />
              </div>
            </Section>

            {/* Scenes */}
            <Section title="Scenes">
              <div className="flex flex-col gap-1">
                {SCENES.map((scene) => (
                  <button
                    key={scene.label}
                    onClick={() => setItems(scene.build())}
                    className="rounded-md border border-border/50 px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-surface-hover"
                  >
                    <div className="text-[0.75rem] font-medium text-text-bright">{scene.label}</div>
                    <div className="mt-0.5 text-[0.6875rem] text-muted">{scene.description}</div>
                  </button>
                ))}
              </div>
            </Section>

            {/* Message palette */}
            {TEMPLATE_GROUPS.map((group) => (
              <Section key={group.label} title={group.label} defaultOpen={false}>
                <div className="flex flex-col gap-1">
                  {group.templates.map((template) => (
                    <button
                      key={template.label}
                      onClick={() => addItem(template.create())}
                      className="group flex items-center gap-2 rounded-md border border-border/50 px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-surface-hover"
                    >
                      <template.icon
                        size={13}
                        className="shrink-0 text-muted group-hover:text-text"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[0.75rem] font-medium text-text-bright">
                          {template.label}
                        </div>
                        <div className="mt-0.5 truncate text-[0.6875rem] text-muted">
                          {template.description}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </Section>
            ))}
          </div>
        </div>

        {/* Right: mock instance view */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Real InstanceHeader */}
          <InstanceHeader
            instance={instance}
            isMobile={false}
            activeTab="tasks"
            isOpen={false}
            tasksCount={0}
            filesCount={0}
            hasPlanContent={!!instance.planContent}
            hasReviewContent={!!instance.reviewInstanceId}
            hasStats={!!instance.stats}
            sidecarContentCount={0}
            onSelectTab={() => {}}
            onOpenDebug={() => {}}
            onOpenMobileSidecar={() => {}}
          />

          {/* Message list */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
            {items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <MessageSquare size={32} className="mb-3 text-muted/40" />
                <p className="text-[0.875rem] font-medium text-text">No messages yet</p>
                <p className="mt-1 max-w-xs text-[0.75rem] text-muted">
                  Add messages from the palette, load a scene, or apply a preset.
                </p>
              </div>
            ) : (
              <ErrorBoundary name="Sandbox preview">
                <MessageList
                  items={items}
                  isProcessing={isProcessing}
                  instanceStatus={instance.status}
                  isInteractive={instance.status !== "stopped"}
                  isExternal={!!instance.external}
                />
              </ErrorBoundary>
            )}
          </div>

          {/* Banners — rendered between message list and composer, matching real layout */}
          {isApprovalRequest && pendingPermission && (
            <PermissionBanner
              provider={instance.provider}
              request={pendingPermission}
              onRespond={() =>
                setInstanceOverrides((prev) => {
                  const { pendingPermission: _, ...rest } = prev;
                  return rest;
                })
              }
            />
          )}
          {isTerminalInput && pendingPermission && (
            <TerminalInputBanner
              provider={instance.provider}
              request={pendingPermission}
              onRespond={() =>
                setInstanceOverrides((prev) => {
                  const { pendingPermission: _, ...rest } = prev;
                  return rest;
                })
              }
            />
          )}
          {connectionBanner && (
            <ConnectionStatusBanner
              kind={connectionBanner}
              onDismiss={() => setConnectionBanner(null)}
            />
          )}
          {showBranchBanner && instance.branchChanged && (
            <BranchChangeBanner
              originalBranch={instance.branchChanged.originalBranch}
              currentBranch={instance.branchChanged.currentBranch}
              onDismiss={() => setShowBranchBanner(false)}
            />
          )}
          {instance.external && (
            <ExternalSessionBar
              isStopped={instance.status === "stopped"}
              isConnected={true}
              onTakeover={() =>
                setInstanceOverrides((prev) => {
                  const { external: _, sessionId: _s, ...rest } = prev;
                  return rest;
                })
              }
              provider={instance.provider}
              model={instance.preferredModel}
            />
          )}

          {/* Mock composer */}
          {!instance.external && (
            <MockComposer
              mode={composerMode}
              isProcessing={isProcessing}
              isStopped={instance.status === "stopped"}
              onDismiss={() => setComposerMode("idle")}
              planComments={planComments}
              onPlanCommentsChange={setPlanComments}
              selectedAnswers={selectedAnswers}
              onSelectAnswer={(qId, answer) =>
                setSelectedAnswers((prev) => ({
                  ...prev,
                  [qId]: toggleAnswerSelection(
                    prev[qId],
                    answer,
                    ASK_USER_QUESTIONS.find((q) => q.id === qId)?.multiSelect,
                  ),
                }))
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Mock composer ───────────────────────────────────────────────────

function MockComposer({
  mode,
  isProcessing,
  isStopped,
  onDismiss,
  planComments,
  onPlanCommentsChange,
  selectedAnswers,
  onSelectAnswer,
}: {
  mode: ComposerMode;
  isProcessing: boolean;
  isStopped: boolean;
  onDismiss: () => void;
  planComments: PlanComment[];
  onPlanCommentsChange: (c: PlanComment[]) => void;
  selectedAnswers: Record<string, string[]>;
  onSelectAnswer: (qId: string, answer: string) => void;
}) {
  const [isQuestionPanelCollapsed, setIsQuestionPanelCollapsed] = useState(false);
  const hasPlanFeedback = planComments.length > 0;

  const placeholder = (() => {
    if (mode === "plan-review") return "Add feedback to refine the plan, or leave blank to approve";
    if (mode === "ask-user") return "Add additional context (optional)...";
    if (isStopped) return "Send a message to resume...";
    return "Send a message...";
  })();

  const actionLabel = (() => {
    if (mode === "plan-review") return hasPlanFeedback ? "Send Feedback" : "Approve Plan";
    if (mode === "ask-user")
      return isQuestionPanelCollapsed
        ? "Show Questions"
        : Object.keys(selectedAnswers).length > 0
          ? "Submit answers"
          : "Submit answer";
    return null;
  })();

  return (
    <div className="shrink-0">
      <div className="mx-auto max-w-3xl px-6 pb-4">
        <div className="relative rounded-2xl border border-border/60 bg-surface">
          {mode === "plan-review" && (
            <div className="border-b border-border/60">
              <PlanReviewPanel
                plan={PLAN_SAMPLE}
                comments={planComments}
                onCommentsChange={onPlanCommentsChange}
              />
            </div>
          )}

          {mode === "ask-user" && (
            <AskUserQuestionPanel
              questions={ASK_USER_QUESTIONS}
              selectedAnswers={selectedAnswers}
              onSelectOption={onSelectAnswer}
              collapsed={isQuestionPanelCollapsed}
              onToggleCollapse={() => setIsQuestionPanelCollapsed((v) => !v)}
            />
          )}

          <div
            className={`min-h-[52px] max-h-[140px] overflow-y-auto px-4 pt-3 pb-1 text-sm ${isProcessing ? "opacity-40" : ""}`}
          >
            <div className="text-muted">{placeholder}</div>
          </div>

          <div className="flex items-center gap-0.5 px-2 pb-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {mode === "idle" && (
                <>
                  <button
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-text"
                    disabled={isProcessing}
                  >
                    <Paperclip size={15} />
                  </button>
                  <div className="h-4 w-px bg-border/60" />
                </>
              )}
              <div className="rounded-md px-2 py-1 text-[0.75rem] text-muted">claude-sonnet-4</div>
            </div>

            <div className="flex items-center gap-2">
              {(mode === "plan-review" || mode === "ask-user") && (
                <button
                  onClick={onDismiss}
                  className="h-8 rounded-full px-3.5 text-[0.8125rem] text-muted transition-colors hover:bg-surface-hover hover:text-text"
                >
                  Dismiss
                </button>
              )}

              {isProcessing ? (
                <div className="flex items-center gap-1.5">
                  <button className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-accent/60 bg-accent/15 text-accent">
                    <ArrowUp size={18} />
                  </button>
                  <button
                    onClick={onDismiss}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-error text-white transition-colors hover:bg-error/90"
                  >
                    <Square size={15} className="fill-current" />
                  </button>
                </div>
              ) : actionLabel ? (
                <button
                  onClick={
                    mode === "ask-user" && isQuestionPanelCollapsed
                      ? () => setIsQuestionPanelCollapsed(false)
                      : onDismiss
                  }
                  className="h-9 rounded-full bg-accent px-4 text-[0.875rem] font-medium text-white shadow-sm transition-colors hover:bg-accent-hover hover:shadow-md"
                >
                  {actionLabel}
                </button>
              ) : (
                <button className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white shadow-sm transition-colors hover:bg-accent-hover hover:shadow-md">
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-1 text-[0.6875rem] font-medium uppercase tracking-wider text-muted transition-colors hover:text-text"
      >
        <ChevronDown
          size={12}
          className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        {title}
      </button>
      {open && children}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`flex items-center justify-between rounded-md border px-2.5 py-2 text-left text-[0.75rem] transition-colors ${
        checked
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-border/50 text-text-bright hover:border-border hover:bg-surface-hover"
      }`}
    >
      <span className="font-medium">{label}</span>
      <span className={`h-1.5 w-1.5 rounded-full ${checked ? "bg-accent" : "bg-muted/30"}`} />
    </button>
  );
}

function ComposerModeButton({
  label,
  description,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  description: string;
  icon: typeof MessageSquare;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
        active
          ? "border-accent/40 bg-accent/10"
          : "border-border/50 hover:border-border hover:bg-surface-hover"
      }`}
    >
      <Icon
        size={13}
        className={`shrink-0 ${active ? "text-accent" : "text-muted group-hover:text-text"}`}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`text-[0.75rem] font-medium ${active ? "text-accent" : "text-text-bright"}`}
        >
          {label}
        </div>
        <div className="mt-0.5 truncate text-[0.6875rem] text-muted">{description}</div>
      </div>
    </button>
  );
}
