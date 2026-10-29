# Relay Desktop

Relay Desktop uses Electron, the shared React product, and a separate Node utility process for Relay's server. Streaming stays on the existing HTTP/WebSocket path. The native bridge owns windowing, menus, file dialogs and OS integration.

```sh
pnpm desktop             # build and launch this source checkout
pnpm desktop:pack        # unsigned local native app, no release credentials
pnpm desktop:build       # local platform installers (not an update release)
pnpm desktop:release     # signed/notarized artifacts uploaded to a GitHub draft
pnpm desktop:test        # native policy, supervisor, updater and recovery tests
pnpm desktop:benchmark   # isolated sequential startup/restart benchmark
node desktop/benchmark.mjs --runs 3 --chats 500 --messages 2000
```

macOS ARM builds appear at `desktop-release/mac-arm64/Relay.app`. Build Windows/Linux on their respective platforms. Local builds do not enable automatic binary updates. Release builds require signing/notarization credentials; they must be explicitly requested with `--publish` or `--signed`. Nothing is published by `desktop:pack` or `desktop:build`. Local `desktop:release` uploads to a draft; the main-only workflow publishes after the complete platform matrix succeeds.

## Native behavior

- Native traffic lights share the sidebar header with the Chat header. Desktop is edge-to-edge with draggable header backgrounds, interactive controls, fullscreen-aware spacing, and matching native light/dark chrome. Windows/Linux caption controls occupy the trailing header edge.
- App menus provide New Chat, Add Project, Search, Toggle Sidebar, Settings, New Window, and ordinary editing/zoom shortcuts. Text context menus support editing, spelling suggestions, copying links, and opening links in the browser.
- Local mode provides folder selection and file actions: Reveal in Finder/Explorer and Open with Default App. Hosts validate canonical file paths against registered Projects, the working directories of their Chats (which may be linked worktrees), or Relay uploads; symlink escapes and executable file types are rejected. Code files can use the existing configured editor integration.
- Notifications and global Show Relay shortcut (`CommandOrControl+Shift+Space`) are opt-in in Settings → General. Unavailable shortcut registration is reported; no unrelated shortcut is displaced. Notifications are deduplicated across windows and focus the correct Chat without reloading the renderer.
- Dock/taskbar badges and tray status reflect running Chats, input requests and failures through the existing WebSocket stream. Multiple windows share one backend. The tray provides Show, Search, New Chat, New Window and Quit.
- Keep Running When Closed is configurable. The last screen and window position/size are saved atomically and clamped to connected displays. Quit shuts down the owned backend. A renderer crash offers reload while preserving the backend; unexpected backend exits recover with bounded backoff, refresh the cookie, and reload windows. Repeated failures stop retrying and surface an error.
- Wake reconciliation refreshes discovery without adding polling timers. `relay://open?path=%2Fprojects%2F...` routes to a Chat; deep links normalize and restrict routes. Packaged installs register the protocol. Source registration requires `RELAY_REGISTER_PROTOCOL=1` so development does not replace the installed handler.

## Desktop and web coexistence

Default local mode owns isolated `~/.relay-desktop` state; override with absolute `RELAY_DESKTOP_HOME`. It uses existing Provider transcript roots but does not merge writable CLI settings or managed bindings from `~/.relay`. Desktop and CLI share an OS-backed exclusive state lock, so explicit attempts to point two servers at the same DB fail safely.

Settings → General → Relay Server can instead connect to an existing Relay origin. `RELAY_DESKTOP_SERVER_URL` is a launch override. Only HTTPS or loopback HTTP is allowed; URLs cannot contain credentials, paths, queries or fragments. Existing mode starts no backend, uses the server's normal login in a separate persistent browser partition, and never stops that server on Quit. It restores web sharing/Sign Out controls and disables local folder/file actions so remote server paths cannot target this computer. Choose this mode to use the existing CLI server, settings, Projects and phone/tunnel access together. Switching mode saves configuration and relaunches; an owned busy backend must become idle first.

The owned server restores the login-shell PATH with a bounded deadline, binds `127.0.0.1`, persists its port/origin, and uses a private per-launch password and cookie. Origin stability preserves localStorage and IndexedDB. Offline sends retain a stable desktop owner across launches. An occupied saved port fails explicitly instead of silently discarding browser state. No owned desktop tunnel or browser push subscription is started.

## Seamless updates

