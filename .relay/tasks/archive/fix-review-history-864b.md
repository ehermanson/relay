---
version: 2
id: "fix-review-history-864b"
title: "Fix agent history completeness and nested attribution"
status: "done"
priority: 1
type: "bug"
tags:
  - "agents"
parent: null
blockedBy: []
createdAt: "2026-09-18T19:59:01.592Z"
updatedAt: "2026-09-18T20:01:02.301Z"
closedAt: null
---
Fixed history selection so partial live prose cannot hide fuller fetched history; preserved Claude grandchild attribution and excluded known grandchildren from child-stream fallback. Added regression coverage and updated AGENTS.md; README reviewed, unchanged. Full ci-check passed with NODE_OPTIONS=--no-experimental-webstorage: build, typecheck, lint, 1,020 backend tests, and 238 UI tests.
