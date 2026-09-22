---
version: 2
id: "cfeec325"
title: "Hide injected task-context prompts in Codex replayed chats"
status: "done"
priority: 1
type: "bug"
tags:
  - "codex"
  - "ui"
  - "history"
parent: null
blockedBy: []
createdAt: "2026-03-20T13:14:30Z"
updatedAt: "2026-03-20T13:17:00Z"
closedAt: null
---
Investigate why Codex sessions still show Relay-injected startup/task-context prompts in the hydrated message list. Patch the Codex transcript conversion path to preserve internal-only prompts as hidden UI state, add regression coverage, and verify build/tests.