The existing sidebar/Settings Update UI and authenticated `/api/system/update` routes are shared. `UpdateService` supplies the same snapshot/check/install contract for three cases:

1. **Web install:** existing git pull, dependency installation, build, restart, then browser Reload behavior.
2. **Native source launch:** the existing git/install/build process followed by native relaunch using the newly installed Electron executable. Dirty or non-main source checkouts refuse updates instead of stashing active development work.
3. **Native release:** `electron-updater` checks the bundled GitHub feed, explicitly downloads the platform release with progress, and installs/relaunches. Automatic installation on ordinary Quit is disabled.

Before native restart, an atomic server gate checks owned managed work, pending approvals/plans/queued messages, and live terminals. It rejects new work and closes transports only when idle. Main then awaits graceful backend exit. Busy work defers the update with a retry message; downloaded artifacts remain ready. macOS installer signature verification can fail asynchronously: the app restores the current backend, authentication and windows on failure instead of leaving a dead shell. Unit tests inject an adapter; the local signed integration test also exercises the real installer. No signature checks are disabled.

When attached to another server, the shared Update UI upgrades that server and retains its web Reload behavior. Help → Update Desktop Shell controls the native application separately.

The GitHub feed targets `ehermanson/relay`. `.github/workflows/desktop.yml` packages and smoke-tests macOS/Windows/Linux. Release versions are `<package-major>.<package-minor>.<main-history-count>` with the source SHA recorded in the package, so main updates remain monotonic without changing the web package version. Manual dispatch from main can publish. All platforms upload to a draft; a final job checks the platform feeds and installers before publishing the complete release. Set repository variable `RELAY_DESKTOP_RELEASES=true` to publish after each main push once credentials are configured. It is disabled until configured; no workflow has been dispatched or remote release published by this implementation.

Required GitHub secrets:

- `RELAY_MAC_CERTIFICATE` (Developer ID P12 URL/base64) and `RELAY_MAC_CERTIFICATE_PASSWORD`.
- `RELAY_APPLE_API_KEY` (private P8 key text), `RELAY_APPLE_API_KEY_ID`, and `RELAY_APPLE_API_ISSUER` for notarization.
- `RELAY_WINDOWS_CERTIFICATE` and `RELAY_WINDOWS_CERTIFICATE_PASSWORD` for signed Windows releases.

GitHub's scoped workflow token publishes artifacts; it is not embedded in the app. Local signed builds can use standard electron-builder signing environment variables and an Apple notarization keychain profile. Store credentials in secure stores/CI secrets, never Project files. macOS updates require a signed release. A real local Developer ID signed upgrade from 3.0.0 to 3.0.1 passed download, Squirrel replacement, relaunch and state-preservation checks. Public GitHub update delivery and notarization remain unverified until release credentials are configured and releases published.

## Performance and validation

Backend work is isolated from the renderer/main process. Desktop delays the filesystem scan by two seconds so `/auth`, assets and first paint do not compete with synchronous history scanning; ordinary web startup is unchanged. The shared virtualized Chat UI and lazy modules remain intact. Fonts are bundled and served as binary assets.

The benchmark creates only temporary Provider roots and a temporary git Project, sends no Provider prompts, verifies a real PTY and 1 MiB output, profiles a synthetic large Chat, and checks port/owner/browser-storage persistence across restarts. JSON reports live in ignored `desktop-release/`. `Help → Performance Diagnostics` exposes startup/process metrics; Export Diagnostics saves a local report with no transcript content or credentials.

Measured on this Mac, three source launches with 500 Chats and a 4,000-message Chat: median visible startup 1.146s; median Chat opening 145ms; maximum measured scroll frame 28ms; no frames over 50 ms; peak 33 mounted message rows; median native PTY throughput 10.9 MiB/s. These are synthetic measurements, not guarantees for every Project. Memory remains substantial: median summed process working sets 789 MiB (shared pages may be counted more than once), backend RSS 336 MiB, renderer JS heap 23 MiB. Startup CPU includes warmup/indexing, not settled idle.

`RELAY_DESKTOP_SMOKE=1` validates boot, bridge, fonts, native terminal and state, then quits. `RELAY_DESKTOP_RECOVERY_SMOKE=1` additionally forces backend recovery. `RELAY_DESKTOP_UPDATE_SMOKE=1` simulates an asynchronous installer rejection through the real native lifecycle, verifies exactly one attempted install and preserved owner/storage, and restores the current backend. The fake adapter performs no download, binary modification or application installation. Use a temporary home and `RELAY_DESKTOP_BENCHMARK=1` to isolate Provider roots. CI runs policy/lifecycle/update tests; the platform workflow also runs packaged smoke. Packaged native smoke has passed on macOS, Windows and Linux through the platform workflow. Attached-server smoke also verifies that quitting the native app leaves an existing open or authenticated server alive.

