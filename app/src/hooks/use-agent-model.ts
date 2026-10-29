import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentInfo, ProviderKind } from "@shared/types";
import { fetchAgentModel } from "@/lib/api";
import { getAgentModelLabel, isAgentTerminal } from "@/lib/agents";
import { useChatById } from "@/hooks/use-chat-by-id";

export function agentModelQueryKey(
  instanceId: string | undefined,
  agent: Pick<AgentInfo, "agentId" | "status"> & { endedAt?: string | number },
) {
  return [
    "agentModel",
    instanceId,
    agent.agentId,
    isAgentTerminal(agent.status) ? `final:${agent.endedAt ?? ""}` : "live",
  ];
}

/** Shared metadata query: collapsed surfaces never fetch the full child transcript. */
export function useAgentModelLabel(
  instanceId: string | undefined,
  agent: AgentInfo,
  provider?: ProviderKind,
): string | null {
  const terminal = isAgentTerminal(agent.status);
  // A Relay child is a chat of its own: its model is the chat's, read from
  // the instance rather than probed from a transcript head.
  const relay = agent.origin === "relay";
  const child = useChatById(relay ? agent.childInstanceId : undefined);
  const childModel =
    child?.providerStatus?.effectiveModel ?? child?.stats?.model ?? child?.preferredModel;
  const client = useQueryClient();
  const queryKey = agentModelQueryKey(instanceId, agent);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const model = await fetchAgentModel(instanceId!, agent.agentId);
      // Expansion may have supplied a model while this bounded lookup was in flight.
      return model ?? client.getQueryData<string | null>(queryKey) ?? null;
    },
    enabled: !!instanceId && !agent.model && !relay,
    staleTime: terminal ? Infinity : 15_000,
    // A freshly spawned child's file may not have its first model record yet.
    refetchInterval: (query) => (!terminal && !query.state.data ? 15_000 : false),
    retry: false,
  });
  if (relay) {
    const model = childModel ?? agent.model;
    return getAgentModelLabel(
      { ...agent, model },
      agent.childProvider ?? child?.provider ?? provider,
    );
  }
  return getAgentModelLabel(
    agent.model ? agent : { ...agent, model: query.data ?? undefined },
    provider,
  );
}
