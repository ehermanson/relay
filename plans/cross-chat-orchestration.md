# Cross-chat orchestration: chats that delegate to and message other chats

Status (2026-10-29): **Phases 1–4 implemented** — `/mcp` endpoint, per-chat credentials, Claude + Codex injection, read-only tools (`relay_capabilities`, `chat_list`, `chat_read`), and delegation (`delegate_task`, `task_status`, `task_cancel`) with the `delegated_tasks` table, relay-origin agent cards, completion wakes, and stop/done/delete cascades; `chat_send`/`chat_wait` (never queued: busy or waiting targets are refused); `relay://chat/` chips. Phase 4's `isolation: "space"` was removed with Spaces (`plans/remove-spaces.md`); children always share the parent's checkout. See AGENTS.md "Relay Orchestration". Not yet built from phase 2's design: a child waiting on input marking its parent's inbox row (G), the Codex resume instructions gap (F).

## Goal

An agent in one Relay chat can:

- delegate a task to a **new child chat**, on any Provider (for example, a Claude chat starting a Codex child), then get the result back;
- list, read, message, wait on, and interrupt **other chats** in the Project; and
- do this without polling, while Relay keeps the parent/child link durable, visible, and safe.

Provider-native subagents (Claude `Agent`/`Task`, Codex `spawn_agent`) already work and render through the delegated-agent contract (`AgentInfo`, `agent_update`). This proposal does **not** replace them. It adds a second, Relay-owned kind of delegation for the cases native subagents can't handle: another provider or model, a separate checkout, work that outlives the turn, and coordination between ordinary chats.

## Prior art: how a comparable agent GUI does it

We studied an open-source multi-provider agent GUI that ships this feature. Its design breaks into eight pieces.

### 1. One app-owned MCP server, injected into every session

The app's HTTP server exposes an MCP endpoint (`http://127.0.0.1:<port>/mcp`, Streamable HTTP). Each provider session gets the endpoint through that provider's native MCP configuration:

- **Claude Agent SDK**: `mcpServers: { <name>: { type: "http", url, headers: { Authorization: "Bearer <token>" } } }` in the query options, plus `mcp__<name>__*` in `allowedTools`.
- **Codex app-server**: spawn-time config overrides: `-c mcp_servers.<name>.url=…` and `-c mcp_servers.<name>.bearer_token_env_var="<ENV>"`, with the token in that env var (so it never appears in argv).
- **Other harnesses** (ACP agents, etc.) receive it through their own `mcpServers` field. A stdio→HTTP bridge covers harnesses without HTTP MCP, or whose native MCP timeout is too short for long waits.

The tools are app operations. They never call provider-native subagent APIs. A tool call becomes a command in the app's orchestrator, and the orchestrator drives the provider adapters the same way a user message would.

### 2. Per-session, scoped, revocable credentials

Before a provider session opens, a registry issues a random bearer token bound to (environment, parent thread, provider instance, provider session) and a capability set (`orchestration`, `preview`, `device`, …). Only the token's hash is stored, and the raw token is never persisted. A token stops working after a liveness window (24h idle) and is revoked when its session is released. Every tool handler resolves the token to an invocation scope and checks capabilities before reading or changing anything. The `/mcp` route sits outside the normal user auth: the scoped token **is** the auth.

### 3. Tool surface (eleven tools)

