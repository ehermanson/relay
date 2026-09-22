---
version: 2
id: "f57bfbc6"
title: "Codex: parse 0.153 rollout item_completed format + activity-based external discovery"
status: "done"
priority: 1
type: "bug"
tags:
  - "codex"
  - "provider-watch"
parent: null
blockedBy: []
createdAt: "2026-09-07T00:18:53.512295Z"
updatedAt: "2026-09-07T00:18:53.512295Z"
closedAt: null
---
Codex CLI 0.153 replaced `event_msg user_message/agent_message/agent_reasoning` in rollout JSONL with `event_msg item_completed` typed items (`UserMessage`, `AgentMessage`, `Reasoning`, ...). Relay's transcript parser only knew the old events, so hydrated Codex chats (external and managed-on-restart) showed tool activity but no messages, default titles, and no previews. Separately, Codex Desktop threads expose no `codex` process with the project cwd, so PID-based discovery never sees them.

- Handle `item_completed` in `convertCodexTranscriptEntry`; shared helper for scan title + last-message preview; widen scan window past 64KB.
- Re-title rows still carrying the default title.
- Codex driver: treat transcripts with fresh mtime in registered cwds as live external sessions (pid-less).
