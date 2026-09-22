---
version: 2
id: "ffbc884b"
title: "Claude SDK: surface `blocked` state from workflow_agent events in agents view"
status: "open"
priority: 2
type: "task"
tags:
  - "provider-watch"
  - "claude"
  - "bucket-2"
parent: null
blockedBy: []
createdAt: "2026-07-06T00:00:00.000Z"
updatedAt: "2026-07-22T00:00:00.000Z"
closedAt: null
---
**What changed**: SDK 0.3.199 added a `blocked` field to `workflow_agent` progress events, set to `true` when an agent was blocked by the auto-mode safety classifier.

**Bucket**: 2 (capability-declaration)

**ProviderCapabilities / abstraction**: No new `ProviderCapabilities` field required — this is new event data in the existing `workflow_agent` event shape. Touch point: the live activity stream in `claude-sdk.ts` that processes `workflow_agent` events, and the agents sidecar component that renders agent rows.

**UI control**: Agents sidecar view should show a `blocked` indicator (badge, icon, or status label) on affected agent rows so users know an agent stalled on the safety classifier. Related to open task `803fe57b` (nested subagent activity view); consider landing as a prerequisite detail of that redesign.

**Scope estimate**: Small. (1) Parse `blocked` field in the `workflow_agent` event handler in `claude-sdk.ts`. (2) Forward it through the `AgentActivity` / `ActivityMessage` type. (3) Render a `ShieldAlert` icon or equivalent on blocked agent rows in the sidecar.

**Changelog ref**: @anthropic-ai/claude-agent-sdk 0.3.199

---

**Kickback note (2026-07-22):** Two blockers make this not mechanical: (1) The installed SDK is pinned at 0.3.197; `workflow_agent` events were added in 0.3.199, so there is no event type to handle in the current codebase. (2) The sidecar has no agents tab today — `SidecarTab = 'tasks' | 'files' | 'plan' | 'context' | 'brief' | 'review'` — so there is no UI surface to render blocked agent rows. Both the SDK upgrade and an agents sidecar view are prerequisites. Recommend pairing with task `803fe57b` (nested subagent activity design) once that design lands.