| Tool                                               | Purpose                                                                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator_capabilities`                        | The caller's own provider/model/modes, plus every provider instance with a short model list and an availability reason (not installed, unauthenticated, no adapter). Call once per thread.                                 |
| `delegate_task`                                    | Create a child thread and dispatch `task` right away. Optional `target {providerInstanceId \| driverKind, model}`, `role`, `title`, `mode: async\|wait`, `timeoutMs`, `clientRequestId`, `runtimeMode`, `interactionMode`. |
| `task_status` / `task_cancel`                      | Read the child's durable state (status, summary, pending question, pending approval). Cancel the child and anything it delegated in turn.                                                                                  |
| `create_threads` / `thread_launch`                 | Create ordinary top-level threads (batch of up to 20, or one with an explicit workspace strategy: new worktree / existing checkout / project root).                                                                        |
| `thread_list` / `thread_read`                      | List the threads in a project. Read any thread's timeline incrementally (`afterPosition`), with `messages` and `activity` views and bounded text.                                                                          |
| `thread_send` / `thread_wait` / `thread_interrupt` | Message another thread (`auto` / `queue` / `steer` / `restart`), wait for a run to reach a terminal state, or interrupt it.                                                                                                |
| `thread_update`                                    | Rename, regenerate the title, link a PR.                                                                                                                                                                                   |

Results are typed. Expected denials come back as an enum (`capability_denied`, `parent_not_active`, `provider_unavailable`, `model_unavailable`, `runtime_mode_escalation_denied`, `thread_not_sendable`, …), not as thrown errors.

### 4. Delegated-task lifecycle

```text
model → MCP delegate_task → auth scope → thread-management service
  → orchestrator command delegated_task.request
  → child thread (lineage: subagent, parent node) + child run
  → parent gets an "app-owned subagent" projection + turn item (renders as a card)
  → child run terminal → finalize (idempotent, replays after restart)
  → result transfer recorded → wait result / task_status / wake message
```

- **The child gets only the prompt.** It receives `task` plus an optional role instruction, and no copy of the parent's conversation. If the child needs context, the parent puts it in the brief.
- **Inheritance, with a ceiling.** The child inherits provider, model, and modes unless it overrides them, and can never get broader permissions than the parent. Runtime mode may stay equal or narrow. Interaction mode may go from `default` to `plan`, never the other way. If the target provider doesn't offer the inherited mode, the child steps down to the broadest mode it does offer. If the target lists its modes and the parent requests a mode outside that list, the call is refused. The same ceiling applies when sending to _any_ other thread: you can't make a thread do more than you could do yourself.
- **Idempotent.** `clientRequestId` derives stable command, thread, and message IDs, so a retried tool call returns the same child.
- **Follow-up vs. re-check.** A follow-up to the same child goes through `thread_send`. Each new review round is a fresh `delegate_task` carrying the brief, the earlier findings, and the objections.

### 5. Completion wakes the parent: no polling

This is the part that makes the feature work in practice.

- `delegate_task` in `async` mode returns immediately with `next: "Completion wakes this thread, so end your turn. Do not wait on it or poll it."`
- Each parent run tracks its open delegated tasks as a **completion cohort**. When the tasks reach a terminal state, the app sends the parent **one** wake message, as a steer if the parent is mid-turn or a new run if it is idle. Results are inlined up to a 16 KB total budget. Anything over the budget becomes "use `task_status <id>` to read the result". If a later completion arrives while the wake is still queued, the queued message is rewritten instead of queuing a second one.
- Delivery is at-least-once with stable message IDs, and recovers after a restart because finalization replays persisted events.
- `wait` mode blocks until the result arrives or the timeout expires. A timeout never cancels the child. A pending child **question** ends the wait early (`hasPendingQuestion`), so the parent can answer it.

### 6. Child questions go to the parent

Users rarely watch child threads. When a child opens a `user_input` request, the parent gets a notification telling it to answer through a pending-request tool or to ask the user. Approvals are _not_ routed to the parent: a parent agent can't grant permissions on the user's behalf.

### 7. Instructions injected per session

A short system-prompt section is injected when the MCP server is present (kept under Codex's 4 KB instruction-entry limit). Its rules:

- Ordinary coding needs no orchestration tools.
- Use the **native** subagent when the child would run the same provider and an offered model, needs no extra settings, and finishes this turn. Use `delegate_task` for another provider's model, a separate worktree, background work, or when the user names it.
- Call `capabilities` once before the first delegation. Never silently fall back to another provider or tool when the requested one is unavailable.
- Don't poll, sleep, or set up watchers: end the turn and let the completion wake you. Cancel delegates you no longer need.
- If you are a child, do the work yourself. Don't start subagents unless the task says to.
- Create new top-level threads only when the user explicitly asks. "Parallel" and "delegate" never mean that.
- Mention threads by an opaque link (`<app>://v2/<env>/<threadId>`), never by title. The UI shows the live title.
- Claude defers MCP tools behind ToolSearch, so Claude's copy of the instructions says how to load them.

