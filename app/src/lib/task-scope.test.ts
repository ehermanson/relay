import { describe, expect, it } from "vitest";
import type { Task } from "@shared/types";
import {
  filterTasksForView,
  hasRevisionedTaskShape,
  normalizeTaskSpaceId,
  taskChangeMatchesScope,
  taskQueryKey,
  taskScopeKey,
} from "./task-scope";

function task(status: Task["status"], archived = false): Task {
  return {
    id: status === "cancelled" ? "a1b2c3d4" : "b1c2d3e4",
    title: status,
    description: "",
    status,
    priority: 2,
    type: "task",
    tags: [],
    parent: null,
    blockedBy: [],
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    closedAt: status === "open" ? null : "2026-09-21T00:00:00.000Z",
    revision: status,
    archived,
  };
}

describe("task scopes", () => {
  it("normalizes omitted scopes to Main", () => {
    expect(taskScopeKey()).toBe("main");
    expect(taskQueryKey("project-1")).toEqual(["tasks", "project-1", "main", "unfinished"]);
  });

  it("normalizes the explicit default Space ID to Main", () => {
    const spaces = [
      { id: "default-space", isDefault: true },
      { id: "named-space", isDefault: false },
    ];
    expect(normalizeTaskSpaceId("default-space", spaces)).toBeUndefined();
    expect(normalizeTaskSpaceId("named-space", spaces)).toBe("named-space");
  });

  it("keeps Space and history queries isolated", () => {
    expect(taskQueryKey("project-1", "space-1", "history")).toEqual([
      "tasks",
      "project-1",
      "space-1",
      "history",
    ]);
  });

  it("matches change events only to their Project and Space", () => {
    expect(taskChangeMatchesScope({ projectId: "project-1" }, "project-1")).toBe(true);
    expect(
      taskChangeMatchesScope(
        { projectId: "project-1", spaceId: "space-1" },
        "project-1",
        "space-1",
      ),
    ).toBe(true);
    expect(
      taskChangeMatchesScope(
        { projectId: "project-1", spaceId: "space-2" },
        "project-1",
        "space-1",
      ),
    ).toBe(false);
  });

  it("keeps cancelled and archived terminal tasks in history", () => {
    const tasks = [task("open"), task("cancelled"), task("done", true)];
    expect(filterTasksForView(tasks, "unfinished").map((item) => item.status)).toEqual(["open"]);
    expect(filterTasksForView(tasks, "history").map((item) => item.status)).toEqual([
      "cancelled",
      "done",
    ]);
  });

  it("rejects legacy cached tasks without revisions", () => {
    const current = task("open");
    expect(hasRevisionedTaskShape([current])).toBe(true);
    expect(hasRevisionedTaskShape([{ ...current, revision: undefined } as unknown as Task])).toBe(
      false,
    );
  });
});
