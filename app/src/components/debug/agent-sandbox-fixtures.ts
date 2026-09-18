/**
 * Realistic delegated-agent fixtures for the /sandbox prototype surface.
 *
 * Each scene returns the main `items`, the `agents` map and the nested
 * `agentItems`, exactly as `useInstanceMessages` would expose them, so the
 * sandbox renders through the real `MessageList` / `AgentsPanel`.
 */

import type { AgentInfo, ProviderRequest } from "@shared/types";
import type { ChatItem, MergedActivity } from "@/lib/chat-types";

export interface AgentScene {
  label: string;
  description: string;
  build: () => {
    items: ChatItem[];
    agents: Record<string, AgentInfo>;
    agentItems: Record<string, ChatItem[]>;
    pendingRequest?: ProviderRequest;
  };
}

const now = () => Date.now();

function delegation(
  toolUseId: string,
  description: string,
  extra: Record<string, unknown> = {},
  result?: { detail: string; status: "success" | "error" },
): MergedActivity {
  return {
    type: "activity",
    activity: "tool_use",
    tool: "Agent",
    toolUseId,
    description: "Spawning agent",
    inputDescription: description,
    input: { description, subagent_type: "general-purpose", ...extra },
    ...(result ? { mergedResultDetail: result.detail, mergedResultStatus: result.status } : {}),
  } as MergedActivity;
}

function tool(
  toolName: string,
  description: string,
  input: Record<string, unknown>,
  result?: string,
  status: "success" | "error" = "success",
): MergedActivity {
  return {
    type: "activity",
    activity: "tool_use",
    tool: toolName,
    toolUseId: `tu-${Math.random().toString(36).slice(2, 8)}`,
    description,
    inputDescription: description,
    detail: typeof input.file_path === "string" ? input.file_path : undefined,
    input,
    ...(result ? { mergedResultDetail: result, mergedResultStatus: status } : {}),
  } as MergedActivity;
}

const LONG_RESULT = `## Findings

The reducer in \`use-instance-messages.ts\` keeps a single streaming accumulator, so text from concurrent children interleaves with the orchestrator's own output.

### Root cause
- \`pendingStreamMessage\` is keyed only by content-block index
- \`parent_tool_use_id\` is read nowhere in \`claude-sdk.ts\`
- \`handleUserMessage\` drops text blocks, so peer reports are lost or shown as human speech

### Recommendation
1. Route every frame with \`parent_tool_use_id\` to a per-agent stream
2. Classify \`origin.kind === "peer"\` user envelopes as agent-authored
3. Emit \`agent_update\` on task start / completion so the UI can anchor cards

\`\`\`ts
if (frame.parent_tool_use_id) {
  streams.for(frame.parent_tool_use_id).push(frame);
  return;
}
\`\`\`

I did not change any files — this was an investigation only.`;

