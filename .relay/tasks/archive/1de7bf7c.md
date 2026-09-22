---
version: 2
id: "1de7bf7c"
title: "Fix missing message list content in space chat view"
status: "done"
priority: 1
type: "bug"
tags:
  - "spaces"
  - "chat"
  - "ui"
parent: null
blockedBy: []
createdAt: "2026-03-20T13:02:26Z"
updatedAt: "2026-03-20T13:08:45Z"
closedAt: null
---
Investigate why chats opened within a non-default space show no transcript rows in the message list UI even when instance/session metadata and last message are present. Patch the state/render path, verify the fix, and update docs if needed.
