import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  chatSummaryQueryOptions,
  chatGitStatusQueryOptions,
  chatDiffQueryOptions,
  chatSuggestionsQueryOptions,
} from "./chat-query-options";
import {
  fetchInstanceSummary,
  fetchInstanceGitStatus,
  fetchInstanceDiff,
  fetchProjectSuggestions,
} from "./api";

vi.mock("./api", () => ({
  fetchInstanceSummary: vi.fn(async (id) => ({ id })),
  fetchInstanceGitStatus: vi.fn(async (id) => ({ branch: id })),
  fetchInstanceDiff: vi.fn(async (id) => `diff:${id}`),
  fetchProjectSuggestions: vi.fn(async (id) => [{ label: id }]),
}));

describe("Chat query callbacks", () => {
  it("shares module callbacks across Chats and resolves each request from its own key", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const first = chatSummaryQueryOptions("first");
      const second = chatSummaryQueryOptions("second");
      expect(first.queryFn).toBe(second.queryFn);
      expect(await client.fetchQuery(first)).toEqual({ id: "first" });
      expect(await client.fetchQuery(second)).toEqual({ id: "second" });
      expect(fetchInstanceSummary).toHaveBeenCalledWith("first");
      expect(fetchInstanceSummary).toHaveBeenCalledWith("second");

      expect(chatGitStatusQueryOptions("first").queryFn).toBe(
        chatGitStatusQueryOptions("second").queryFn,
      );
      expect(await client.fetchQuery(chatGitStatusQueryOptions("second"))).toEqual({
        branch: "second",
      });
      expect(fetchInstanceGitStatus).toHaveBeenCalledWith("second");

      expect(chatDiffQueryOptions("first").queryFn).toBe(chatDiffQueryOptions("second").queryFn);
      expect(await client.fetchQuery(chatDiffQueryOptions("second"))).toBe("diff:second");
      expect(fetchInstanceDiff).toHaveBeenCalledWith("second");

      expect(chatSuggestionsQueryOptions("project-a").queryFn).toBe(
        chatSuggestionsQueryOptions("project-b").queryFn,
      );
      expect(await client.fetchQuery(chatSuggestionsQueryOptions("project-b"))).toEqual([
        { label: "project-b" },
      ]);
      expect(fetchProjectSuggestions).toHaveBeenCalledWith("project-b");
      expect(await client.fetchQuery(chatSuggestionsQueryOptions(undefined))).toEqual([]);
    } finally {
      client.clear();
    }
  });
});
