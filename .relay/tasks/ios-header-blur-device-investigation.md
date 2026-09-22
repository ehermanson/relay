---
version: 2
id: "ios-header-blur-device-investigation"
title: "Diagnose and fix standalone iOS header blur on device"
status: "in_progress"
priority: 1
type: "bug"
tags:
  - "ios"
  - "ui"
parent: null
blockedBy: []
createdAt: "2026-09-20T20:52:31.411Z"
updatedAt: "2026-09-21T15:27:16.405Z"
closedAt: null
---
Implemented shared --app-top-inset for body, sidebar, sidecar, drawers, dialogs and image viewer; extra22px applies only to installed iOS/iPadOS. Real-device production Web Inspector showed no header/ancestor CSS filters or transforms. User confirmed 16px still blurred title top;32px,27px and final22px were crisp, including drawer tabs. Native safe area62px +22px => body84px,title y93.421875. Prior fixed-header experiment inconclusive; this is clearance, not a native blur opt-out. Full CI passed with NODE_OPTIONS=--no-experimental-webstorage (1026 backend,253 UI tests;20 existing lint warnings); final22px app rebuild checked. AGENTS.md updated;README reviewed unchanged. Commit/push and fresh-install verification pending.
