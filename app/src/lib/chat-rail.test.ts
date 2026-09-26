import { describe, expect, it } from "vitest";
import type { RenderRow } from "./chat-types";
import {
  buildRailModel,
  fillMissingOffsets,
  findActiveTurn,
  replyPreview,
  tickEmphasis,
  turnLabel,
  type RailGeometry,
} from "./chat-rail";

const user = (id: string, text: string): RenderRow => ({ id, kind: "user", text });
const assistant = (id: string, text = "…"): RenderRow => ({
  id,
  kind: "assistant",
  text,
  isLast: false,
});

describe("turnLabel", () => {
  it("takes the first non-empty line, truncated", () => {
    expect(turnLabel("\n\n  Fix the build\nmore context")).toBe("Fix the build");
    expect(turnLabel("x".repeat(100))).toBe("x".repeat(72) + "…");
  });

  it("skips a leading attachment marker when a real line follows", () => {
    expect(turnLabel("[Image: source: /tmp/a.png]\nWhat is this?")).toBe("What is this?");
  });

  it("falls back to the marker, then to a placeholder", () => {
    expect(turnLabel("[Image: source: /tmp/a.png]")).toBe("[Image: source: /tmp/a.png]");
    expect(turnLabel("   \n ")).toBe("Attachment");
  });
});

describe("replyPreview", () => {
  it("flattens markdown into one run of text", () => {
    expect(replyPreview("## Done\n\n- **one**\n- `two`\n\n```ts\nignored()\n```\nend")).toBe(
      "Done - one - two end",
    );
  });

  it("truncates long replies", () => {
    const out = replyPreview("a ".repeat(300));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(221);
  });
});

describe("buildRailModel", () => {
  it("emits turns with reply previews, and dividers interleaved in row order", () => {
    const rows: RenderRow[] = [
      user("u1", "first"),
      assistant("a1", "Reply one."),
      assistant("a1b", "Second chunk is not the preview."),
      { id: "c1", kind: "compact-boundary" },
      user("u2", "second"),
      { id: "m1", kind: "model-switch", toModelLabel: "Opus 5.5" },
      assistant("a2", "Reply two."),
      { id: "q1", kind: "user", text: "queued", queued: true },
    ];
    const model = buildRailModel(rows);
    expect(model.turns.map((t) => [t.id, t.rowIndex, t.label, t.preview])).toEqual([
      ["u1", 0, "first", "Reply one."],
      ["u2", 4, "second", "Reply two."],
    ]);
    expect(
      model.entries.map((e) => (e.kind === "turn" ? `turn:${e.turn.id}` : `tick:${e.tick.id}`)),
    ).toEqual(["turn:u1", "tick:c1", "turn:u2", "tick:m1"]);
    expect(model.entries[1]).toEqual({
      kind: "tick",
      tick: { id: "c1", kind: "boundary", rowIndex: 3, label: "Context compacted" },
    });
    expect(model.entries[3]).toEqual({
      kind: "tick",
      tick: { id: "m1", kind: "model", rowIndex: 5, label: "Switched to Opus 5.5" },
    });
  });

  it("leaves the preview empty for a turn with no reply yet", () => {
    expect(buildRailModel([user("u1", "hi")]).turns[0].preview).toBe("");
  });
});

describe("fillMissingOffsets", () => {
  it("keeps known offsets and interpolates unknown ones by row index", () => {
    expect(fillMissingOffsets([0, 2, 4, 6], [0, null, null, 600], 1000)).toEqual([
      0, 200, 400, 600,
    ]);
  });

  it("interpolates towards the total when there is no later known offset", () => {
    expect(fillMissingOffsets([0, 5], [0, null], 1000)).toEqual([0, 1000 * (5 / 6)]);
  });
});

describe("findActiveTurn", () => {
  const model = buildRailModel([
    user("u1", "one"),
    assistant("a1"),
    user("u2", "two"),
    assistant("a2"),
    user("u3", "three"),
    assistant("a3"),
  ]);
  const geometry = (scrollTop: number): RailGeometry => ({
    scrollHeight: 2000,
    clientHeight: 500,
    scrollTop,
    turnOffsets: [0, 1000, 1500],
  });

  it("picks the turn with the most viewport overlap", () => {
    expect(findActiveTurn(model, geometry(0))).toBe(0);
    expect(findActiveTurn(model, geometry(900))).toBe(1);
    expect(findActiveTurn(model, geometry(1500))).toBe(2);
  });

  it("returns -1 with no turns", () => {
    expect(findActiveTurn({ turns: [], entries: [] }, geometry(0))).toBe(-1);
  });
});

describe("tickEmphasis", () => {
  it("peaks at the active tick and tapers to zero", () => {
    expect([-4, -3, -2, -1, 0, 1, 2, 3, 4].map(tickEmphasis)).toEqual([0, 0, 1, 2, 3, 2, 1, 0, 0]);
  });
});
