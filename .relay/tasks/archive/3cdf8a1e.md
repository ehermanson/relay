---
version: 2
id: "3cdf8a1e"
title: "Complete lazy session hydration on session open"
status: "done"
priority: 1
type: "task"
tags: []
parent: null
blockedBy: []
createdAt: "2026-03-09T14:44:53.565737-04:00"
updatedAt: "2026-03-09T14:55:40.977173-04:00"
closedAt: null
---
Finish the in-progress lazy session restore work so the sidebar and dashboard render entirely from persisted DB metadata at startup, while full session hydration (history/tasks/files/team/git info/watchers/provider restore work as needed) happens only when a user opens the session route or otherwise requests history. Acceptance: restoreInstances should avoid eager transcript parsing for sidebar data; getHistory/subscribe path should hydrate external and managed sessions on demand; tests cover lazy restore metadata plus on-demand hydration; README and AGENTS.md reflect the new startup/hydration behavior.
