/**
 * `ui_render` views: an agent describes a view as a JSON tree and Relay
 * renders it with its own components, in the chat DOM (no iframe). This file
 * is fs-free and shared with the UI (`@shared/ui-render`): the server
 * validates a spec at publish, the client validates it again at replay, and
 * both summarize it as text for `chat_read`.
 */

export const UI_RENDER_EVENT = "ui_render";
export const UI_RENDER_VERSION = 1;

export const UI_RENDER_MAX_TITLE_LENGTH = 200;
export const UI_RENDER_MAX_SPEC_BYTES = 256 * 1024;
export const UI_RENDER_MAX_DEPTH = 8;
export const UI_RENDER_MAX_NODES = 500;
export const UI_RENDER_MAX_TABLE_ROWS = 200;
export const UI_RENDER_MAX_TEXT_CHARS = 20_000;
export const UI_RENDER_MAX_CODE_CHARS = 64_000;
export const UI_RENDER_MAX_CHART_POINTS = 500;
/** A reply an action sends into the chat. */
export const UI_RENDER_MAX_REPLY_CHARS = 2_000;

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export type UiTone = "neutral" | "success" | "warning" | "error" | "info" | "accent";
export const UI_TONES: readonly UiTone[] = [
  "neutral",
  "success",
  "warning",
  "error",
  "info",
  "accent",
];

export type UiItemStatus = "done" | "running" | "pending" | "failed" | "skipped" | "warning";
export const UI_ITEM_STATUSES: readonly UiItemStatus[] = [
  "done",
  "running",
  "pending",
  "failed",
  "skipped",
  "warning",
];

/** A table cell or inline value: plain text, a number, or text with a tone and link. */
export interface UiRichText {
  text: string;
  tone?: UiTone;
  href?: string;
}
export type UiCell = string | number | UiRichText | null;

export interface UiStackNode {
  type: "stack";
  direction?: "vertical" | "horizontal";
  gap?: "sm" | "md" | "lg";
  children: UiNode[];
}
export interface UiSectionNode {
  type: "section";
  title: string;
  collapsible?: boolean;
  collapsed?: boolean;
  children: UiNode[];
}
export interface UiTextNode {
  type: "text";
  markdown: string;
}
export interface UiMetric {
  label: string;
  value: string | number;
  delta?: string;
  tone?: UiTone;
  detail?: string;
  /** A small trend line under the value. */
  trend?: number[];
}
export interface UiMetricsNode {
  type: "metrics";
  items: UiMetric[];
}
export interface UiTableColumn {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
}
export interface UiTableNode {
  type: "table";
  columns: UiTableColumn[];
  rows: Array<Record<string, UiCell>>;
  /** Rows shown before "Show all". Default 10. */
  maxRows?: number;
  sortable?: boolean;
}
export interface UiListItem {
  label: string;
  status?: UiItemStatus;
  detail?: string;
  href?: string;
}
export interface UiListNode {
  type: "list";
  items: UiListItem[];
}
export interface UiProgressNode {
  type: "progress";
  /** 0–100. */
  value: number;
  label?: string;
  tone?: UiTone;
}
export interface UiCodeNode {
  type: "code";
  code: string;
  lang?: string;
  filename?: string;
}
export interface UiDiffNode {
  type: "diff";
  patch: string;
  path?: string;
}
export interface UiTabsNode {
  type: "tabs";
  items: Array<{ label: string; children: UiNode[] }>;
}
export interface UiChatLinkNode {
  type: "chat-link";
  /** `relay://chat/<id>` or a bare chat id. */
  chat: string;
  label?: string;
}
export interface UiFileNode {
  type: "file";
  /** Absolute path. */
  path: string;
  label?: string;
}
export interface UiAction {
  id: string;
  label: string;
  /** The message a click sends into the chat, as the user. */
  reply: string;
  variant?: "primary" | "default" | "danger";
}
export interface UiActionsNode {
  type: "actions";
  items: UiAction[];
}
export interface UiChoiceOption {
  value: string;
  label: string;
  detail?: string;
}
export interface UiChoiceNode {
  type: "choice";
  id: string;
  prompt?: string;
  multiple?: boolean;
  options: UiChoiceOption[];
  submitLabel?: string;
  /** Prefix of the message sent: `<reply>: <chosen labels>`. Default: prompt, else "Selected". */
  reply?: string;
}
export interface UiChartSeries {
  name: string;
  values: number[];
}
export interface UiChartNode {
  type: "chart";
  kind: "bar" | "line" | "area";
  /** X-axis labels; each series has one value per label. */
  labels: string[];
  series: UiChartSeries[];
  /** Pixels. Default 220. */
  height?: number;
  /** Appended to axis values and tooltips, e.g. "ms" or "%". */
  unit?: string;
  stacked?: boolean;
}
/** Replay only: a node type this client doesn't know (a newer server's). */
export interface UiUnsupportedNode {
  type: "unsupported";
  originalType: string;
}