Memory retention is now bounded: shared parsed transcripts use a 32 MiB / 100-entry LRU, Codex child history uses 16 MiB, inactive UI history uses 16 MiB / 30 entries, and prepared text uses 2 MiB / 1024 entries. Cache budgets estimate payload retention; they do not cap the full process heap or discard active Chats. Evicted history reloads from canonical transcripts. Both providers parse JSONL in 64 KiB UTF-8 chunks and retain the existing replay tail while folding all state. Query callbacks are defined outside Chat render scopes so query metadata cannot keep complete histories alive.

To reproduce the sustained-memory stress test:

```sh
pnpm build
node desktop/benchmark.mjs --runs 2 --memory --chats 32 --large-chats 32 --messages 300 --message-bytes 4096 --output desktop-release/memory.json
# Optional private renderer heap snapshots:
node desktop/benchmark.mjs --runs 2 --memory --heap-snapshot --chats 32 --large-chats 32 --messages 300 --message-bytes 4096 --output desktop-release/memory-snapshot.json
```

On this Mac, two before/after runs navigating 32 large Chats twice reduced final retained backend heap from about 59 MiB to 25 MiB and renderer heap from 97 MiB to 20 MiB. Natural summed process working sets immediately after the first navigation pass changed from 1,132–1,180 MiB to 890–933 MiB. Final working sets were 646–746 MiB before and 584–654 MiB after; resident measurements fluctuate and may count shared pages twice. Retained samples explicitly collect garbage in the isolated benchmark to distinguish live references from temporary allocation; production never forces GC. These are synthetic measurements, not a guarantee of lower resident memory in every workload. Initial startup memory remains variable. A separate three-run comparison starting from the dashboard with 500 Chats and a 4,000-message transcript measured median startup 945 → 964 ms, Chat opening 147 → 155 ms, maximum scroll frame 32 → 29 ms, and no frames over 50 ms. Those small timing differences are not a demonstrated speedup; evicted large Chats trade retention for a disk replay on revisit. Heap snapshots contain fixture data and are written owner-only into ignored build output; never publish snapshots from real user data.

Packaging deploys locked production dependencies into `.desktop-stage` and rebuilds native modules there, keeping the CLI dependency ABI intact. Native libraries, PTY helpers and bundled Provider binaries are unpacked from ASAR. Renderer sandboxing, context isolation, exact main-frame IPC checks, restricted UI-only window routes, CSP, denied webviews and restricted permissions protect the native boundary. Trusted-origin sanitized clipboard writes preserve Copy actions; clipboard reads and media/location permissions remain denied. Attached older servers may load only the two standard Google Fonts hosts for font compatibility.

References: [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance), [utility processes](https://www.electronjs.org/docs/latest/api/utility-process), [security](https://www.electronjs.org/docs/latest/tutorial/security), [electron-builder v26 updates](https://www.electron.build/v26/docs/features/auto-update/), [native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules), [Tauri webviews](https://v2.tauri.app/reference/webview-versions/).

## Local signed macOS upgrade test

After `pnpm desktop:pack`, run `node desktop/signed-update-test.mjs`. This requires an existing, valid **Developer ID Application** identity in the local macOS keychain. The runner creates two temporary copies of the app (3.0.0 and 3.0.1), gives them a unique test bundle ID, signs both with identical Electron entitlements and hardened runtime, and serves the newer ZIP from a loopback-only feed. It exercises the real `electron-updater`/Squirrel download, signature verification, app replacement and relaunch. The relaunched app checks that its version changed while its listener origin, outbox owner and browser storage survived.

No GitHub release is published, no installed app is modified, and no Provider prompts are sent. Test app bundles and Relay state live under a temporary directory; native macOS update services may also create their ordinary system cache. Artifacts are retained at the printed `SIGNED_UPDATE_TEST_ROOT` for inspection. The machine-readable result is `desktop-release/signed-update-test.json`. The test does not disable signature verification, ASAR integrity or OS security checks. Timestamping is omitted for these ephemeral local signatures; this test does **not** verify notarization, public release delivery, or Windows/Linux installation.
