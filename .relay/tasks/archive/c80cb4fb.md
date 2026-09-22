---
version: 2
id: "c80cb4fb"
title: "Add force-stop button for agents in the UI"
status: "done"
priority: 2
type: "task"
tags: []
parent: null
blockedBy: []
createdAt: "2026-03-12T22:40:26.622197-04:00"
updatedAt: "2026-03-14T12:59:08.981007-04:00"
closedAt: null
---
Currently there's no way to force-stop a running agent from the UI. When an agent is stuck or the user wants to abort immediately, they have no recourse other than killing the process externally. Add a force-stop control (e.g. SIGKILL or equivalent) that can terminate the agent process from the UI, distinct from the normal cancel (SIGINT) flow.