export type UiNode =
  | UiStackNode
  | UiSectionNode
  | UiTextNode
  | UiMetricsNode
  | UiTableNode
  | UiListNode
  | UiProgressNode
  | UiCodeNode
  | UiDiffNode
  | UiTabsNode
  | UiChatLinkNode
  | UiFileNode
  | UiActionsNode
  | UiChoiceNode
  | UiChartNode
  | UiUnsupportedNode;

/** The user's answer to a view's actions or choice. One per view, until the agent updates it. */
export interface UiViewResponse {
  /** An action id, or a choice id. */
  actionId: string;
  /** Chosen option values, for a choice. */
  values?: string[];
  /** The message that was sent. */
  reply: string;
  at: number;
}

/** A view as stored and replayed: the `ui_render` system event payload. */
export interface UiView {
  id: string;
  title: string;
  version: number;
  root: UiNode;
  updatedAt: number;
  response?: UiViewResponse;
}

export class UiSpecError extends Error {}

/** An answer to a view that can't be taken: `status` is the HTTP status to report. */
export class UiViewAnswerError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

export function isUiViewId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

// ── Validation ──────────────────────────────────────────────────────

interface ValidateOptions {
  /** Replay: unknown node types become `unsupported` instead of failing. */
  lenient?: boolean;
}

interface Walk {
  nodes: number;
  ids: Set<string>;
  lenient: boolean;
  /** Path of the view's one actions or choice node. */
  input?: string;
}

/** A view takes one answer, so it holds at most one actions or choice node. */
function claimInput(walk: Walk, path: string): void {
  if (walk.input && !walk.lenient) {
    fail(
      path,
      `a view takes one answer, and ${walk.input} already asks for it. Show a second question as its own view.`,
    );
  }
  walk.input ??= path;
}

type Obj = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new UiSpecError(`${path}: ${message}`);
}

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Obj {
  if (!isObject(value)) fail(path, "expected an object");
  return value;
}

function only(obj: Obj, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`${path}.${key}`, `unknown field (allowed: ${allowed.join(", ")})`);
    }
  }
}

function string(obj: Obj, key: string, path: string, max = 500): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim())
    fail(`${path}.${key}`, "expected a non-empty string");
  if (value.length > max) fail(`${path}.${key}`, `longer than ${max} characters`);
  return value;
}

function optionalString(obj: Obj, key: string, path: string, max = 500): string | undefined {
  if (obj[key] === undefined) return undefined;
  return string(obj, key, path, max);
}

