import { describe, expect, it } from "vitest";
import type { UiView } from "@shared/ui-render";
import { replayHistoryToItems } from "@/hooks/use-instance-messages";
import type { ChatItem } from "@/lib/chat-types";
import { formatChartValue, niceTicks, upsertUiViewItem } from "@/lib/ui-render-layout";
import type { HistoryEntry } from "@shared/types";

const view = (title: string, extra: Partial<UiView> = {}): UiView => ({
  id: "board",
  title,
  version: 1,
  updatedAt: 1,
  root: { type: "progress", value: 50 },
  ...extra,
});

describe("ui_render views in the chat", () => {
  it("replays a view and drops malformed ones", () => {
    const items = replayHistoryToItems([
      { timestamp: 1, message: { type: "output", text: "Status:", isWaiting: false } },
      {
        timestamp: 2,
        message: { type: "system_event", event: "ui_render", payload: view("Board") },
      },
      {
        timestamp: 3,
        message: { type: "system_event", event: "ui_render", payload: { id: "x", root: {} } },
      },
    ] as unknown as HistoryEntry[]);
    expect(items.map((item) => item.kind)).toEqual(["assistant", "ui-render"]);
  });

  it("replaces a live view where it is instead of appending another", () => {
    const first: ChatItem[] = [
      { kind: "assistant", text: "Status:" } as ChatItem,
      { kind: "ui-render", view: view("Board"), timestamp: 1 },
      { kind: "assistant", text: "Later" } as ChatItem,
    ];
    const next = upsertUiViewItem(first, view("Board, done", { updatedAt: 2 }), 5);
    expect(next.map((item) => item.kind)).toEqual(["assistant", "ui-render", "assistant"]);
    expect(next[1]).toMatchObject({
      kind: "ui-render",
      timestamp: 1,
      view: { title: "Board, done" },
    });
    const added = upsertUiViewItem(next, view("New", { id: "other" }), 6);
    expect(added.at(-1)).toMatchObject({ kind: "ui-render", view: { id: "other" } });
  });
});

describe("chart helpers", () => {
  it("picks round ticks that cover the data", () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-3, 7)).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });

  it("formats compact values with units", () => {
    expect(formatChartValue(1349)).toBe("1349");
    expect(formatChartValue(12_500)).toBe("12.5k");
    expect(formatChartValue(2_000_000, "ms")).toBe("2M ms");
    expect(formatChartValue(42.5, "%")).toBe("42.5%");
  });
});