### 8. UI

- The parent's turn shows the child as an agent card that includes the child's provider icon.
- An Agents sheet lists the children with stop buttons.
- The child thread has lineage, so it can show its parent.
- **Child threads have no sidebar row.** You reach them only from the conversation card or the Agents panel. While a child is open, the sidebar highlights its nearest non-child ancestor. The user can't message a child directly ("message the parent thread instead"). When a child needs an approval or an answer, the parent asks for it.
- Message provenance keeps the actor (`createdBy: agent`) separate from the ingress (`creationSource: mcp`). Agent-authored user-role messages are never mistaken for human ones.

### 9. Stopping, settling ("done"), and archiving a parent

- **Stop cascades.** A user Stop interrupts the parent's turn, holds its queue, drops any completion wakes it is still owed, and then stops every app-owned child depth first (a `delegated-tasks.stop` effect sends `thread.stop` to each child after the parent's command commits). `task_cancel` uses the same `thread.stop`. Published results remain readable.
- **Settle (their equivalent of done) refuses while work is live; it does not cascade.** A parent with live children keeps its run in a waiting state (children count as background work that holds completion), so settling fails with "is still running. Stop it before settling." The same happens with a pending approval/question or a queued human message. Once settle is allowed, it cancels any queued _automatic_ runs (wake and notification messages) and pending input requests, so nothing revives the thread. Auto-settle waits until the children reach a terminal state.
- **Archive** only marks the thread archived. Completion wakes skip archived and deleted threads, so a child that finishes later records its result without waking anyone. Delete disposes the parent's completion cohorts.
- **Retention: child threads are kept forever and are never cascade-deleted.** Deleting a parent marks the parent deleted, cancels its pending input requests, disposes its completion cohorts, and marks each task's delivery `disposed` so nothing wakes or revives anyone. The child threads themselves stay in place, together with their history. Because their sidebar lookup walks to the nearest non-child ancestor, a broken chain resolves to the child itself, which then matches no row: an orphaned child effectively disappears from navigation without being deleted. There is no time-based thread retention at all. The only automatic cleanup is **worktrees**: a parent and its child chain that share a checkout count as one owner, the worktree is removed only when the whole chain is idle (and every member is on the same branch), and branches and history always stay.

In short: you can't put a parent away while its children are still working. You have to Stop it first, and Stop takes the children down with it.

## What Relay already has

| Need                              | Relay today                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create a chat on any provider     | `InstanceManager.createInstance({ provider, model, runtimeMode, accountId, parentSessionId, review })`. It enforces the process cap and provider-in-account rules. |
| Message a chat, queue when busy   | `sendMessage(id, text, …, internal, …, allowQueue)` queues behind a running turn. `interruptAndSend` is the "restart" mode.                                        |
| Turn-end hook                     | Turn-end reconcile already runs on idle, exit, and stop (worktree changes, title refresh). That is where child completion goes.                                    |
| Rendering delegated agents        | `AgentInfo` / `agent_update` (replayable), `AgentCard`, Agents sidecar, `mergeAgentInfo`, `relation: "child" \| "teammate" \| "peer"`.                             |
| Agent-authored messages           | `UserMessage.author = { kind: "agent", name }` renders as `AgentNote`, and is excluded from titles, previews, and handoffs.                                        |
| Linked chats                      | Review chats (`review.sourceInstanceId`, `attachReviewLinks`), spin-offs (`SpinOffManager`, rendered packets), `parentSessionId`.                                  |
| Portable context across providers | `session-handoff.ts` (provider switch) and spin-off packets.                                                                                                       |
| Bootstrap instructions            | `buildSessionBootstrapContext` block kinds → Claude `systemPrompt.append`, Codex `developerInstructions` on `thread/start`.                                        |
| MCP plumbing knowledge            | `mcp.ts` / `mcp-management.ts` (discovery and normalization only). Relay does **not** host an MCP server.                                                          |
| Cross-chat search/read            | `SessionDB.search`, `getHistory`, chat summaries.                                                                                                                  |