function optionalBoolean(obj: Obj, key: string, path: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${path}.${key}`, "expected true or false");
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a number");
  return value;
}

function oneOf<T extends string>(
  obj: Obj,
  key: string,
  path: string,
  values: readonly T[],
): T | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(`${path}.${key}`, `expected one of ${values.join(", ")}`);
  }
  return value as T;
}

function array(obj: Obj, key: string, path: string, max: number, min = 1): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) fail(`${path}.${key}`, "expected an array");
  if (value.length < min)
    fail(`${path}.${key}`, `needs at least ${min} item${min === 1 ? "" : "s"}`);
  if (value.length > max) fail(`${path}.${key}`, `at most ${max} items`);
  return value;
}

/** http(s) and relay://chat links only; anything else is refused. */
function href(obj: Obj, key: string, path: string): string | undefined {
  const value = optionalString(obj, key, path, 2_000);
  if (value === undefined) return undefined;
  if (!/^(https?:\/\/|relay:\/\/chat\/)/i.test(value)) {
    fail(`${path}.${key}`, "links must be http(s):// or relay://chat/ URLs");
  }
  return value;
}

function uniqueId(obj: Obj, key: string, path: string, walk: Walk): string {
  const value = obj[key];
  if (!isUiViewId(value)) fail(`${path}.${key}`, "expected an id of letters, digits, _ . : -");
  if (walk.ids.has(value)) fail(`${path}.${key}`, `duplicate id "${value}" in this view`);
  walk.ids.add(value);
  return value;
}

function richText(value: unknown, path: string): UiRichText {
  const obj = object(value, path);
  only(obj, path, ["text", "tone", "href"]);
  const text = obj.text;
  if (typeof text !== "string") fail(`${path}.text`, "expected a string");
  if (text.length > 2_000) fail(`${path}.text`, "longer than 2000 characters");
  const tone = oneOf(obj, "tone", path, UI_TONES);
  const link = href(obj, "href", path);
  return { text, ...(tone ? { tone } : {}), ...(link ? { href: link } : {}) };
}

function cell(value: unknown, path: string): UiCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length > 2_000) fail(path, "longer than 2000 characters");
    return value;
  }
  if (typeof value === "number") return finiteNumber(value, path);
  if (isObject(value)) return richText(value, path);
  return fail(path, "expected a string, number, or {text, tone, href}");
}

function children(obj: Obj, path: string, walk: Walk, depth: number, max = 100): UiNode[] {
  return array(obj, "children", path, max).map((child, i) =>
    node(child, `${path}.children[${i}]`, walk, depth + 1),
  );
}

function numbers(obj: Obj, key: string, path: string, max: number): number[] {
  return array(obj, key, path, max).map((v, i) => finiteNumber(v, `${path}.${key}[${i}]`));
}

function node(value: unknown, path: string, walk: Walk, depth: number): UiNode {
  if (depth > UI_RENDER_MAX_DEPTH) fail(path, `nested deeper than ${UI_RENDER_MAX_DEPTH} levels`);
  walk.nodes += 1;
  if (walk.nodes > UI_RENDER_MAX_NODES) fail(path, `more than ${UI_RENDER_MAX_NODES} nodes`);
  const obj = object(value, path);
  const type = obj.type;
  switch (type) {
    case "stack": {
      only(obj, path, ["type", "direction", "gap", "children"]);
      const direction = oneOf(obj, "direction", path, ["vertical", "horizontal"] as const);
      const gap = oneOf(obj, "gap", path, ["sm", "md", "lg"] as const);
      return {
        type,
        ...(direction ? { direction } : {}),
        ...(gap ? { gap } : {}),
        children: children(obj, path, walk, depth),
      };
    }
    case "section": {
      only(obj, path, ["type", "title", "collapsible", "collapsed", "children"]);
      const collapsible = optionalBoolean(obj, "collapsible", path);
      const collapsed = optionalBoolean(obj, "collapsed", path);
      return {
        type,
        title: string(obj, "title", path, UI_RENDER_MAX_TITLE_LENGTH),
        ...(collapsible !== undefined ? { collapsible } : {}),
        ...(collapsed !== undefined ? { collapsed } : {}),
        children: children(obj, path, walk, depth),
      };
    }
    case "text": {
      only(obj, path, ["type", "markdown"]);
      return { type, markdown: string(obj, "markdown", path, UI_RENDER_MAX_TEXT_CHARS) };
    }
    case "metrics": {
      only(obj, path, ["type", "items"]);
      const items = array(obj, "items", path, 12).map((raw, i): UiMetric => {
        const p = `${path}.items[${i}]`;
        const item = object(raw, p);
        only(item, p, ["label", "value", "delta", "tone", "detail", "trend"]);
        const metricValue = item.value;
        if (typeof metricValue !== "string" && typeof metricValue !== "number") {
          fail(`${p}.value`, "expected a string or number");
        }
        if (typeof metricValue === "number") finiteNumber(metricValue, `${p}.value`);
        if (typeof metricValue === "string" && metricValue.length > 100) {
          fail(`${p}.value`, "longer than 100 characters");
        }
        const delta = optionalString(item, "delta", p, 40);
        const tone = oneOf(item, "tone", p, UI_TONES);
        const detail = optionalString(item, "detail", p, 200);
        const trend = item.trend === undefined ? undefined : numbers(item, "trend", p, 200);
        return {
          label: string(item, "label", p, 100),
          value: metricValue,
          ...(delta ? { delta } : {}),
          ...(tone ? { tone } : {}),
          ...(detail ? { detail } : {}),
          ...(trend ? { trend } : {}),
        };
      });
      return { type, items };
    }
    case "table": {
      only(obj, path, ["type", "columns", "rows", "maxRows", "sortable"]);
      const keys = new Set<string>();
      const columns = array(obj, "columns", path, 20).map((raw, i): UiTableColumn => {
        const p = `${path}.columns[${i}]`;
        const column = object(raw, p);
        only(column, p, ["key", "label", "align"]);
        const key = string(column, "key", p, 64);
        if (keys.has(key)) fail(`${p}.key`, `duplicate column key "${key}"`);
        keys.add(key);
        const align = oneOf(column, "align", p, ["left", "center", "right"] as const);
        return { key, label: string(column, "label", p, 100), ...(align ? { align } : {}) };
      });
      const rows = array(obj, "rows", path, UI_RENDER_MAX_TABLE_ROWS, 0).map((raw, i) => {
        const p = `${path}.rows[${i}]`;
        const row = object(raw, p);
        const out: Record<string, UiCell> = {};
        for (const [key, v] of Object.entries(row)) {
          if (!keys.has(key)) fail(`${p}.${key}`, "not one of the table's column keys");
          out[key] = cell(v, `${p}.${key}`);
        }
        return out;
      });
      let maxRows: number | undefined;
      if (obj.maxRows !== undefined) {
        maxRows = finiteNumber(obj.maxRows, `${path}.maxRows`);
        if (!Number.isInteger(maxRows) || maxRows < 1)
          fail(`${path}.maxRows`, "expected a whole number ≥ 1");
      }
      const sortable = optionalBoolean(obj, "sortable", path);
      return {
        type,
        columns,
        rows,
        ...(maxRows !== undefined ? { maxRows } : {}),
        ...(sortable !== undefined ? { sortable } : {}),
      };
    }
    case "list": {
      only(obj, path, ["type", "items"]);
      const items = array(obj, "items", path, 100).map((raw, i): UiListItem => {
        const p = `${path}.items[${i}]`;
        const item = object(raw, p);
        only(item, p, ["label", "status", "detail", "href"]);
        const status = oneOf(item, "status", p, UI_ITEM_STATUSES);
        const detail = optionalString(item, "detail", p, 1_000);
        const link = href(item, "href", p);
        return {
          label: string(item, "label", p, 500),
          ...(status ? { status } : {}),
          ...(detail ? { detail } : {}),
          ...(link ? { href: link } : {}),
        };
      });
      return { type, items };
    }
    case "progress": {
      only(obj, path, ["type", "value", "label", "tone"]);
      const progress = finiteNumber(obj.value, `${path}.value`);
      if (progress < 0 || progress > 100) fail(`${path}.value`, "expected 0–100");
      const label = optionalString(obj, "label", path, 200);
      const tone = oneOf(obj, "tone", path, UI_TONES);
      return { type, value: progress, ...(label ? { label } : {}), ...(tone ? { tone } : {}) };
    }
    case "code": {
      only(obj, path, ["type", "code", "lang", "filename"]);
      const lang = optionalString(obj, "lang", path, 32);
      const filename = optionalString(obj, "filename", path, 300);
      return {
        type,
        code: string(obj, "code", path, UI_RENDER_MAX_CODE_CHARS),
        ...(lang ? { lang } : {}),
        ...(filename ? { filename } : {}),
      };
    }
    case "diff": {
      only(obj, path, ["type", "patch", "path"]);
      const file = optionalString(obj, "path", path, 300);
      return {
        type,
        patch: string(obj, "patch", path, UI_RENDER_MAX_CODE_CHARS),
        ...(file ? { path: file } : {}),
      };
    }
    case "tabs": {
      only(obj, path, ["type", "items"]);
      const items = array(obj, "items", path, 12).map((raw, i) => {
        const p = `${path}.items[${i}]`;
        const item = object(raw, p);
        only(item, p, ["label", "children"]);
        return { label: string(item, "label", p, 60), children: children(item, p, walk, depth) };
      });
      return { type, items };
    }
    case "chat-link": {
      only(obj, path, ["type", "chat", "label"]);
      const chat = string(obj, "chat", path, 200);
      if (!/^(relay:\/\/chat\/)?[\w-]+$/.test(chat)) {
        fail(`${path}.chat`, "expected relay://chat/<id> or a chat id");
      }
      const label = optionalString(obj, "label", path, 200);
      return { type, chat, ...(label ? { label } : {}) };
    }
    case "file": {
      only(obj, path, ["type", "path", "label"]);
      const file = string(obj, "path", path, 1_000);
      if (!file.startsWith("/") && !/^[a-z]:[\\/]/i.test(file)) {
        fail(`${path}.path`, "expected an absolute path");
      }
      const label = optionalString(obj, "label", path, 200);
      return { type, path: file, ...(label ? { label } : {}) };
    }
    case "actions": {
      only(obj, path, ["type", "items"]);
      claimInput(walk, path);
      const items = array(obj, "items", path, 6).map((raw, i): UiAction => {
        const p = `${path}.items[${i}]`;
        const item = object(raw, p);
        only(item, p, ["id", "label", "reply", "variant"]);
        const variant = oneOf(item, "variant", p, ["primary", "default", "danger"] as const);
        return {
          id: uniqueId(item, "id", p, walk),
          label: string(item, "label", p, 60),
          reply: string(item, "reply", p, UI_RENDER_MAX_REPLY_CHARS),
          ...(variant ? { variant } : {}),
        };
      });
      return { type, items };
    }
    case "choice": {
      only(obj, path, ["type", "id", "prompt", "multiple", "options", "submitLabel", "reply"]);
      claimInput(walk, path);
      const id = uniqueId(obj, "id", path, walk);
      const values = new Set<string>();
      const options = array(obj, "options", path, 20, 2).map((raw, i): UiChoiceOption => {
        const p = `${path}.options[${i}]`;
        const option = object(raw, p);
        only(option, p, ["value", "label", "detail"]);
        const optionValue = string(option, "value", p, 100);
        if (values.has(optionValue)) fail(`${p}.value`, `duplicate option value "${optionValue}"`);
        values.add(optionValue);
        const detail = optionalString(option, "detail", p, 300);
        return {
          value: optionValue,
          label: string(option, "label", p, 200),
          ...(detail ? { detail } : {}),
        };
      });
      const prompt = optionalString(obj, "prompt", path, 500);
      const multiple = optionalBoolean(obj, "multiple", path);
      const submitLabel = optionalString(obj, "submitLabel", path, 60);
      const reply = optionalString(obj, "reply", path, 500);
      return {
        type,
        id,
        ...(prompt ? { prompt } : {}),
        ...(multiple !== undefined ? { multiple } : {}),
        options,
        ...(submitLabel ? { submitLabel } : {}),
        ...(reply ? { reply } : {}),
      };
    }
    case "chart": {
      only(obj, path, ["type", "kind", "labels", "series", "height", "unit", "stacked"]);
      const kind = oneOf(obj, "kind", path, ["bar", "line", "area"] as const);
      if (!kind) fail(`${path}.kind`, "expected one of bar, line, area");
      const labels = array(obj, "labels", path, UI_RENDER_MAX_CHART_POINTS).map((v, i) => {
        if (typeof v !== "string" && typeof v !== "number")
          fail(`${path}.labels[${i}]`, "expected a string");
        return String(v).slice(0, 60);
      });
      const series = array(obj, "series", path, 8).map((raw, i): UiChartSeries => {
        const p = `${path}.series[${i}]`;
        const s = object(raw, p);
        only(s, p, ["name", "values"]);
        const values = numbers(s, "values", p, UI_RENDER_MAX_CHART_POINTS);
        if (values.length !== labels.length) {
          fail(`${p}.values`, `has ${values.length} values for ${labels.length} labels`);
        }
        return { name: string(s, "name", p, 60), values };
      });
      let height: number | undefined;
      if (obj.height !== undefined) {
        height = finiteNumber(obj.height, `${path}.height`);
        if (height < 80 || height > 600) fail(`${path}.height`, "expected 80–600");
      }
      const unit = optionalString(obj, "unit", path, 12);
      const stacked = optionalBoolean(obj, "stacked", path);
      return {
        type,
        kind,
        labels,
        series,
        ...(height !== undefined ? { height: Math.round(height) } : {}),
        ...(unit ? { unit } : {}),
        ...(stacked !== undefined ? { stacked } : {}),
      };
    }
    default: {
      const name = typeof type === "string" ? type : "";
      if (walk.lenient && name) return { type: "unsupported", originalType: name.slice(0, 40) };
      return fail(
        `${path}.type`,
        `unknown node type ${name ? `"${name}"` : "(missing)"}. Use one of: ${PUBLIC_NODE_TYPES.join(", ")}`,
      );
    }
  }
}

export const PUBLIC_NODE_TYPES = [
  "stack",
  "section",
  "text",
  "metrics",
  "table",
  "list",
  "progress",
  "code",
  "diff",
  "tabs",
  "chat-link",
  "file",
  "actions",
  "choice",
  "chart",
] as const;

/** Validate and normalize a spec's root node. Throws `UiSpecError` naming the bad path. */
export function validateUiRoot(root: unknown, options: ValidateOptions = {}): UiNode {
  const walk: Walk = { nodes: 0, ids: new Set(), lenient: options.lenient === true };
  const out = node(root, "root", walk, 1);
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  if (!options.lenient && bytes > UI_RENDER_MAX_SPEC_BYTES) {
    fail(
      "root",
      `the view is ${Math.ceil(bytes / 1024)} KB; the limit is ${UI_RENDER_MAX_SPEC_BYTES / 1024} KB`,
    );
  }
  return out;
}

/** A stored or live payload as a view, or null when malformed. Lenient about new node types. */
export function readUiView(payload: unknown): UiView | null {
  if (!isObject(payload)) return null;
  const { id, title, version, root, updatedAt, response } = payload;
  if (!isUiViewId(id) || typeof title !== "string" || typeof updatedAt !== "number") return null;
  let node: UiNode;
  try {
    node = validateUiRoot(root, { lenient: true });
  } catch {
    return null;
  }
  const answer = readResponse(response);
  return {
    id,
    title: title.slice(0, UI_RENDER_MAX_TITLE_LENGTH),
    version: typeof version === "number" ? version : UI_RENDER_VERSION,
    root: node,
    updatedAt,
    ...(answer ? { response: answer } : {}),
  };
}

function readResponse(value: unknown): UiViewResponse | undefined {
  if (!isObject(value)) return undefined;
  const { actionId, values, reply, at } = value;
  if (typeof actionId !== "string" || typeof reply !== "string" || typeof at !== "number") {
    return undefined;
  }
  const chosen = Array.isArray(values)
    ? values.filter((v): v is string => typeof v === "string")
    : undefined;
  return { actionId, reply, at, ...(chosen ? { values: chosen } : {}) };
}

// ── Actions ─────────────────────────────────────────────────────────

/** Every node in a view, depth first. */
export function walkUiNodes(root: UiNode, visit: (node: UiNode) => void): void {
  visit(root);
  switch (root.type) {
    case "stack":
    case "section":
      for (const child of root.children) walkUiNodes(child, visit);
      break;
    case "tabs":
      for (const tab of root.items) for (const child of tab.children) walkUiNodes(child, visit);
      break;
    default:
      break;
  }
}

/** The message a choice sends: `<reply or prompt or "Selected">: <labels>`. */
export function choiceReply(choice: UiChoiceNode, values: readonly string[]): string {
  const labels = choice.options.filter((o) => values.includes(o.value)).map((o) => o.label);
  return `${choice.reply ?? choice.prompt ?? "Selected"}: ${labels.join(", ")}`;
}

export type UiResponseResolution =
  | { ok: true; reply: string; values?: string[] }
  | { ok: false; message: string };

/**
 * The reply an answer sends, derived from the view (never from the client):
 * what the user saw on the button is what goes into the chat.
 */
export function resolveUiResponse(
  view: UiView,
  actionId: string,
  values?: unknown,
): UiResponseResolution {
  if (view.response) return { ok: false, message: "This view was already answered." };
  let result: UiResponseResolution = { ok: false, message: "That action is not in this view." };
  walkUiNodes(view.root, (n) => {
    if (n.type === "actions") {
      const action = n.items.find((a) => a.id === actionId);
      if (action) result = { ok: true, reply: action.reply };
    } else if (n.type === "choice" && n.id === actionId) {
      const chosen = Array.isArray(values)
        ? [...new Set(values.filter((v): v is string => typeof v === "string"))]
        : [];
      const known = chosen.filter((v) => n.options.some((o) => o.value === v));
      if (known.length === 0 || known.length !== chosen.length) {
        result = { ok: false, message: "Choose one of the options." };
      } else if (!n.multiple && known.length > 1) {
        result = { ok: false, message: "Choose only one option." };
      } else {
        result = { ok: true, reply: choiceReply(n, known), values: known };
      }
    }
  });
  return result;
}

// ── Text summary (chat_read) ────────────────────────────────────────

function cellText(value: UiCell): string {
  if (value === null) return "";
  if (typeof value === "object") return value.text;
  return String(value);
}

/** A plain-text rendering of a view, for agents reading the chat. */
export function summarizeUiView(view: UiView): string {
  const lines: string[] = [`[View] ${view.title}`];
  const add = (n: UiNode, indent: string) => {
    switch (n.type) {
      case "stack":
        for (const c of n.children) add(c, indent);
        break;
      case "section":
        lines.push(`${indent}## ${n.title}`);
        for (const c of n.children) add(c, indent);
        break;
      case "tabs":
        for (const tab of n.items) {
          lines.push(`${indent}### ${tab.label}`);
          for (const c of tab.children) add(c, indent);
        }
        break;
      case "text":
        lines.push(indent + n.markdown);
        break;
      case "metrics":
        lines.push(
          indent +
            n.items
              .map((m) => `${m.label}: ${m.value}${m.delta ? ` (${m.delta})` : ""}`)
              .join(" · "),
        );
        break;
      case "table":
        lines.push(indent + n.columns.map((c) => c.label).join(" | "));
        for (const row of n.rows) {
          lines.push(indent + n.columns.map((c) => cellText(row[c.key] ?? null)).join(" | "));
        }
        break;
      case "list":
        for (const item of n.items) {
          lines.push(
            `${indent}- ${item.status ? `[${item.status}] ` : ""}${item.label}${item.detail ? ` — ${item.detail}` : ""}`,
          );
        }
        break;
      case "progress":
        lines.push(`${indent}${n.label ?? "Progress"}: ${Math.round(n.value)}%`);
        break;
      case "code":
        lines.push(
          `${indent}[code${n.filename ? `: ${n.filename}` : ""}, ${n.code.split("\n").length} lines]`,
        );
        break;
      case "diff":
        lines.push(`${indent}[diff${n.path ? `: ${n.path}` : ""}]`);
        break;
      case "chat-link":
        lines.push(`${indent}${n.label ?? "Chat"}: ${n.chat}`);
        break;
      case "file":
        lines.push(`${indent}${n.label ?? "File"}: ${n.path}`);
        break;
      case "actions":
        lines.push(`${indent}Buttons: ${n.items.map((a) => a.label).join(", ")}`);
        break;
      case "choice":
        lines.push(
          `${indent}${n.prompt ?? "Choice"}: ${n.options.map((o) => o.label).join(" / ")}`,
        );
        break;
      case "chart":
        lines.push(
          `${indent}[${n.kind} chart: ${n.series.map((s) => s.name).join(", ")} over ${n.labels.length} points]`,
        );
        break;
      case "unsupported":
        break;
    }
  };
  add(view.root, "");
  if (view.response) lines.push(`Answered: ${view.response.reply}`);
  return lines.join("\n");
}

