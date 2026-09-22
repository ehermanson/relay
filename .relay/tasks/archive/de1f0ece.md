---
version: 2
id: "de1f0ece"
title: "Abstract plan discovery beyond ~/.claude/plans/"
status: "done"
priority: 2
type: "task"
tags: []
parent: null
blockedBy:
  - "4c40cf1a"
createdAt: "2026-03-09T17:46:05.568906-04:00"
updatedAt: "2026-03-15T14:31:10.098411-04:00"
closedAt: null
---
Provider-gate plan discovery in getProjectArtifacts(). Currently scans ~/.claude/plans/ unconditionally — should only run for projects with Claude sessions. The live plan flow (stream → pendingPlan → review) is already provider-agnostic; this is just the historical plan discovery for the project /plans page.

Scope:
- Skip plan slug extraction + plan file reads when project has no Claude provider sessions
- Pass 2 (custom filename discovery) hardcodes `.claude/plans/` — gate behind provider check
- Consider surfacing stream-captured plans for non-Claude providers (Codex plans are stream-only)
