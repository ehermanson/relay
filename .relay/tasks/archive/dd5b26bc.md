---
version: 2
id: "dd5b26bc"
title: "Make the UI provider-aware for Codex capabilities"
status: "done"
priority: 2
type: "task"
tags: []
parent: "befb4eea"
blockedBy:
  - "0a13e811"
createdAt: "2026-03-08T16:02:59.980668-04:00"
updatedAt: "2026-03-12T20:30:13.336845-04:00"
closedAt: null
---
Update the server/UI contract so labels, controls, and warnings are provider-aware instead of Claude-branded. This includes managed instance creation/provider selection, message labeling, model/reasoning control visibility, permission/sandbox messaging, and any capability gating needed where Codex differs from Claude. Scope is limited to relay-managed Codex sessions.
