import { describe, expect, it } from "vitest";
import { buildTaskReference, isTaskId } from "./task-links";

describe("buildTaskReference", () => {
  it("adds a trailing space so seeded drafts can continue typing normally", () => {
    expect(buildTaskReference({ id: "a1b2c3d4", title: "Fix login" })).toBe(
      "@task:a1b2c3d4:Fix%20login ",
    );
  });
});

describe("isTaskId", () => {
  it("accepts legacy hex and slug IDs plus UUIDs", () => {
    expect(isTaskId("a1b2c3d4")).toBe(true);
    expect(isTaskId("ios-header-blur-device-investigation")).toBe(true);
    expect(isTaskId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects malformed IDs", () => {
    expect(isTaskId("-a1b2c3")).toBe(false);
    expect(isTaskId("bad/task")).toBe(false);
    expect(isTaskId("bad.task")).toBe(false);
    expect(isTaskId("trailing-")).toBe(false);
    expect(isTaskId("UPPERCASE")).toBe(false);
  });
});
