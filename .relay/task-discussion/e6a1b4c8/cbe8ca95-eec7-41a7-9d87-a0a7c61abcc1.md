---
version: 2
id: "cbe8ca95-eec7-41a7-9d87-a0a7c61abcc1"
taskId: "e6a1b4c8"
author: null
replyTo: null
createdAt: "2026-10-07T14:00:00.000Z"
---
Kicked back — needs human design decision. `permissionPrompts: 'none'` is orthogonal to `permissionMode` and doesn't map to an existing `ProviderRuntimeMode`. The design question is whether this becomes a new peer value in `ProviderRuntimeMode` (with DB migration and picker UI updates) or a boolean session flag alongside an existing mode. That choice determines the full touch surface. Once decided, the wiring is mechanical.