// ── Tool guidance ───────────────────────────────────────────────────

export const UI_RENDER_TOOL_DESCRIPTION = [
  "Show a native Relay view inline in this chat, above your reply: status boards, checklists, comparisons, tables, small charts, and buttons or choices the user can answer. Prefer it to your built-in question tool when seeing data would help the user decide.",
  "Pass `id` to update a view you showed earlier in place (it keeps its position; use it for progress you report repeatedly). Views belong to this chat.",
  "Use markdown for prose and small tables; html_render for custom visuals, diagrams, and anything this catalogue can't express.",
  "Nodes (`type`):",
  "stack {children, direction?: vertical|horizontal, gap?: sm|md|lg};",
  "section {title, children, collapsible?, collapsed?};",
  "text {markdown};",
  "metrics {items: [{label, value, delta?, tone?, detail?, trend?: number[]}]};",
  "table {columns: [{key, label, align?}], rows: [{<key>: cell}], maxRows?, sortable?} where cell is a string, number, or {text, tone?, href?};",
  "list {items: [{label, status?: done|running|pending|failed|skipped|warning, detail?, href?}]};",
  "progress {value: 0-100, label?, tone?};",
  "code {code, lang?, filename?}; diff {patch (unified), path?};",
  "tabs {items: [{label, children}]};",
  "chat-link {chat: relay://chat/<id>, label?}; file {path (absolute), label?};",
  "chart {kind: bar|line|area, labels: string[], series: [{name, values: number[] (one per label)}], height?, unit?, stacked?};",
  "actions {items: [{id, label, reply, variant?: primary|default|danger}]} or choice {id, options: [{value, label, detail?}], prompt?, multiple?, submitLabel?, reply?}: at most one of these per view; ask a second question in a second view.",
  "tone: neutral|success|warning|error|info|accent. Links are http(s) or relay://chat only.",
  "A button or choice sends its reply into this chat as the user's next message, once per view; you read the answer as that message. Updating the view clears its answer.",
].join(" ");
