import type { UiNode, UiView } from "@shared/ui-render";
import type { ChatItem } from "@/lib/chat-types";

/** `/sandbox` scenes for `ui_render` views: every node type, at realistic sizes. */

const view = (id: string, title: string, root: UiNode): UiView => ({
  id,
  title,
  version: 1,
  root,
  updatedAt: 1,
});

const RELEASE = view("release", "Release checklist", {
  type: "stack",
  children: [
    {
      type: "metrics",
      items: [
        { label: "Tests", value: 1349, tone: "success", trend: [1210, 1260, 1301, 1322, 1349] },
        { label: "Failing", value: 0 },
        { label: "Bundle", value: "412 KB", delta: "+3%", tone: "warning", detail: "app.js" },
        { label: "Build", value: "2m 41s", delta: "−12s", tone: "success" },
      ],
    },
    { type: "progress", value: 75, label: "Rollout", tone: "accent" },
    {
      type: "list",
      items: [
        { label: "Typecheck", status: "done" },
        { label: "Unit tests", status: "done", detail: "1,349 server · 398 UI" },
        { label: "Desktop smoke test", status: "running" },
        { label: "Publish release notes", status: "pending" },
        { label: "Notarize", status: "skipped", detail: "not configured" },
      ],
    },
    {
      type: "actions",
      items: [
        { id: "ship", label: "Ship it", reply: "Ship it to main", variant: "primary" },
        { id: "hold", label: "Hold", reply: "Hold the release, don't push yet" },
      ],
    },
  ],
});

const COMPARISON = view("compare", "Bundlers compared", {
  type: "stack",
  children: [
    {
      type: "text",
      markdown:
        "Measured on this repo's `app/` with a cold cache. See relay://chat/example for the run.",
    },
    {
      type: "table",
      sortable: true,
      columns: [
        { key: "tool", label: "Tool" },
        { key: "build", label: "Build", align: "right" },
        { key: "size", label: "Size", align: "right" },
        { key: "status", label: "Status" },
      ],
      rows: [
        { tool: "Vite 8", build: "4.1 s", size: 412, status: { text: "current", tone: "accent" } },
        { tool: "Rspack", build: "2.7 s", size: 431, status: { text: "faster", tone: "success" } },
        {
          tool: "esbuild",
          build: "0.9 s",
          size: 468,
          status: { text: "no CSS splitting", tone: "warning" },
        },
        { tool: "webpack 5", build: "19.4 s", size: 409, status: { text: "slow", tone: "error" } },
      ],
    },
    {
      type: "chart",
      kind: "bar",
      unit: "s",
      labels: ["Vite 8", "Rspack", "esbuild", "webpack 5"],
      series: [
        { name: "Cold", values: [4.1, 2.7, 0.9, 19.4] },
        { name: "Warm", values: [1.2, 0.8, 0.4, 6.3] },
      ],
    },
  ],
});

const CHOICE = view("choice", "Pick a migration path", {
  type: "choice",
  id: "path",
  prompt: "How should I migrate the task files?",
  options: [
    {
      value: "in-place",
      label: "In place",
      detail: "Rewrite .relay/tasks.json into Markdown files now.",
    },
    { value: "dual", label: "Side by side", detail: "Keep both for a week, then remove the JSON." },
    { value: "later", label: "Not yet", detail: "Leave it; remind me next week." },
  ],
  submitLabel: "Go",
  reply: "Migration path",
});

// A second question is its own view: each view takes one answer.
const CHECKS = view("checks", "Checks to run first", {
  type: "choice",
  id: "checks",
  prompt: "Which checks should run first?",
  multiple: true,
  options: [
    { value: "types", label: "Typecheck" },
    { value: "lint", label: "Lint" },
    { value: "tests", label: "Tests" },
  ],
});

const CHARTS = view("charts", "Latency this week", {
  type: "tabs",
  items: [
    {
      label: "p50 / p95",
      children: [
        {
          type: "chart",
          kind: "line",
          unit: "ms",
          labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          series: [
            { name: "p50", values: [42, 40, 45, 39, 41, 38, 37] },
            { name: "p95", values: [180, 172, 240, 168, 175, 150, 149] },
          ],
        },
      ],
    },
    {
      label: "Requests",
      children: [
        {
          type: "chart",
          kind: "area",
          labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          series: [{ name: "Requests", values: [12000, 13400, 15100, 14800, 16200, 9100, 8400] }],
          height: 180,
        },
      ],
    },
    {
      label: "By route",
      children: [
        {
          type: "chart",
          kind: "bar",
          stacked: true,
          labels: ["/api/chat", "/api/search", "/mcp", "/api/file"],
          series: [
            { name: "2xx", values: [8200, 3100, 2400, 900] },
            { name: "4xx", values: [120, 40, 310, 60] },
            { name: "5xx", values: [12, 3, 25, 1] },
          ],
        },
      ],
    },
  ],
});

const REFERENCE = view("reference", "What changed", {
  type: "stack",
  children: [
    {
      type: "section",
      title: "Files",
      children: [
        { type: "file", path: "/Users/me/projects/relay/server/core/ui-render.ts" },
        { type: "chat-link", chat: "relay://chat/example", label: "Design discussion" },
      ],
    },
    {
      type: "section",
      title: "Diff",
      collapsible: true,
      children: [
        {
          type: "diff",
          path: "server/core/html-render.ts",
          patch:
            '@@ -77 +77 @@\n-  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads";\n+  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";',
        },
      ],
    },
    {
      type: "section",
      title: "Code",
      collapsible: true,
      collapsed: true,
      children: [
        {
          type: "code",
          filename: "example.ts",
          code: "export function greet(name: string) {\n  return `Hello, ${name}`;\n}",
        },
      ],
    },
    // Stands in for a node type from a newer server.
    { type: "unsupported", originalType: "hologram" },
  ],
});

export interface UiRenderScene {
  label: string;
  description: string;
  items: () => ChatItem[];
}

const intro = (text: string): ChatItem => ({ kind: "assistant", text }) as ChatItem;

export const UI_RENDER_SCENES: UiRenderScene[] = [
  {
    label: "Release checklist",
    description: "Metrics with trends, progress, status list, buttons",
    items: () => [intro("Here's where the release stands."), { kind: "ui-render", view: RELEASE }],
  },
  {
    label: "Comparison",
    description: "Markdown, sortable table with tones, grouped bar chart",
    items: () => [
      intro("I ran each bundler three times."),
      { kind: "ui-render", view: COMPARISON },
    ],
  },
  {
    label: "Choices",
    description: "Single and multiple choice, one per view, with the reply preview",
    items: () => [
      intro("Two decisions before I start."),
      { kind: "ui-render", view: CHOICE },
      { kind: "ui-render", view: CHECKS },
    ],
  },
  {
    label: "Charts",
    description: "Tabs with line, area and stacked bar charts",
    items: () => [{ kind: "ui-render", view: CHARTS }],
  },
  {
    label: "References",
    description: "Sections, file and chat links, diff, code, unsupported block",
    items: () => [{ kind: "ui-render", view: REFERENCE }],
  },
  {
    label: "All views",
    description: "Every scene in one chat",
    items: () =>
      [RELEASE, COMPARISON, CHOICE, CHECKS, CHARTS, REFERENCE].map((v) => ({
        kind: "ui-render",
        view: v,
      })),
  },
];
