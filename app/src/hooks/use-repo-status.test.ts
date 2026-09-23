import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRepoStatus,
  applyRepoStatusMessage,
  repoStatusTargetKey,
  resetRepoStatusStore,
} from "@/hooks/use-repo-status";
import type { ClientMessage, RepoStatusTarget } from "@shared/types";

const target: RepoStatusTarget = { kind: "instance", instanceId: "chat-1" };

function recorder() {
  const sent: ClientMessage[] = [];
  return {
    sent,
    send: (message: ClientMessage) => {
      sent.push(message);
      return true;
    },
  };
}

describe("repo status subscription store", () => {
  afterEach(() => resetRepoStatusStore());

  it("keys targets by kind and id", () => {
    expect(repoStatusTargetKey(target)).toBe("instance:chat-1");
    expect(repoStatusTargetKey({ kind: "space", spaceId: "s" })).toBe("space:s");
    expect(repoStatusTargetKey({ kind: "project", projectId: "p" })).toBe("project:p");
  });

  it("sends one subscribe per target and unsubscribes when the last consumer leaves", () => {
    const { sent, send } = recorder();
    const releaseA = acquireRepoStatus(target, 1, send);
    const releaseB = acquireRepoStatus(target, 1, send);
    expect(sent.map((m) => m.type)).toEqual(["repo_status_subscribe"]);
    releaseA();
    releaseA(); // idempotent
    expect(sent).toHaveLength(1);
    releaseB();
    expect(sent.map((m) => m.type)).toEqual(["repo_status_subscribe", "repo_status_unsubscribe"]);
  });

  it("re-subscribes on a new connection", () => {
    const { sent, send } = recorder();
    acquireRepoStatus(target, 1, send);
    acquireRepoStatus(target, 2, send);
    expect(sent.filter((m) => m.type === "repo_status_subscribe")).toHaveLength(2);
  });

  it("ignores status for targets nobody holds", () => {
    // Must not throw or create state for an unheld target.
    applyRepoStatusMessage({ kind: "space", spaceId: "gone" }, null);
  });
});
