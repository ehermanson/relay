import { describe, expect, it } from "vitest";
import { expandTaskReferences, getTaskReferenceIds } from "./composer-mentions";
import type { Task } from "@shared/types";

const uuid = "550e8400-e29b-41d4-a716-446655440000";
const task: Task = {
  id: uuid,
  title: "Keep UUID references",
  description: "Load it from the selected Space.",
  status: "open",
  priority: 2,
  type: "task",
  tags: [],
  parent: null,
  blockedBy: [],
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
  closedAt: null,
  revision: "rev-1",
  archived: false,
};

describe("task reference expansion", () => {
  it("finds legacy IDs and UUIDs", () => {
    expect(
      getTaskReferenceIds(
        `@task:a1b2c3d4 @task:ios-header-blur-device-investigation @task:${uuid}:Keep%20UUID`,
      ),
    ).toEqual(["a1b2c3d4", "ios-header-blur-device-investigation", uuid]);
  });

  it("expands UUID references", () => {
    expect(expandTaskReferences(`Continue @task:${uuid}:Keep%20UUID`, [task])).toContain(
      `<task_reference id="${uuid}" title="Keep UUID references">`,
    );
  });

  it("does not resolve a UUID as a legacy ID with the same prefix", () => {
    const legacy = { ...task, id: "550e8400", title: "Wrong task" };
    expect(expandTaskReferences(`Continue @task:${uuid}:Keep%20UUID`, [legacy, task])).toContain(
      `title="Keep UUID references"`,
    );
  });

  it("expands a legacy slug ID without consuming the encoded title", () => {
    const slugTask = { ...task, id: "mobile-home-continue", title: "Mobile home continue" };
    expect(
      expandTaskReferences("Use @task:mobile-home-continue:Mobile%20home%20continue now", [
        slugTask,
      ]),
    ).toContain('id="mobile-home-continue" title="Mobile home continue"');
  });
});
