---
version: 2
id: "de495efa"
title: "Add QR-based Relay pairing for remote access"
status: "done"
priority: 2
type: "task"
tags:
  - "remote"
  - "auth"
  - "qr"
  - "ux"
parent: null
blockedBy: []
createdAt: "2026-04-11T16:37:00-04:00"
updatedAt: "2026-04-11T22:32:47.907Z"
closedAt: null
---
Make it easier to connect a phone, tablet, or secondary laptop to an existing Relay server by adding a QR-driven pairing flow. Prefer a short-lived, single-use pairing token over encoding the password directly in the QR code. Scope should cover server-side token issuance/validation, a small UI surface to show available connection endpoints and the QR code, session-cookie bootstrap after scan, and clear expiry/error handling.
