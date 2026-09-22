---
version: 2
id: "inbox-spaces-integration"
title: "Integrate sidebar, rail, space selection and verify behavior"
status: "done"
priority: 2
type: "task"
tags: []
parent: null
blockedBy: []
createdAt: "2026-09-18T20:14:09.045710+00:00"
updatedAt: "2026-09-18T20:24:05.644344+00:00"
closedAt: null
---
Implemented grouped sidebar/rail, remembered member-chat navigation, independent persisted pins and aggregate attention/unread. Final CI passed: build, typecheck, lint, 959 backend + 199 app tests (NODE_OPTIONS=--no-experimental-webstorage for local test runtime compatibility). Browser smoke verified space grouping, remembered tab selection, compact rail and space menu. Spec: plans/inbox-spaces.md.