## Gaps

1. **No Relay-hosted MCP endpoint** and no per-session credential registry.
2. **No injection** of a Relay MCP server into Claude SDK sessions or Codex app-server spawns.
3. **No delegation record** linking a parent chat to a child chat, with task status and result and restart-safe delivery.
4. **No completion wake.** Nothing tells a parent that a chat it started has finished.
5. **No orchestration instructions** in the bootstrap context, and Codex `thread/resume` doesn't resend `developerInstructions`, so they would be lost on resumed chats.
6. **No chat links** an agent can emit that the UI resolves to a live chat chip.

## Proposed design for Relay

### A. `/mcp` endpoint and credentials (server layer)

- Mount a Streamable-HTTP MCP endpoint on the existing Hono app (`@modelcontextprotocol/sdk` server, stateless per request). It sits outside cookie auth and accepts **only** a bearer token from the registry.
- Remote access matters here: tunnels terminate on localhost, so a loopback check proves nothing. The token is the only gate. Reject requests with a browser `Origin` header so a page can't drive the endpoint.
- `McpCredentialRegistry` (new, `server/`): `issue(instanceId, { capabilities })` → raw token; store the SHA-256 hash only. `resolve(token)` → `{ instanceId, accountId, projectDir, provider, runtimeMode }`. Revoke when the process exits or the instance is stopped or deleted. Keep tokens in memory only: a server restart kills every provider process anyway, and a lazy restart issues a fresh token.
- The tool handlers live in core (`server/core/orchestration/…`) behind a narrow interface, so core never imports from server. The HTTP adapter in `server/` only authenticates and shapes responses.

### B. Provider injection (driver-owned, capability-gated)

- New `ProviderCapabilities.supportsRelayOrchestration`. Each driver reports it and owns its injection:
  - **Claude** (`claude-sdk.ts`): add `mcpServers.relay = { type: "http", url, headers }` and `mcp__relay__*` to `allowedTools`. Option: the in-process `createSdkMcpServer` (no HTTP, no token). It is cheaper for Claude, but it splits the tool implementation by provider. Prefer HTTP for parity.
  - **Codex** (`codex-app-server.ts` spawn): `-c mcp_servers.relay.url=…`, `-c mcp_servers.relay.bearer_token_env_var="RELAY_MCP_TOKEN"`, and the token passed through `buildCodexSpawnEnv`. Also set `tool_timeout_sec` high enough for `wait` mode, or cap `wait` below the Codex default.
- Relay's own server must not appear in Relay's MCP discovery UI as a user-configured server. Filter it by name in the `ProviderMcpServerStatus` normalization.
- Accounts invariant: a child runs in the **parent's account**. If the target provider has no login in that account, the call fails with `provider_unavailable_in_account`. It never falls back.

### C. Tools (v1, deliberately small)

`relay_capabilities`, `delegate_task`, `task_status`, `task_cancel`, `chat_list`, `chat_read`, `chat_send`, `chat_wait`. Defer batch creation and metadata edits.