export const AGENT_SCENES: AgentScene[] = [
  {
    label: "(a) One sync child, long result",
    description: "Single Agent tool_use anchored card with a long markdown report",
    build: () => {
      const ts = now();
      const agents: Record<string, AgentInfo> = {
        "tu-explore-1": {
          agentId: "tu-explore-1",
          providerAgentId: "a9f3c2",
          originToolUseId: "tu-explore-1",
          relation: "child",
          name: "explore-reducer",
          role: "Explore",
          description: "Investigate streaming attribution bug",
          assignment:
            "Read app/src/hooks/use-instance-messages.ts and server/core/providers/claude-sdk.ts. Explain why concurrent child agents' text merges into the orchestrator's stream. Do not modify files.",
          model: "claude-sonnet-4-5",
          status: "completed",
          startedAt: ts - 95_000,
          endedAt: ts - 12_000,
          result: LONG_RESULT,
          usage: { totalTokens: 48_210, toolUses: 7, durationMs: 83_000 },
        },
      };
      return {
        agents,
        agentItems: {
          "tu-explore-1": [
            { kind: "user", text: agents["tu-explore-1"].assignment!, timestamp: ts - 95_000 },
            {
              kind: "activity-group",
              activities: [
                tool("Read", "Read use-instance-messages.ts", { file_path: "app/src/hooks/use-instance-messages.ts" }, "1268 lines"),
                tool("Grep", "Find parent_tool_use_id", { pattern: "parent_tool_use_id" }, "0 matches in server/"),
                tool("Read", "Read claude-sdk.ts", { file_path: "server/core/providers/claude-sdk.ts" }, "2400 lines"),
              ],
            },
            { kind: "assistant", text: LONG_RESULT, timestamp: ts - 12_000 },
          ],
        },
        items: [
          { kind: "user", text: "Why do subagent outputs blend into the main chat?", timestamp: ts - 100_000 },
          {
            kind: "activity-group",
            activities: [
              delegation("tu-explore-1", "Investigate streaming attribution bug", { model: "sonnet" }, {
                detail: LONG_RESULT,
                status: "success",
              }),
            ],
          },
          {
            kind: "assistant",
            text: "The explorer confirmed it: the SDK driver ignores `parent_tool_use_id`, so all frames share one accumulator. I'll route child frames to per-agent streams next.",
            timestamp: ts - 5_000,
          },
        ],
      };
    },
  },
  {
    label: "(b) Four concurrent children",
    description: "Mixed states: running w/ lastActivity, waiting, completed, failed",
    build: () => {
      const ts = now();
      const agents: Record<string, AgentInfo> = {
        "tu-impl-claude": {
          agentId: "tu-impl-claude",
          originToolUseId: "tu-impl-claude",
          relation: "child",
          name: "impl-claude",
          description: "Implement Claude attribution",
          model: "claude-sonnet-4-5",
          status: "running",
          lastActivity: "Edit claude-sdk.ts",
          startedAt: ts - 60_000,
        },
        "tu-impl-codex": {
          agentId: "tu-impl-codex",
          originToolUseId: "tu-impl-codex",
          relation: "child",
          name: "impl-codex",
          description: "Implement Codex thread scoping",
          model: "gpt-5-codex",
          status: "waiting",
          statusDetail: "Waiting for permission to run `pnpm build:server`",
          startedAt: ts - 58_000,
        },
        "tu-impl-ui": {
          agentId: "tu-impl-ui",
          originToolUseId: "tu-impl-ui",
          relation: "child",
          name: "impl-ui",
          description: "Agent cards + sidecar",
          status: "completed",
          result: "Added `AgentCard`, `AgentsPanel`, and reducer routing. 14 tests pass. No contract changes needed.",
          usage: { totalTokens: 132_400, toolUses: 41, durationMs: 412_000 },
          startedAt: ts - 500_000,
          endedAt: ts - 88_000,
        },
        "tu-docs": {
          agentId: "tu-docs",
          originToolUseId: "tu-docs",
          relation: "child",
          name: "docs",
          description: "Update CLAUDE.md",
          model: "claude-haiku-4-5",
          status: "failed",
          statusDetail: "Process exited with code 137 (out of memory)",
          startedAt: ts - 40_000,
          endedAt: ts - 30_000,
        },
      };
      return {
        agents,
        agentItems: {
          "tu-impl-claude": [
            {
              kind: "activity-group",
              activities: [
                tool("Read", "Read claude-sdk.ts", { file_path: "server/core/providers/claude-sdk.ts" }, "ok"),
                tool("Edit", "Edit claude-sdk.ts", { file_path: "server/core/providers/claude-sdk.ts", old_string: "a", new_string: "b" }),
              ],
            },
          ],
          "tu-impl-codex": [
            {
              kind: "activity-group",
              activities: [
                tool("Bash", "Run pnpm build:server", { command: "pnpm build:server" }),
              ],
            },
          ],
        },
        pendingRequest: {
          requestId: "req-1",
          kind: "approval",
          tool: "Bash",
          description: "pnpm build:server",
          relayAgentId: "tu-impl-codex",
        } as ProviderRequest,
        items: [
          { kind: "user", text: "Split the work across implementers and run them in parallel.", timestamp: ts - 600_000 },
          {
            kind: "activity-group",
            activities: [
              delegation("tu-impl-ui", "Agent cards + sidecar", { run_in_background: true }),
              delegation("tu-impl-claude", "Implement Claude attribution", { model: "sonnet", run_in_background: true }),
              delegation("tu-impl-codex", "Implement Codex thread scoping", { run_in_background: true }),
              delegation("tu-docs", "Update CLAUDE.md", { model: "haiku", run_in_background: true }),
            ],
          },
          {
            kind: "assistant",
            text: "Four implementers are running. I'll integrate as they report back.",
            timestamp: ts - 590_000,
          },
        ],
      };
    },
  },
  {
    label: "(c) Resumed agent",
    description: "Same key completed earlier, now running again",
    build: () => {
      const ts = now();
      const agents: Record<string, AgentInfo> = {
        "tu-review-1": {
          agentId: "tu-review-1",
          originToolUseId: "tu-review-1",
          relation: "child",
          name: "reviewer",
          description: "Review the reducer changes",
          model: "claude-opus-4-1",
          status: "running",
          lastActivity: "Read use-instance-messages.ts",
          result: "First pass: 2 blocking issues (unmatched tool_result fallback, missing sequence gate on agent_update).",
          startedAt: ts - 300_000,
        },
      };
      return {
        agents,
        agentItems: {
          "tu-review-1": [
            { kind: "assistant", text: agents["tu-review-1"].result!, timestamp: ts - 200_000 },
            { kind: "user", text: "Both fixed. Re-review the same files.", timestamp: ts - 20_000 },
            {
              kind: "activity-group",
              activities: [tool("Read", "Read use-instance-messages.ts", { file_path: "app/src/hooks/use-instance-messages.ts" })],
            },
          ],
        },
        items: [
          { kind: "user", text: "Have the reviewer take another look now that the fixes landed.", timestamp: ts - 30_000 },
          {
            kind: "activity-group",
            activities: [delegation("tu-review-1", "Review the reducer changes", { model: "opus" }, { detail: agents["tu-review-1"].result!, status: "success" })],
          },
          {
            kind: "assistant",
            text: "Resumed the reviewer on the same thread so it keeps its earlier context.",
            timestamp: ts - 15_000,
          },
        ],
      };
    },
  },
  {
    label: "(d) Nested delegation",
    description: "A child that spawned its own child (parentAgentId)",
    build: () => {
      const ts = now();
      const agents: Record<string, AgentInfo> = {
        "tu-lead": {
          agentId: "tu-lead",
          originToolUseId: "tu-lead",
          relation: "child",
          name: "lead",
          description: "Coordinate the migration",
          model: "claude-sonnet-4-5",
          status: "running",
          lastActivity: "Waiting on schema-writer",
        },
        "tu-schema": {
          agentId: "tu-schema",
          originToolUseId: "tu-schema",
          parentAgentId: "tu-lead",
          relation: "child",
          name: "schema-writer",
          description: "Write the SQLite migration",
          model: "claude-haiku-4-5",
          status: "running",
          lastActivity: "Write 0042_agents.sql",
        },
        "tu-tests": {
          agentId: "tu-tests",
          parentAgentId: "tu-lead",
          relation: "child",
          name: "test-writer",
          description: "Cover the migration with tests",
          status: "pending",
        },
      };
      return {
        agents,
        agentItems: {
          "tu-lead": [
            { kind: "assistant", text: "Splitting into schema + tests.", timestamp: ts - 50_000 },
            {
              kind: "activity-group",
              activities: [delegation("tu-schema", "Write the SQLite migration", { model: "haiku" })],
            },
          ],
          "tu-schema": [
            {
              kind: "activity-group",
              activities: [tool("Write", "Write 0042_agents.sql", { file_path: "server/migrations/0042_agents.sql", content: "CREATE TABLE agents (...)" })],
            },
          ],
        },
        items: [
          { kind: "user", text: "Run the agents-table migration end to end.", timestamp: ts - 60_000 },
          { kind: "activity-group", activities: [delegation("tu-lead", "Coordinate the migration", { model: "sonnet" })] },
        ],
      };
    },
  },
  {
    label: "(e) Agent-authored note",
    description: "Inbound message with author.kind === \"agent\"",
    build: () => {
      const ts = now();
      return {
        agents: {
          "thr-peer-1": {
            agentId: "thr-peer-1",
            relation: "peer",
            name: "release-manager",
            status: "unknown",
          },
        },
        agentItems: {},
        items: [
          { kind: "user", text: "Coordinate with the release-manager session before merging.", timestamp: ts - 90_000 },
          { kind: "assistant", text: "Pinged release-manager and asked for the freeze window.", timestamp: ts - 80_000 },
          {
            kind: "agent-note",
            name: "release-manager",
            agentId: "thr-peer-1",
            text: "Freeze starts **Friday 17:00 UTC**. Anything merged after that goes to the next train.\n\n- Tag `v1.42.0-rc1` first\n- Run the smoke suite on staging",
            timestamp: ts - 40_000,
          },
          { kind: "assistant", text: "Got it — merging before the Friday freeze.", timestamp: ts - 30_000 },
        ],
      };
    },
  },
  {
    label: "(f) Pending permission badge",
    description: "Card badged while its agent waits on an approval",
    build: () => {
      const ts = now();
      return {
        agents: {
          "tu-bash-1": {
            agentId: "tu-bash-1",
            originToolUseId: "tu-bash-1",
            relation: "child",
            name: "db-migrator",
            description: "Apply migrations on staging",
            model: "gpt-5-codex",
            status: "waiting",
            lastActivity: "pnpm db:migrate --env staging",
          },
        },
        agentItems: {
          "tu-bash-1": [
            { kind: "activity-group", activities: [tool("Bash", "Run migrations", { command: "pnpm db:migrate --env staging" })] },
          ],
        },
        pendingRequest: {
          requestId: "req-2",
          kind: "approval",
          tool: "Bash",
          description: "pnpm db:migrate --env staging",
          relayAgentId: "tu-bash-1",
        } as ProviderRequest,
        items: [
          { kind: "user", text: "Migrate staging.", timestamp: ts - 20_000 },
          { kind: "activity-group", activities: [delegation("tu-bash-1", "Apply migrations on staging")] },
        ],
      };
    },
  },
  {
    label: "(g) Unanchored agent (inserted card)",
    description: "agent_update with no known origin — card inserted at first sighting",
    build: () => {
      const ts = now();
      return {
        agents: {
          "thr-codex-child": {
            agentId: "thr-codex-child",
            providerAgentId: "019a-...-child",
            relation: "child",
            name: "worker",
            role: "default",
            status: "running",
            lastActivity: "Read package.json",
          },
        },
        agentItems: {
          "thr-codex-child": [
            { kind: "activity-group", activities: [tool("Read", "Read package.json", { file_path: "package.json" })] },
          ],
        },
        items: [
          { kind: "user", text: "Audit the dependency tree.", timestamp: ts - 20_000 },
          { kind: "agent-card", agentId: "thr-codex-child", timestamp: ts - 15_000 },
        ],
      };
    },
  },
];
