---
version: 2
id: "73adce9a"
title: "Trace sidecar agent jitter root cause"
status: "done"
priority: 1
type: "bug"
tags: []
parent: null
blockedBy: []
createdAt: "2026-03-10T20:43:05.682508-04:00"
updatedAt: "2026-03-10T20:50:12.098941-04:00"
closedAt: null
---
Instrument/read the sidecar + agent activity pipeline to determine whether jitter comes from sidecar mount/unmount, tab recomputation, unstable counts, or panel render churn during agent updates.
