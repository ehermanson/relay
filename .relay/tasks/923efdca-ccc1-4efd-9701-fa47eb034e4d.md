---
version: 2
id: "923efdca-ccc1-4efd-9701-fa47eb034e4d"
title: "Mobile Home shows outdated Continue rows"
status: "done"
priority: 2
type: "bug"
tags:
  - "mobile"
  - "home"
parent: null
blockedBy: []
createdAt: "2026-09-22T00:29:51.865Z"
updatedAt: "2026-09-22T00:32:01.331Z"
closedAt: "2026-09-22T00:32:01.331Z"
---
Mobile Home froze its Continue/Projects order on the first render with non-loading data. With the persisted react-query cache that is stale localStorage data (and WS instances are empty until instance_list lands), so rows kept stale positions and newly recent chats appended past the 4-row cap and were sliced off. Fix: gate the order capture on fresh data (queries refetched this session + WS scan complete), keep Continue membership live (slice by live recency before stabilizing positions), and tick relative timestamps.
