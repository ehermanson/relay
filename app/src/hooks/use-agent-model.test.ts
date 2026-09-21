import { beforeEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentInfo } from "@shared/types";

vi.mock("@/lib/api", () => ({ fetchAgentModel: vi.fn(), fetchAgentHistory: vi.fn() }));
import { fetchAgentModel, fetchAgentHistory } from "@/lib/api";
import { useAgentModelLabel } from "@/hooks/use-agent-model";
import { useAgentHistory } from "@/hooks/use-agent-history";

beforeEach(() => vi.resetAllMocks());
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

it("loads a collapsed model once for both surfaces without fetching child history", async () => {
  vi.mocked(fetchAgentModel).mockResolvedValue("gpt-6");
  const agent: AgentInfo = { agentId: "child", status: "completed" };
  const { result } = renderHook(
    () => [useAgentModelLabel("chat", agent, "codex"), useAgentModelLabel("chat", agent, "codex")],
    { wrapper: wrapper() },
  );
  await waitFor(() => expect(result.current[0]).toBeTruthy());
  expect(result.current[1]).toBe(result.current[0]);
  expect(fetchAgentModel).toHaveBeenCalledTimes(1);
  expect(fetchAgentHistory).not.toHaveBeenCalled();
});

it("uses known live models without requesting metadata", () => {
  const { result } = renderHook(
    () =>
      useAgentModelLabel(
        "chat",
        {
          agentId: "child",
          model: "gpt-6",
        },
        "codex",
      ),
    { wrapper: wrapper() },
  );
  expect(result.current).toBeTruthy();
  expect(fetchAgentModel).not.toHaveBeenCalled();
});

it("rechecks a running-time missing model when the agent completes", async () => {
  vi.mocked(fetchAgentModel).mockResolvedValueOnce(null);
  const { result, rerender } = renderHook(
    ({ agent }: { agent: AgentInfo }) => useAgentModelLabel("chat", agent, "codex"),
    {
      initialProps: { agent: { agentId: "child", status: "running" } },
      wrapper: wrapper(),
    },
  );
  await waitFor(() => expect(fetchAgentModel).toHaveBeenCalledTimes(1));
  vi.mocked(fetchAgentModel).mockResolvedValueOnce("gpt-6");
  rerender({ agent: { agentId: "child", status: "completed", endedAt: 2 } });
  await waitFor(() => expect(result.current).toBeTruthy());
  expect(fetchAgentModel).toHaveBeenCalledTimes(2);
});

it("shares a model found during expansion with the collapsed label", async () => {
  vi.mocked(fetchAgentModel).mockResolvedValue(null);
  vi.mocked(fetchAgentHistory).mockResolvedValue([
    {
      timestamp: 1,
      message: { type: "agent_update", agent: { agentId: "child", model: "gpt-6" } },
    },
  ]);
  const { result, rerender } = renderHook(
    ({ expanded }) => {
      const label = useAgentModelLabel("chat", { agentId: "child", status: "completed" }, "codex");
      useAgentHistory("chat", "child", { enabled: expanded, status: "completed" });
      return label;
    },
    { initialProps: { expanded: false }, wrapper: wrapper() },
  );
  await waitFor(() => expect(fetchAgentModel).toHaveBeenCalledTimes(1));
  expect(result.current).toBeNull();
  rerender({ expanded: true });
  await waitFor(() => expect(result.current).toBeTruthy());
  rerender({ expanded: false });
  expect(result.current).toBeTruthy();
});
