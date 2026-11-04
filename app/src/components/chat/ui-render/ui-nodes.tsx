import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileText,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import type {
  UiActionsNode,
  UiCell,
  UiChoiceNode,
  UiItemStatus,
  UiListNode,
  UiMetricsNode,
  UiNode,
  UiTableNode,
} from "@shared/ui-render";
import { choiceReply } from "@shared/ui-render";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs } from "@/components/ui/tabs";
import { ActivityCodeBlock, langFromPath, PatchDiffView } from "@/components/chat/activity-code";
import { ChatLinkChip } from "@/components/chat/chat-link-chip";
import { LINK_CHIP_CLASS, MarkdownContent } from "@/components/chat/markdown-content";
import { useUiAnswer } from "@/components/chat/ui-render/ui-answer-context";
import { Sparkline, UiChart } from "@/components/chat/ui-render/ui-chart";
import { parseChatLinkHref } from "@/lib/chat-links";
import { TONE_CHIP, TONE_FILL, TONE_TEXT } from "@/lib/ui-render-layout";

const GAP = { sm: "gap-2", md: "gap-3", lg: "gap-5" } as const;

export function UiNodeView({ node }: { node: UiNode }): ReactNode {
  switch (node.type) {
    case "stack":
      return (
        <div
          className={`flex ${GAP[node.gap ?? "md"]} ${
            node.direction === "horizontal"
              ? "flex-row flex-wrap *:min-w-[12rem] *:flex-1"
              : "flex-col"
          }`}
        >
          {node.children.map((child, i) => (
            <UiNodeView key={i} node={child} />
          ))}
        </div>
      );
    case "section":
      return <UiSection node={node} />;
    case "text":
      return (
        <div className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <MarkdownContent text={node.markdown} />
        </div>
      );
    case "metrics":
      return <UiMetrics node={node} />;
    case "table":
      return <UiTable node={node} />;
    case "list":
      return <UiList node={node} />;
    case "progress":
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-[0.75rem]">
            <span className="min-w-0 truncate text-text">{node.label ?? "Progress"}</span>
            <span className="tabular-nums text-muted">{Math.round(node.value)}%</span>
          </div>
          <Progress
            value={node.value}
            indicatorClass={TONE_FILL[node.tone ?? "accent"]}
            className="[&>div]:h-1.5"
          />
        </div>
      );
    case "code":
      return (
        <ActivityCodeBlock
          content={node.code}
          label={node.filename}
          lang={node.lang ?? langFromPath(node.filename)}
        />
      );
    case "diff":
      return <PatchDiffView diff={node.patch} label={node.path} />;
    case "tabs":
      return (
        <Tabs.Root defaultValue="0">
          <Tabs.List className="mb-2 w-fit max-w-full overflow-x-auto [scrollbar-width:none]">
            {node.items.map((tab, i) => (
              <Tabs.Tab key={i} value={String(i)} className="whitespace-nowrap max-[768px]:py-1.5">
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          {node.items.map((tab, i) => (
            <Tabs.Panel key={i} value={String(i)} className="flex flex-col gap-3">
              {tab.children.map((child, j) => (
                <UiNodeView key={j} node={child} />
              ))}
            </Tabs.Panel>
          ))}
        </Tabs.Root>
      );
    case "chat-link":
      return (
        <div>
          <ChatLinkChip
            chatId={node.chat.replace(/^relay:\/\/chat\//, "")}
            label={node.label}
            className={LINK_CHIP_CLASS}
          />
        </div>
      );
    case "file":
      return (
        <div>
          <a
            href={`/api/file?path=${encodeURIComponent(node.path)}`}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CHIP_CLASS}
            title={node.path}
          >
            <FileText size={12} className="h-3 w-3 shrink-0 text-muted" />
            <span className="max-w-[20rem] truncate">
              {node.label ?? node.path.split(/[\\/]/).pop()}
            </span>
          </a>
        </div>
      );
    case "actions":
      return <UiActions node={node} />;
    case "choice":
      return <UiChoice node={node} />;
    case "chart":
      return <UiChart node={node} />;
    case "unsupported":
      return (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-[0.75rem] text-muted">
          This part of the view ({node.originalType}) needs a newer version of Relay.
        </div>
      );
  }
}

function UiSection({ node }: { node: Extract<UiNode, { type: "section" }> }) {
  const [open, setOpen] = useState(!node.collapsed);
  const body = (
    <div className="flex flex-col gap-3">
      {node.children.map((child, i) => (
        <UiNodeView key={i} node={child} />
      ))}
    </div>
  );
  if (!node.collapsible) {
    return (
      <section className="flex flex-col gap-2">
        <h4 className="m-0 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">
          {node.title}
        </h4>
        {body}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted hover:text-text max-[768px]:min-h-10"
      >
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {node.title}
      </button>
      {open && body}
    </section>
  );
}

function UiMetrics({ node }: { node: UiMetricsNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
      {node.items.map((metric, i) => (
        <div key={i} className="min-w-0 rounded-md border border-border/70 bg-bg/40 px-3 py-2">
          <div className="truncate text-[0.6875rem] text-muted">{metric.label}</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span
              className={`truncate text-lg font-semibold tabular-nums ${
                metric.tone ? TONE_TEXT[metric.tone] : "text-text-bright"
              }`}
            >
              {typeof metric.value === "number" ? metric.value.toLocaleString() : metric.value}
            </span>
            {metric.delta && (
              <span
                className={`shrink-0 rounded px-1 text-[0.625rem] font-medium ${
                  TONE_CHIP[metric.tone ?? "neutral"]
                }`}
              >
                {metric.delta}
              </span>
            )}
          </div>
          {metric.trend && metric.trend.length > 1 && (
            <Sparkline values={metric.trend} tone={metric.tone} />
          )}
          {metric.detail && (
            <div className="mt-0.5 truncate text-[0.6875rem] text-muted">{metric.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function UiLink({ href, children }: { href: string; children: ReactNode }) {
  const chatId = parseChatLinkHref(href);
  if (chatId) {
    return <ChatLinkChip chatId={chatId} label={String(children)} className={LINK_CHIP_CLASS} />;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

function UiCellView({ value }: { value: UiCell | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted/60">—</span>;
  if (typeof value === "number") return <>{value.toLocaleString()}</>;
  if (typeof value === "string") return <>{value}</>;
  const text = value.href ? <UiLink href={value.href}>{value.text}</UiLink> : value.text;
  if (!value.tone) return <>{text}</>;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-px text-[0.75rem] font-medium ${TONE_CHIP[value.tone]}`}
    >
      {text}
    </span>
  );
}

function sortKey(value: UiCell | undefined): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return value.text;
  return value;
}

function UiTable({ node }: { node: UiTableNode }) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => {
    if (!sort) return node.rows;
    return [...node.rows].sort((a, b) => {
      const x = sortKey(a[sort.key]);
      const y = sortKey(b[sort.key]);
      const order =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.desc ? -order : order;
    });
  }, [node.rows, sort]);
  const limit = node.maxRows ?? 10;
  const visible = showAll ? rows : rows.slice(0, limit);
  const align = (a?: string) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

  return (
    <div className="flex flex-col gap-1">
      <div className="overflow-x-auto rounded-md border border-border/70">
        <table className="w-full border-collapse text-[0.8125rem]">
          <thead>
            <tr className="bg-surface-hover/60">
              {node.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`whitespace-nowrap px-3 py-1.5 text-[0.6875rem] font-semibold text-muted ${align(column.align)}`}
                  aria-sort={
                    sort?.key === column.key ? (sort.desc ? "descending" : "ascending") : undefined
                  }
                >
                  {node.sortable ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-text"
                      onClick={() =>
                        setSort((s) =>
                          s?.key === column.key
                            ? s.desc
                              ? null
                              : { key: column.key, desc: true }
                            : { key: column.key, desc: false },
                        )
                      }
                    >
                      {column.label}
                      {sort?.key === column.key &&
                        (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={i} className="border-t border-border/50">
                {node.columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-3 py-1.5 align-top text-text ${align(column.align)} ${
                      column.align === "right" ? "tabular-nums" : ""
                    }`}
                  >
                    <UiCellView value={row[column.key]} />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={node.columns.length} className="px-3 py-3 text-center text-muted">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="w-fit text-[0.75rem] text-muted hover:text-text max-[768px]:min-h-10"
        >
          {showAll ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

const STATUS_ICON: Record<UiItemStatus, { icon: ReactNode; label: string }> = {
  done: { icon: <CheckCircle2 size={15} className="text-success" />, label: "Done" },
  running: { icon: <Loader2 size={15} className="animate-spin text-accent" />, label: "Running" },
  pending: { icon: <Circle size={15} className="text-muted/60" />, label: "Pending" },
  failed: { icon: <XCircle size={15} className="text-error" />, label: "Failed" },
  skipped: { icon: <MinusCircle size={15} className="text-muted/60" />, label: "Skipped" },
  warning: { icon: <AlertTriangle size={15} className="text-warning" />, label: "Warning" },
};

function UiList({ node }: { node: UiListNode }) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {node.items.map((item, i) => {
        const status = item.status ? STATUS_ICON[item.status] : null;
        return (
          <li key={i} className="flex gap-2 py-1">
            <span
              className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center"
              title={status?.label}
            >
              {status ? status.icon : <span className="h-1.5 w-1.5 rounded-full bg-muted/60" />}
              {status && <span className="sr-only">{status.label}</span>}
            </span>
            <div className="min-w-0 flex-1">
              <div className={item.status === "skipped" ? "text-muted line-through" : "text-text"}>
                {item.href ? <UiLink href={item.href}>{item.label}</UiLink> : item.label}
              </div>
              {item.detail && <div className="text-[0.75rem] text-muted">{item.detail}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Shown under an input when what it sends differs from what it says. */
function SendsPreview({ reply }: { reply: string }) {
  return (
    <p className="m-0 text-[0.6875rem] text-muted">
      Sends: <span className="text-text">“{reply}”</span>
    </p>
  );
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function UiActions({ node }: { node: UiActionsNode }) {
  const { response, pending, answer } = useUiAnswer();
  const [focused, setFocused] = useState<string | null>(null);
  const answered = response ? node.items.find((a) => a.id === response.actionId) : undefined;
  const hint =
    node.items.find((a) => a.id === focused) ??
    (node.items.length === 1 ? node.items[0] : undefined);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {node.items.map((action) => {
          const chosen = answered?.id === action.id;
          const variant = action.variant ?? "default";
          return (
            <Button
              key={action.id}
              type="button"
              variant={
                variant === "primary" ? "primary" : variant === "danger" ? "danger" : "ghost"
              }
              className={`max-[768px]:min-h-10 ${variant === "primary" ? "" : "border border-border"} ${
                chosen ? "!opacity-100 ring-2 ring-accent/40" : ""
              }`}
              disabled={response !== undefined || pending !== null}
              onClick={() => answer(action.id)}
              onMouseEnter={() => setFocused(action.id)}
              onFocus={() => setFocused(action.id)}
              onMouseLeave={() => setFocused(null)}
              onBlur={() => setFocused(null)}
            >
              {pending === action.id ? (
                <Loader2 size={13} className="animate-spin" />
              ) : chosen ? (
                <Check size={13} />
              ) : null}
              {action.label}
            </Button>
          );
        })}
      </div>
      {response ? (
        answered ? (
          <p className="m-0 text-[0.6875rem] text-muted">
            Sent: <span className="text-text">“{response.reply}”</span>
          </p>
        ) : null
      ) : hint && !sameText(hint.reply, hint.label) ? (
        <SendsPreview reply={hint.reply} />
      ) : (
        // Touch has no hover: list every reply that differs from its label.
        node.items.some((a) => !sameText(a.reply, a.label)) && (
          <div className="hidden flex-col gap-0.5 [@media(pointer:coarse)]:flex">
            {node.items
              .filter((a) => !sameText(a.reply, a.label))
              .map((a) => (
                <p key={a.id} className="m-0 text-[0.6875rem] text-muted">
                  {a.label}: <span className="text-text">“{a.reply}”</span>
                </p>
              ))}
          </div>
        )
      )}
    </div>
  );
}

function UiChoice({ node }: { node: UiChoiceNode }) {
  const { response, pending, answer } = useUiAnswer();
  const mine = response?.actionId === node.id ? response : undefined;
  const [selected, setSelected] = useState<string[]>([]);
  const values = mine?.values ?? selected;
  const locked = response !== undefined || pending !== null;
  const toggle = (value: string, on: boolean) =>
    setSelected((current) =>
      on ? [...current.filter((v) => v !== value), value] : current.filter((v) => v !== value),
    );

  return (
    <div className="flex flex-col gap-2">
      {node.prompt && <p className="m-0 font-medium text-text">{node.prompt}</p>}
      {node.multiple ? (
        <div className="flex flex-col gap-1">
          {node.options.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-hover max-[768px]:min-h-10"
            >
              <Checkbox
                className="mt-0.5"
                checked={values.includes(option.value)}
                disabled={locked}
                onCheckedChange={(on) => toggle(option.value, on)}
              />
              <OptionText label={option.label} detail={option.detail} />
            </label>
          ))}
        </div>
      ) : (
        <RadioGroup
          value={values[0] ?? ""}
          onValueChange={(value) => setSelected([value])}
          disabled={locked}
          className="!flex-col !gap-1"
        >
          {node.options.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-hover max-[768px]:min-h-10"
            >
              <RadioGroupItem value={option.value} className="mt-0.5" />
              <OptionText label={option.label} detail={option.detail} />
            </label>
          ))}
        </RadioGroup>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          className="max-[768px]:min-h-10"
          disabled={locked || values.length === 0}
          onClick={() => answer(node.id, values)}
        >
          {pending === node.id && <Loader2 size={13} className="animate-spin" />}
          {mine && <Check size={13} />}
          {mine ? "Sent" : (node.submitLabel ?? "Send")}
        </Button>
        {mine ? (
          <p className="m-0 text-[0.6875rem] text-muted">
            Sent: <span className="text-text">“{mine.reply}”</span>
          </p>
        ) : (
          !locked && values.length > 0 && <SendsPreview reply={choiceReply(node, values)} />
        )}
      </div>
    </div>
  );
}

function OptionText({ label, detail }: { label: string; detail?: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-text">{label}</span>
      {detail && <span className="block text-[0.75rem] text-muted">{detail}</span>}
    </span>
  );
}