- `delegate_task { task, target?: { provider?, model? }, title?, role?, mode: "async" | "wait", timeoutMs?, clientRequestId?, runtimeMode? }`
  - The child runs in the parent's cwd. (An `isolation: "space"` option, a worktree per child, shipped in phase 4 and was removed with Spaces.)
  - Inherit the parent's runtime mode and narrow it when asked. Never escalate (`full-access` > `writes-only` > default > plan).
  - Typed failures: `capacity` (Relay's existing global process cap, which `createInstance` already enforces), `provider_unavailable`, `provider_unavailable_in_account`, `model_unavailable`, `mode_escalation_denied`, `parent_not_active`.
- `chat_send` applies the same privilege ceiling to the target chat, and refuses chats in another account and read-only chats (missing worktree).

### D. Delegation record and lineage (core + SQLite)

- New `delegated_tasks` table: `id, parent_instance_id, child_instance_id, client_request_id, status, result, result_is_error, created_at, ended_at, delivered_at, delivery_generation`. It is the source of truth for task state and wake delivery, in the same spirit as `outbox_receipts`. Add it idempotently (no schema-version bump, because a bump rebuilds the DB).
- Child chat: `InstanceInfo.delegation = { parentInstanceId, taskId, role }` (new nullable `managed_sessions` column).
- Parent chat: emit an `agent_update` with `agentId = "relay-task:<id>"`, `relation: "child"`, the child's model, `assignment = task`, and a new `childInstanceId` field. The existing cards, sidecar, status badges, and accent colours then work unchanged. The card adds the child provider's logo and an "Open chat" action. **Card anchor:** the MCP request doesn't carry the provider's tool_use id. At call time, match the most recent unresolved `mcp__relay__delegate_task` tool_use (Claude) or `mcpToolCall` item (Codex) in the parent stream. If nothing matches, fall back to the reducer's inserted `agent-card` row.
- Child history for the card's expanded view comes from the child chat's own transcript (`getHistory(childInstanceId)`), so no new history store is needed.

### E. Completion wake

- At child turn end (the idle reconcile path): mark the task terminal, take the last assistant text as `result`, and write the row **before** delivering.
- Deliver once per parent, coalesced: if the parent is idle, `sendMessage(parent, wakeText)` with `author: { kind: "agent", name: <child title> }`, so it renders as an `AgentNote` and never counts as a human turn for titles or done-revival heuristics. If the parent is processing, queue the wake. If a wake is already queued, rewrite it to cover all completed tasks rather than queuing another. Inline results up to 16 KB total, and send a `task_status` pointer for the rest.
- Restart recovery: on startup, terminal-but-undelivered rows are re-offered (at-least-once, with a stable queued id per `delivery_generation`).
- Never wake a parent that is done or stopped by the user. Record the result and stop. Opening the parent shows the finished card.
- Child questions: when a child chat gets `pendingPermission`, `pendingTool`, or `pendingPlan`, the inbox already flags it to the user. Also post an `AgentNote` to the parent ("<child> is waiting for input"). Don't route approvals to the parent agent.

### F. Instructions

- New bootstrap block kind (`relay_orchestration`), present only when the driver injected the MCP server. Content follows the prior art: prefer native subagents for same-provider work; delegate for another provider or model, an isolated worktree, or background work; capabilities once; never poll, end the turn after an async delegation; children do the work themselves; new top-level chats only on an explicit ask; refer to chats by link. Claude's copy explains how to load the tools through ToolSearch.
- **Recursion is governed here, not in code** (section H). The block carries the child rule verbatim: "If you are a delegated child, do the work yourself. Start no delegates unless your task says to." Relay knows when a chat is a child (`InstanceInfo.delegation`), so a child's bootstrap also gets a short `delegated_child` note saying so explicitly: who delegated to it (parent chat link) and that its final reply is the result. The model never has to infer whether it is a child. Ordinary chats don't get this note.
- Fix the Codex resume gap: `thread/resume` doesn't resend `developerInstructions`. Either inject the block on the first turn after a resume (the same pattern Relay already uses for runtime context), or confirm that Codex persists the instructions with the thread.

### G. Links and UI

- Chat links: `relay://chat/<instanceId>`, returned by every tool. Add a `LINK_SOURCES` entry that renders a chip with the chat's **live** title and provider logo, and opens the chat in its Project's chat route.
- Child chat header: a breadcrumb back to the parent ("Delegated by <parent>").
- **Decided: delegated child chats never appear in the inbox** (or the Projects-layout sidebar, mini sidebar, mobile Home, or the stale-chat sweep). Filter them where attached reviews are already filtered (`InboxEntry` building in `lib/inbox.ts`, keyed on `InstanceInfo.delegation`). The way into a child is the parent: its in-chat agent card and its **Agents sidecar** row, each with "Open chat". When a child is open, highlight its parent's row in the sidebar (walk `delegation.parentInstanceId` to the nearest non-delegated ancestor). ⌘K search may still return children, labelled with their parent.
- Attention moves up to the parent: a child waiting on approval or input marks the **parent's** inbox row as needs-input ("<child> needs input"). The attention chooser opens the child directly. Without this, a child's question would be invisible.
- **Decided: a child chat is fully interactive.** The user can message, interrupt, switch model, approve, and answer in it like any chat. This departs from the prior art, which blocks the child's composer. Rules that keep the parent coherent:
  - The task result is the child's last assistant reply **at the moment the delegated turn ends**, recorded once in `delegated_tasks`. User-driven turns afterwards don't change the published result and don't wake the parent. The parent can still `chat_read` the child for later work.
  - If the user messages a child **while its delegated turn is still running**, the message queues or steers the same as in any chat. The task stays open until that turn ends, and the result then includes the user's steering. This is usually what you want: you redirected the child.
  - A user answering a child's question directly clears the "<child> needs input" attention on the parent's row.
  - User messages in a child are human-authored (no `author`). Agent-authored ones come from the parent through `chat_send`, render as `AgentNote`s, and are distinguishable in the child's transcript.
- Capability gate: when `supportsRelayOrchestration` is false, inject nothing and expose no tools. The UI gating changes are covered in I.

### H. Recursion and lifecycle

- **Decided: no delegation limits.** No depth limit, no per-parent fan-out cap, and no separate budget for child processes. This matches the prior art. Every chat's credential exposes the full tool set, children included. Recursion and fan-out are held back by the instructions alone (section F): "If you are a child, do the work yourself. Start no delegates unless your task says to." Relay's existing global process cap still applies, because children are ordinary chats; when it is reached, `delegate_task` returns the typed `capacity` failure and the instructions tell the agent to report it, not retry.
- For reference, the prior art computes delegation depth only for telemetry (capped at 5 in reports). A child's credential is marked `subagent`, which hides only the pull-request-watch tools. Its only hard guards are the mode-escalation ceiling and provider availability, and Relay adopts the same two.
- `task_cancel` stops the child through the normal `stopInstance` path and cascades to grandchildren.
- **Decided: marking a parent done cancels its children.** This departs from the prior art, which _refuses_ to settle until the user stops the parent. Relay's done is lighter: it is a timestamp, later activity revives the chat, and marking done already releases the chat's process slot via `stopIdleProcessForDone`. Cascading fits that better than a refusal. When a parent is marked done:
  1. Every live delegated child, depth first, goes through the `task_cancel` path (`stopInstance`) and its task is marked `cancelled` with reason "parent marked done". Children are released whether or not they are mid-turn: that is the point of the gesture. The parent's own turn keeps the existing rule (`stopIdleProcessForDone` never interrupts a processing chat).
  2. Drop the wakes the parent is still owed: remove any queued wake message and set `delivered_at` on pending rows. Otherwise a late child completion would add activity to the parent and silently revive it out of Done.
  3. Children inherit done-ness: a delegated child counts as done when its parent is, so it can never surface anywhere on its own.
  - Undoing done (later activity revives the parent) does **not** restart cancelled children. The agent can delegate again.
  - The bulk stale-chat sweep (`setInstancesDone`) uses the same cascade, in one pass, with no per-chat broadcasts.
- **Stop on the parent cascades too** (matching the prior art): stopping or interrupting the parent holds its wakes and stops its children.
- **Decided: keep children for as long as their parent exists, and delete them together with it.**
  - Done, cancelled, and finished children are kept. They are cheap (a `managed_sessions` row plus a provider transcript Relay doesn't own), and they back the parent's card history, the Agents sidecar, and the "Open chat" link. There is no time-based pruning, matching the prior art.
  - Deleting a parent cancels its live children and **deletes them with it**, recursively. This differs from the prior art, which leaves orphans in place. In Relay a child is hidden from the inbox, so an orphan would be reachable only through ⌘K search: dead weight that still counts in search results. Deletion goes through the normal per-chat delete path, so provider transcripts on disk are left alone just as they are today.
  - Worktrees: children share the parent's checkout and need nothing extra. Deleting a chat never removes a checkout.

### I. Reconciling with the existing subagent feature

They are **not the same thing**, but they should present as one feature with two origins.

|                            | Native subagent (today)                                              | Relay child chat (new)                                                     |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Who spawns it              | The provider (Claude `Agent`/`Task`, Codex `spawn_agent`)            | Relay, via `delegate_task`                                                 |
| Runs in                    | The parent's own process/session, same provider and login            | Its own managed session; any provider with a login in the parent's account |
| Relay identity             | `AgentInfo` key = tool_use id / Codex child thread id; no chat       | A full chat (`InstanceInfo`) plus an `AgentInfo` on the parent             |
| History                    | Read-only, from the provider's child transcript (`readAgentHistory`) | The child chat's own history                                               |
| Interaction                | View only; lifecycle owned by the provider                           | Fully interactive; cancel/stop through Relay                               |
| Outlives the parent's turn | Usually not (background children are provider-managed)               | Yes; the result arrives as a wake                                          |

The prior art draws the same line, with one difference in shape. Its single subagent record carries `origin: "provider_native" | "app_owned"`, and **both** origins get a child thread: the Claude and Codex adapters mirror every native subagent into a hidden child thread, so the same thread view, Agents panel, and hover card serve both. Child threads of either origin have no sidebar row and can't take user messages. What origin changes:

- **Stop**: app-owned children can always be stopped (stopping the task, then the child thread). Native ones can be stopped only on Claude, and only with a strong native task ref, through the provider's own task-stop control. Workflow-stop is Claude-native only.
- **Lifecycle tools and wakes**: `task_status`, `task_cancel`, completion cohorts, and wakes exist only for app-owned tasks. A native subagent's result reaches the parent through the provider itself.
- **Model display**: app-owned shows the child thread's model selection. Native shows what the provider reported.
- **Restart**: native background subagents get a "restarted while running" note keyed by their native id, because the provider owns their continuation.

Relay should keep its current split instead of mirroring native subagents into chats: provider transcripts already supply their history on demand, and a chat implies interactivity that a native subagent can't offer.

**One contract, an `origin` discriminator.**

- Add `AgentInfo.origin?: "provider" | "relay"` (absent = `"provider"`, so every existing transcript and replay is unchanged) and `childInstanceId?: string` for relay children. Both flow through the existing `agent_update` stream and the shared `mergeAgentInfo`, so live updates, replay, and REST never disagree.
- The same `AgentCard`, Agents sidecar row, `AgentDetail`, status badge, and accent colours render both. Origin only changes the affordances:
  - relay → provider logo of the child, "Open chat", Stop (→ `task_cancel`), and a "Delegated" marker;
  - provider → today's behaviour (expand inline, read-only).
- `AgentDetail` keeps a single history route (`GET /api/instances/:id/agents/:agentId/history`): `InstanceManager.readAgentHistory` dispatches on origin, returning the child chat's `getHistory(childInstanceId)` for relay children and the driver's file read for native ones. `useAgentHistory`, the live/final query key, and the source-preference rules stay as they are.
- `useAgentModelLabel` reads the child chat's effective model for relay children instead of probing a transcript head.

**Capability gate must split by origin.** Today `instance-view.tsx` swaps `agents`/`agentItems` for EMPTY maps when the provider lacks `supportsAgentActivity`. Relay children don't depend on that capability — a provider that can't report its own subagents can still have Relay children — so the gate becomes "drop `origin: "provider"` agents when `supportsAgentActivity` is false; always keep `origin: "relay"` agents." It stays the one gate at the source; nothing downstream checks the flag.

**Nesting.**

- Native subagents spawned _inside_ a Relay child belong to that child chat (its own cards and sidecar), not the parent. The parent's card for the child shows only the child's own status and result.
- Native subagents can probably reach the Relay tools: Claude subagents inherit the session's MCP servers by default, and Codex children may too (to verify). Relay can't tell which agent in the session made a call, because the credential belongs to the chat's session. So a `delegate_task` from a native subagent counts as coming from the owning chat, Its card goes in the chat's main stream, never nested inside the native subagent's detail, so `isMainStreamAgent` has to treat `origin: "relay"` agents as main-stream. The instructions already tell every child, native or Relay, to do the work itself. If this turns out noisy, add `mcp__relay__*` to the denied tools of Claude subagent definitions.

**Which one the agent uses** stays a prompt-level decision (section F): native for same-provider, same-checkout work that finishes this turn; `delegate_task` for another provider or model, work the user wants to interact with as its own chat, or work that should outlive the turn.

**Lifecycle parity.** Stop, mark done, and delete cascade to Relay children (section H). Native subagents already end with the parent's process, so no new behaviour is needed there; marking done keeps today's semantics for them.

**Not planned:** promoting a finished native subagent into a Relay chat. Its transcript is provider-owned and not resumable as a standalone session.

## Cross-provider notes to verify

- **Claude → Codex child**: confirm that Claude's MCP tool timeout tolerates `wait` mode. Otherwise default to `async` plus the wake.
- **Codex → Claude child**: confirm the `-c mcp_servers…` overrides work alongside the user's own `config.toml` servers under a non-default `CODEX_HOME`, and that the token env var survives `buildCodexSpawnEnv`.
- Codex already shows MCP tool calls as `mcpToolCall` items. Make sure Relay's activity labels render `relay` tool calls readably instead of as a generic MCP blob.
- Native subagents and Relay delegation are two different paths. Don't create a Relay child chat for a native Claude `Agent` spawn (see I).

## Phasing

1. **Endpoint + credentials + read-only tools** (`relay_capabilities`, `chat_list`, `chat_read`) for Claude and Codex. This proves the injection and auth end to end with no side effects.
2. **`delegate_task` / `task_status` / `task_cancel`** with the `delegated_tasks` table, the `AgentInfo.origin` split (cards, sidecar, history route, capability gate), child breadcrumb, inbox exclusion, and completion wake.
3. **`chat_send` / `chat_wait`** to ordinary chats, with the privilege ceiling.
4. Chat-link chips (and `isolation: "space"`, since removed with Spaces).

## Open questions

- In-process Claude SDK MCP vs. one HTTP endpoint for every provider? (Recommendation: HTTP.)
- ~~Should children show in the inbox?~~ Decided: no. They are reached from the parent's card and the Agents sidecar.
- ~~Does marking a parent done cancel its children?~~ Decided: yes, cascading, and owed wakes are dropped (see H).
- ~~Can the user type into a child chat?~~ Decided: yes, fully interactive (see G).
- ~~Retention?~~ Decided: kept while the parent exists, deleted recursively with it (see H).
- ~~"Send result to parent" action?~~ Decided: no. The user can prompt the child (or the parent) to pass a later result along; the parent can also `chat_read` the child.
- Should the wake be a visible `AgentNote` (recommended) or a hidden internal message?
- Do we need the `wait` mode at all in v1, given that the wake makes async the better default?
- ~~Limits?~~ Decided: none beyond Relay's existing global process cap. Recursion is governed by the instructions, as in the prior art. If runaway delegation shows up in practice, add a depth limit then.
- Should a child's process (it is a full chat) count against the global process cap, or get a separate budget so delegation can't starve the user's own chats?
