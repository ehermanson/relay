/**
 * WebSocket Server for Relay
 *
 * Handles WebSocket connections from remote clients,
 * authenticates them using session cookies, and relays messages
 * between clients and the InstanceManager.
 *
 * Each client tracks which instances it is subscribed to.
 * Output/activity/exit events go only to subscribed clients.
 * Status/create/remove events broadcast to all connected clients.
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AuthManager } from "#server/auth.js";
import type { InstanceManager } from "#core/instance-manager.js";
import { MaxProcessesError } from "#core/instance-manager.js";
import type { TerminalManager } from "#core/terminal-manager.js";
import type { InstanceInfo } from "#core/types.js";
import { getPrimaryRemote } from "#core/git.js";
import { getRepoStatusService } from "#core/repo-status-service.js";
import {
  isRepoStatusTarget,
  repoStatusTargetKey,
  resolveRepoStatusDir,
} from "#server/repo-status-targets.js";
import type { RelayConfig } from "#server/config.js";
import type {
  ClientMessage,
  ServerMessage,
  OutputMessage,
  ExitMessage,
  ActivityMessage,
  SystemEventMessage,
  AgentUpdateMessage,
  UserMessage,
  QueuedRemovedMessage,
  FileStatsMessage,
  RepoStatusTarget,
  ProviderGlobalState,
  ProviderKind,
} from "#core/types.js";

function truncateSessionId(sessionId: string): string {
  return sessionId.substring(0, 8) + "...";
}

function sendMessage(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/** Result returned by createWebSocketServer */
export interface WebSocketServerHandle {
  wss: WebSocketServer;
  /** Returns the number of currently authenticated WebSocket connections */
  getConnectionCount(): number;
}

/**
 * Create and configure the WebSocket server.
 */
export function createWebSocketServer(
  server: http.Server,
  instanceManager: InstanceManager,
  auth: AuthManager,
  config: RelayConfig,
  getTerminalManager?: () => TerminalManager | undefined,
): WebSocketServerHandle {
  const wss = new WebSocketServer({ server });
  const log = config.logger;
  const spaceManager = instanceManager.getSpaceManager();
  const replayEpoch = Date.now();

  // Per-client subscription sets (instance subscriptions)
  const subscriptions = new Map<WebSocket, Set<string>>();

  // Per-client terminal subscriptions (terminalId sets)
  const terminalSubscriptions = new Map<WebSocket, Set<string>>();

  // ── Repo status subscriptions (push-based git status) ──
  // Per client: target key → unsubscribe from the shared status service.
  const repoStatusSubscriptions = new Map<WebSocket, Map<string, () => void>>();
  const repoStatusService = getRepoStatusService();

  function subscribeRepoStatus(ws: WebSocket, target: RepoStatusTarget): void {
    const key = repoStatusTargetKey(target);
    let subs = repoStatusSubscriptions.get(ws);
    if (!subs) {
      subs = new Map();
      repoStatusSubscriptions.set(ws, subs);
    }
    if (subs.has(key)) {
      // Re-subscribe (e.g. a second view mounted): resend the snapshot.
      subs.get(key)?.();
      subs.delete(key);
    }
    const dir = resolveRepoStatusDir(instanceManager, target);
    if (!dir) {
      sendMessage(ws, { type: "repo_status", target, status: null, error: "Target not found" });
      return;
    }
    const unsubscribe = repoStatusService.subscribe(dir, (status) => {
      sendMessage(ws, { type: "repo_status", target, status });
    });
    subs.set(key, unsubscribe);
  }

  function unsubscribeRepoStatus(ws: WebSocket, target: RepoStatusTarget): void {
    const subs = repoStatusSubscriptions.get(ws);
    const key = repoStatusTargetKey(target);
    subs?.get(key)?.();
    subs?.delete(key);
  }

  function clearRepoStatusSubscriptions(ws: WebSocket): void {
    const subs = repoStatusSubscriptions.get(ws);
    if (!subs) return;
    for (const unsubscribe of subs.values()) unsubscribe();
    repoStatusSubscriptions.delete(ws);
  }
  const MAX_REPLAY_EVENTS = 500;
  type ReplayableServerMessage =
    | OutputMessage
    | ActivityMessage
    | SystemEventMessage
    | ExitMessage
    | AgentUpdateMessage
    | UserMessage
    | QueuedRemovedMessage
    | FileStatsMessage;
  type ReplayEntry = { sequence: number; message: ReplayableServerMessage };
  type ReplayBuffer = { nextSequence: number; events: ReplayEntry[] };
  const replayBuffers = new Map<string, ReplayBuffer>();
  const replayReasonCounts = new Map<
    "no_cursor" | "epoch_mismatch" | "empty_buffer" | "ahead_of_server" | "buffer_miss" | "delta",
    number
  >();

  function getReplayBuffer(instanceId: string): ReplayBuffer {
    let buffer = replayBuffers.get(instanceId);
    if (!buffer) {
      buffer = { nextSequence: 1, events: [] };
      replayBuffers.set(instanceId, buffer);
    }
    return buffer;
  }

  function getLatestSequence(instanceId: string): number {
    const buffer = replayBuffers.get(instanceId);
    return buffer ? buffer.nextSequence - 1 : 0;
  }

  function appendReplayEvent<T extends ReplayableServerMessage>(instanceId: string, message: T): T {
    const buffer = getReplayBuffer(instanceId);
    const annotated = {
      ...message,
      instanceId,
      eventSequence: buffer.nextSequence++,
    } as T;
    buffer.events.push({
      sequence: annotated.eventSequence ?? 0,
      message: { ...annotated },
    });
    if (buffer.events.length > MAX_REPLAY_EVENTS) {
      buffer.events.splice(0, buffer.events.length - MAX_REPLAY_EVENTS);
    }
    return annotated;
  }

  function getReplayDelta(
    instanceId: string,
    lastSeenSequence: number | undefined,
    clientReplayEpoch: number | undefined,
  ): {
    replayMode: "full" | "delta";
    latestSequence: number;
    events: ReplayableServerMessage[];
    reason:
      | "no_cursor"
      | "epoch_mismatch"
      | "empty_buffer"
      | "ahead_of_server"
      | "buffer_miss"
      | "delta";
  } {
    const latestSequence = getLatestSequence(instanceId);
    if (lastSeenSequence === undefined) {
      return { replayMode: "full", latestSequence, events: [], reason: "no_cursor" };
    }

    if (clientReplayEpoch !== replayEpoch) {
      return { replayMode: "full", latestSequence, events: [], reason: "epoch_mismatch" };
    }

    const buffer = replayBuffers.get(instanceId);
    if (!buffer || buffer.events.length === 0) {
      return { replayMode: "full", latestSequence, events: [], reason: "empty_buffer" };
    }

    if (lastSeenSequence > latestSequence) {
      return { replayMode: "full", latestSequence, events: [], reason: "ahead_of_server" };
    }

    const earliestSequence = buffer.events[0].sequence;
    if (lastSeenSequence < earliestSequence - 1) {
      return { replayMode: "full", latestSequence, events: [], reason: "buffer_miss" };
    }

    return {
      replayMode: "delta",
      latestSequence,
      events: buffer.events
        .filter((entry) => entry.sequence > lastSeenSequence)
        .map((entry) => ({ ...entry.message })),
      reason: "delta",
    };
  }

  function noteReplayReason(
    reason:
      | "no_cursor"
      | "epoch_mismatch"
      | "empty_buffer"
      | "ahead_of_server"
      | "buffer_miss"
      | "delta",
  ): number {
    const nextCount = (replayReasonCounts.get(reason) ?? 0) + 1;
    replayReasonCounts.set(reason, nextCount);
    return nextCount;
  }

  function sendToTerminalSubscribers(terminalId: string, message: ServerMessage): void {
    for (const [ws, subs] of terminalSubscriptions) {
      if (subs.has(terminalId)) {
        sendMessage(ws, message);
      }
    }
  }

  function canAccessTerminalScope(
    ws: WebSocket,
    scope: { type: "space"; spaceId: string } | { type: "instance"; instanceId: string },
  ): boolean {
    const subs = subscriptions.get(ws);
    if (!subs) return false;

    if (scope.type === "instance") {
      return subs.has(scope.instanceId);
    }

    for (const instanceId of subs) {
      const instance = instanceManager.listInstances().find((item) => item.id === instanceId);
      if (instance?.spaceId === scope.spaceId) {
        return true;
      }
    }
    return false;
  }

  function getAuthorizedTerminal(ws: WebSocket, tm: TerminalManager, terminalId: string) {
    const terminal = tm.getTerminal(terminalId);
    if (!terminal) {
      sendMessage(ws, { type: "error", message: `Terminal ${terminalId} not found` });
      return undefined;
    }
    if (!canAccessTerminalScope(ws, terminal.scope)) {
      sendMessage(ws, { type: "error", message: "Unauthorized terminal access" });
      return undefined;
    }
    return terminal;
  }

  // Ping/pong heartbeat to detect dead connections (e.g. network drops)
  // Also sends an application-level heartbeat message so browser clients
  // (which can't see pong frames) know the connection is alive.
  const PING_INTERVAL = 30_000;
  const MAX_MISSED_PONGS = 4;
  const missedPongs = new Map<WebSocket, number>();
  const pingTimer = setInterval(() => {
    for (const [ws] of subscriptions) {
      const misses = missedPongs.get(ws) ?? 0;
      if (misses >= MAX_MISSED_PONGS) {
        // Allow several missed ping cycles before declaring the connection
        // dead. Mobile/Tailscale links can briefly stall without the socket
        // being permanently gone.
        log.info("WebSocket connection dead (missed heartbeat), terminating");
        missedPongs.delete(ws);
        ws.terminate();
        continue;
      }
      missedPongs.set(ws, misses + 1);
      ws.ping();
      sendMessage(ws, { type: "heartbeat" });
    }
  }, PING_INTERVAL);
  wss.on("close", () => {
    clearInterval(pingTimer);
    for (const ws of Array.from(repoStatusSubscriptions.keys())) clearRepoStatusSubscriptions(ws);
  });

  // Broadcast to all authenticated clients
  function broadcast(message: ServerMessage): void {
    for (const [ws] of subscriptions) {
      sendMessage(ws, message);
    }
  }

  // Send to clients subscribed to a specific instance
  function sendToSubscribers(instanceId: string, message: ServerMessage): void {
    for (const [ws, subs] of subscriptions) {
      if (subs.has(instanceId)) {
        sendMessage(ws, message);
      }
    }
  }

  function broadcastSpaceList(projectDirectory: string): void {
    broadcast({
      type: "space_list",
      projectDirectory,
      spaces: spaceManager.listAllSpaces(projectDirectory),
    });
  }

  // Wire up InstanceManager events
  instanceManager.on("instance:output", (instanceId: string, message: OutputMessage) => {
    sendToSubscribers(instanceId, appendReplayEvent(instanceId, message));
  });

  instanceManager.on("instance:activity", (instanceId: string, message: ActivityMessage) => {
    sendToSubscribers(instanceId, appendReplayEvent(instanceId, message));
  });

  instanceManager.on("instance:system_event", (instanceId: string, message: SystemEventMessage) => {
    sendToSubscribers(instanceId, appendReplayEvent(instanceId, message));
  });

  instanceManager.on("instance:exit", (instanceId: string, message: ExitMessage) => {
    sendToSubscribers(instanceId, appendReplayEvent(instanceId, message));
  });

  instanceManager.on("instance:error", (instanceId: string, message: string) => {
    sendToSubscribers(instanceId, { type: "error", message, instanceId });
  });

  instanceManager.on("instance:status", (instanceId: string, info: InstanceInfo) => {
    broadcast({ type: "instance_status", instanceId, instance: info });
  });

  instanceManager.on(
    "provider_global_state:updated",
    (provider: ProviderKind, state: ProviderGlobalState) => {
      broadcast({ type: "provider_global_state", provider, state });
    },
  );

  // External session discovery events
  instanceManager.on("instance:created", (instanceId: string, info: InstanceInfo) => {
    broadcast({ type: "instance_created", instanceId, instance: info });
  });

  instanceManager.on("instance:removed", (instanceId: string) => {
    // Remove from all clients' subscriptions
    for (const [, subs] of subscriptions) {
      subs.delete(instanceId);
    }
    // Clean up any terminals scoped to this instance
    const tm = getTerminalManager?.();
    if (tm) {
      tm.closeAllForScope({ type: "instance", instanceId });
    }
    replayBuffers.delete(instanceId);
    broadcast({ type: "instance_removed", instanceId });
  });

  instanceManager.on("instance:user", (instanceId: string, message) => {
    sendToSubscribers(instanceId, appendReplayEvent(instanceId, message));
  });

  instanceManager.on(
    "instance:queued_removed",
    (instanceId: string, message: QueuedRemovedMessage) => {
      sendToSubscribers(instanceId, appendReplayEvent(instanceId, message));
    },
  );

  instanceManager.on("instance:agent_update", (instanceId: string, message: AgentUpdateMessage) => {
    sendToSubscribers(instanceId, appendReplayEvent(instanceId, message));
  });

  instanceManager.on("instance:file_stats", (instanceId: string, message: FileStatsMessage) => {
    sendToSubscribers(instanceId, appendReplayEvent(instanceId, message));
  });

  instanceManager.on("instances:changed", () => {
    broadcast({
      type: "instance_list",
      instances: instanceManager.listInstances(),
    });
  });

  instanceManager.on("scan:complete", () => {
    broadcast({ type: "scan_complete" });
  });

  instanceManager.on("projects:changed", () => {
    broadcast({
      type: "instance_list",
      instances: instanceManager.listInstances(),
    });
    broadcast({
      type: "projects_changed",
      projects: instanceManager.projectManager.listProjects(),
    });
  });

  instanceManager.on("tasks:changed", (projectId: string, spaceId?: string) => {
    broadcast({ type: "tasks_changed", projectId, spaceId });
  });

  spaceManager.on("space:created", (space) => {
    broadcast({ type: "space_created", space });
    broadcastSpaceList(space.projectDirectory);
  });

  spaceManager.on("space:updated", (space) => {
    broadcastSpaceList(space.projectDirectory);
  });

  spaceManager.on(
    "space:completed",
    (spaceId, projectDirectory, targetBranch, mergeMethod, mergeCommit) => {
      // Clean up terminals — the worktree is gone after completion
      const tm = getTerminalManager?.();
      if (tm) {
        tm.closeAllForScope({ type: "space", spaceId });
      }
      broadcast({ type: "space_completed", spaceId, targetBranch, mergeMethod, mergeCommit });
      broadcastSpaceList(projectDirectory);
    },
  );

  spaceManager.on("space:removed", (spaceId, projectDirectory) => {
    // Clean up any terminals scoped to this space
    const tm = getTerminalManager?.();
    if (tm) {
      tm.closeAllForScope({ type: "space", spaceId });
    }
    broadcast({ type: "space_removed", spaceId });
    broadcastSpaceList(projectDirectory);
  });

  // Wire up TerminalManager events — deferred since the manager may not be
  // available until after start() completes.
  let terminalManagerBound = false;

  function broadcastTerminalScopes(tm: TerminalManager): void {
    broadcast({ type: "terminal_scopes", scopes: tm.listActiveScopes() });
  }

  function bindTerminalManager(): TerminalManager | undefined {
    const tm = getTerminalManager?.();
    if (tm && !terminalManagerBound) {
      terminalManagerBound = true;
      tm.on("terminal:output", (terminalId, data) => {
        sendToTerminalSubscribers(terminalId, { type: "terminal_output", terminalId, data });
      });
      tm.on("terminal:exit", (terminalId, code, signal) => {
        sendToTerminalSubscribers(terminalId, { type: "terminal_exit", terminalId, code, signal });
        // An exited shell no longer counts as a live terminal — refresh the
        // global scope snapshot so sidebar indicators clear.
        broadcastTerminalScopes(tm);
      });
      tm.on("terminal:created", (terminal) => {
        for (const [ws] of subscriptions) {
          if (canAccessTerminalScope(ws, terminal.scope)) {
            sendMessage(ws, { type: "terminal_created", terminal });
          }
        }
        broadcastTerminalScopes(tm);
      });
      tm.on("terminal:removed", (terminalId) => {
        for (const [, subs] of terminalSubscriptions) {
          subs.delete(terminalId);
        }
        broadcast({ type: "terminal_removed", terminalId });
        broadcastTerminalScopes(tm);
      });
    }
    return tm;
  }

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    let connectionLabel = "open-mode";

    if (auth.authRequired) {
      const cookieHeader = req.headers.cookie;
      const session = auth.getSessionFromCookies(cookieHeader);

      if (!session) {
        log.info("WebSocket connection rejected: Unauthorized");
        ws.close(4001, "Unauthorized");
        return;
      }

      connectionLabel = `session ${truncateSessionId(session.id)}`;
      log.debug(`WebSocket connected: ${connectionLabel}`);
    } else {
      log.debug("WebSocket connected (open mode)");
    }

    // Initialize subscription tracking and heartbeat
    subscriptions.set(ws, new Set());
    terminalSubscriptions.set(ws, new Set());
    missedPongs.set(ws, 0);
    ws.on("pong", () => {
      missedPongs.set(ws, 0);
    });

    // Send connected + current state
    sendMessage(ws, { type: "connected" });
    sendMessage(ws, {
      type: "instance_list",
      instances: instanceManager.listInstances(),
    });
    sendMessage(ws, {
      type: "provider_global_state_list",
      states: instanceManager.listProviderGlobalState(),
    });
    void instanceManager.ensureProviderGlobalState("codex");
    void instanceManager.ensureProviderGlobalState("claude");
    sendMessage(ws, {
      type: "projects_changed",
      projects: instanceManager.projectManager.listProjects(),
    });
    if (instanceManager.scanComplete) {
      sendMessage(ws, { type: "scan_complete" });
    }
    // Seed the global live-terminal snapshot so sidebar indicators render
    // immediately, before this client opens any terminal scope.
    const tmForSnapshot = bindTerminalManager();
    if (tmForSnapshot) {
      sendMessage(ws, { type: "terminal_scopes", scopes: tmForSnapshot.listActiveScopes() });
    }

    ws.on("message", async (data: Buffer | string) => {
      try {
        const rawMessage = typeof data === "string" ? data : data.toString();
        const message = JSON.parse(rawMessage) as ClientMessage;

        switch (message.type) {
          case "list_instances":
            sendMessage(ws, {
              type: "instance_list",
              instances: instanceManager.listInstances(),
            });
            break;

          case "create_instance": {
            try {
              // createInstance() emits "instance:created" which the event
              // listener above broadcasts to all clients — no manual broadcast needed.
              instanceManager.createInstance({
                provider: message.provider,
                name: message.name,
                workingDirectory: message.workingDirectory,
                runtimeMode: message.runtimeMode,
                resumeSessionId: message.resumeSessionId,
                model: message.model,
                spaceId: message.spaceId,
                modelOptions: message.modelOptions,
                parentSessionId: message.parentSessionId,
                review: message.review,
              });
            } catch (err) {
              if (err instanceof MaxProcessesError) {
                // Structured so the client can open the capacity dialog and
                // retry this exact create once the user frees a slot.
                sendMessage(ws, {
                  type: "error",
                  message: err.message,
                  code: "max_processes",
                  limit: err.limit,
                  createRequest: {
                    provider: message.provider,
                    name: message.name,
                    workingDirectory: message.workingDirectory,
                    runtimeMode: message.runtimeMode,
                    resumeSessionId: message.resumeSessionId,
                    model: message.model,
                    spaceId: message.spaceId,
                    modelOptions: message.modelOptions,
                    parentSessionId: message.parentSessionId,
                    review: message.review,
                  },
                });
              } else {
                sendMessage(ws, {
                  type: "error",
                  message: err instanceof Error ? err.message : "Failed to create instance",
                });
              }
            }
            break;
          }

          case "remove_instance": {
            const removed = instanceManager.removeInstance(message.instanceId);
            if (removed) {
              // Remove from all clients' subscriptions
              for (const [, subs] of subscriptions) {
                subs.delete(message.instanceId);
              }
              broadcast({ type: "instance_removed", instanceId: message.instanceId });
            } else {
              sendMessage(ws, {
                type: "error",
                message: `Instance ${message.instanceId} not found`,
              });
            }
            break;
          }

          case "purge_instance": {
            const removed = instanceManager.removeInstance(message.instanceId, { purge: true });
            if (removed) {
              for (const [, subs] of subscriptions) {
                subs.delete(message.instanceId);
              }
              broadcast({ type: "instance_removed", instanceId: message.instanceId });
            } else {
              sendMessage(ws, {
                type: "error",
                message: `Instance ${message.instanceId} not found`,
              });
            }
            break;
          }

          case "stop_instance": {
            // Frees a process slot without removing the chat. Status change is
            // broadcast via the instance:status listener (setStatus → "stopped").
            const stopped = instanceManager.stopInstance(message.instanceId);
            if (!stopped) {
              sendMessage(ws, {
                type: "error",
                message: `Could not stop ${message.instanceId}`,
              });
            }
            break;
          }

          case "subscribe": {
            const subs = subscriptions.get(ws);
            if (subs) {
              subs.add(message.instanceId);
            }
            const subscribeStartedAt = Date.now();
            try {
              const replay = getReplayDelta(
                message.instanceId,
                message.lastSeenSequence,
                message.replayEpoch,
              );
              const replayReasonCount = noteReplayReason(replay.reason);
              if (replay.replayMode === "delta") {
                const historyMessage: ServerMessage = {
                  type: "instance_history",
                  instanceId: message.instanceId,
                  history: [],
                  replayMode: "delta",
                  latestSequence: replay.latestSequence,
                  replayEpoch,
                };
                sendMessage(ws, historyMessage);
                for (const event of replay.events) {
                  sendMessage(ws, event);
                }
                log.debug(
                  `[WebSocket] subscribe ${message.instanceId}: delta replay (${replay.events.length} events, latest seq ${replay.latestSequence}, reason count ${replayReasonCount}) in ${Date.now() - subscribeStartedAt}ms`,
                );
              } else {
                const history = instanceManager.getHistory(message.instanceId);
                const historyMessage: ServerMessage = {
                  type: "instance_history",
                  instanceId: message.instanceId,
                  history,
                  replayMode: "full",
                  latestSequence: replay.latestSequence,
                  replayEpoch,
                };
                sendMessage(ws, historyMessage);
                const baseMessage = `[WebSocket] subscribe ${message.instanceId}: full replay (${history.length} entries, reason ${replay.reason}, reason count ${replayReasonCount}) in ${Date.now() - subscribeStartedAt}ms`;
                if (replay.reason === "buffer_miss") {
                  log.warn(
                    `${baseMessage}. Frequent buffer_miss events suggest reconnect deltas are outgrowing MAX_REPLAY_EVENTS=${MAX_REPLAY_EVENTS}; consider revisiting that limit.`,
                  );
                } else {
                  log.debug(baseMessage);
                }
              }
              // After a full replay, re-emit any queued messages so the client can
              // display them even after a reconnect. For delta replays, the queued
              // messages are already in the replay buffer events, so skip to avoid dupes.
              if (replay.replayMode === "full") {
                const queuedMessages = instanceManager.getPendingQueuedMessages(message.instanceId);
                for (const qm of queuedMessages) {
                  sendMessage(ws, qm);
                }
              }
              // Always send the current authoritative status on (re)subscribe.
              // On reconnect the client's per-chat processing flag is otherwise
              // only cleared by a turn-end event in the replay — which can be
              // missed on flaky mobile links, wedging the chat in "Working...".
              // This lets the client reconcile against the real status.
              const subscribedInstance = instanceManager.getInstance(message.instanceId);
              if (subscribedInstance) {
                sendMessage(ws, {
                  type: "instance_status",
                  instanceId: message.instanceId,
                  instance: subscribedInstance,
                });
              }
            } catch {
              sendMessage(ws, {
                type: "error",
                message: `Instance ${message.instanceId} not found`,
              });
            }
            break;
          }

          case "unsubscribe": {
            const unsubs = subscriptions.get(ws);
            if (unsubs) {
              unsubs.delete(message.instanceId);
            }
            break;
          }

          case "instance_message": {
            const hasText = typeof message.text === "string" && message.text.trim();
            const hasImages = Array.isArray(message.images) && message.images.length > 0;
            const hasAttachments =
              Array.isArray(message.attachments) && message.attachments.length > 0;
            if (hasText || hasImages || hasAttachments) {
              try {
                // sendMessage emits instance:user which is forwarded to
                // subscribers — no separate echo needed (avoids duplicates
                // when the JSONL watcher also picks up the same message).
                const resumed = await instanceManager.sendMessage(
                  message.instanceId,
                  message.text || "",
                  hasImages ? message.images : undefined,
                  message.internal,
                  hasAttachments ? message.attachments : undefined,
                );
                // If sendMessage triggered a transparent resume, broadcast the transition
                if (resumed) {
                  broadcast({ type: "instance_status", instanceId: resumed.id, instance: resumed });
                }
              } catch (err) {
                sendMessage(ws, {
                  type: "error",
                  message: err instanceof Error ? err.message : "Failed to send message",
                  instanceId: message.instanceId,
                });
              }
            }
            break;
          }

          case "instance_takeover": {
            try {
              const resumed = await instanceManager.takeoverInstance(message.instanceId);
              if (resumed) {
                broadcast({ type: "instance_status", instanceId: resumed.id, instance: resumed });
              }
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to take over session",
                instanceId: message.instanceId,
              });
            }
            break;
          }

          case "instance_cancel": {
            try {
              await instanceManager.cancelMessage(message.instanceId);
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to cancel",
                instanceId: message.instanceId,
              });
            }
            break;
          }

          case "instance_interrupt_and_send": {
            try {
              await instanceManager.interruptAndSend(message.instanceId);
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to interrupt and send",
                instanceId: message.instanceId,
              });
            }
            break;
          }

          case "remove_queued_message": {
            try {
              await instanceManager.removeQueuedMessage(message.instanceId, message.queuedId);
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to remove queued message",
                instanceId: message.instanceId,
              });
            }
            break;
          }

          case "respond_to_request": {
            try {
              await instanceManager.respondToRequest(
                message.instanceId,
                message.requestId,
                message.decision,
                {
                  answers: message.answers,
                  text: message.text,
                },
              );
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to resolve request",
                instanceId: message.instanceId,
              });
            }
            break;
          }

          case "rename_instance": {
            await instanceManager.renameInstance(message.instanceId, message.name);
            break;
          }

          case "rename_space": {
            try {
              instanceManager.getSpaceManager().renameSpace(message.spaceId, message.name);
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to rename space",
              });
            }
            break;
          }

          case "set_model": {
            await instanceManager.setModel(message.instanceId, message.model);
            break;
          }

          case "set_model_options": {
            await instanceManager.setModelOptions(message.instanceId, message.modelOptions);
            break;
          }

          case "set_runtime_mode": {
            await instanceManager.setRuntimeMode(message.instanceId, message.mode);
            break;
          }

          case "set_provider": {
            await instanceManager.setProvider(message.instanceId, message.provider);
            break;
          }

          case "set_review_instance": {
            await instanceManager.setReviewInstance(message.instanceId, message.reviewInstanceId);
            break;
          }

          case "create_space": {
            try {
              // Resolve effective base branch using project settings
              let effectiveBranch: string | undefined = message.baseBranch;
              const project = instanceManager.projectManager.getProjectByDirectory(
                message.projectDirectory,
              );
              if (!effectiveBranch && project?.defaultSpaceBranch) {
                effectiveBranch = project.defaultSpaceBranch;
              }
              // Fall back to global defaults if no project-level branch configured
              const globalSettings = instanceManager.sessionDb.getGlobalSettings();
              if (!effectiveBranch && globalSettings.default_space_branch) {
                effectiveBranch = globalSettings.default_space_branch;
              }
              const branchSource = project?.spaceBranchSource ?? globalSettings.space_branch_source;
              if (effectiveBranch && branchSource === "remote" && project?.repoRoot) {
                const remote = await getPrimaryRemote(project.repoRoot);
                if (remote && !effectiveBranch.includes("/")) {
                  effectiveBranch = `${remote}/${effectiveBranch}`;
                }
              }
              await instanceManager.getSpaceManager().createSpace(message.projectDirectory, {
                name: message.name,
                baseBranch: effectiveBranch,
              });
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to create space",
              });
            }
            break;
          }

          case "complete_space": {
            try {
              const { targetBranch } = await instanceManager
                .getSpaceManager()
                .completeSpace(message.spaceId, {
                  mergeMethod: message.mergeMethod,
                  squashMessage: message.squashMessage,
                });
              sendMessage(ws, {
                type: "notification",
                message: `Space merged into ${targetBranch} successfully`,
              });
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to complete space",
              });
            }
            break;
          }

          case "mark_space_merged": {
            try {
              const { targetBranch } = await instanceManager
                .getSpaceManager()
                .markSpaceMerged(message.spaceId);
              sendMessage(ws, {
                type: "notification",
                message: `Space marked as merged into ${targetBranch}`,
              });
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to mark space as merged",
              });
            }
            break;
          }

          case "delete_space": {
            try {
              await instanceManager.getSpaceManager().deleteSpace(message.spaceId);
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to delete space",
              });
            }
            break;
          }
          case "merge_instance": {
            try {
              const { targetBranch } = await instanceManager.mergeInstance(message.instanceId);
              // Clean up subscriptions (instance is removed)
              for (const [, subs] of subscriptions) {
                subs.delete(message.instanceId);
              }
              broadcast({ type: "instance_removed", instanceId: message.instanceId });
              sendMessage(ws, {
                type: "notification",
                message: `Merged into ${targetBranch} successfully`,
                instanceId: message.instanceId,
              });
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to merge",
                instanceId: message.instanceId,
              });
            }
            break;
          }

          // ── Terminal messages ──────────────────────────────────────
          case "terminal_create": {
            const tm = bindTerminalManager();
            if (!tm) {
              sendMessage(ws, { type: "error", message: "Terminal support is not available" });
              break;
            }
            try {
              if (!canAccessTerminalScope(ws, message.scope)) {
                sendMessage(ws, { type: "error", message: "Unauthorized terminal access" });
                break;
              }
              let cwd = message.cwd;
              if (!cwd) {
                const scope = message.scope;
                if (scope.type === "space") {
                  cwd = instanceManager.getSpaceManager().getSpaceWorkingDirectory(scope.spaceId);
                  if (!cwd) {
                    sendMessage(ws, {
                      type: "error",
                      message: `Space ${scope.spaceId} not found or has no working directory`,
                    });
                    break;
                  }
                } else {
                  // Instance-scoped: use the instance's working directory
                  const inst = instanceManager
                    .listInstances()
                    .find((i) => i.id === scope.instanceId);
                  cwd = inst?.workingDirectory;
                  if (!cwd) {
                    sendMessage(ws, {
                      type: "error",
                      message: `Instance ${scope.instanceId} not found or has no working directory`,
                    });
                    break;
                  }
                }
              }
              // If ifEmpty is set, skip creation when terminals already exist for this scope
              if (message.ifEmpty && tm.listTerminals(message.scope).length > 0) {
                break;
              }
              const terminal = tm.createTerminal({
                scope: message.scope,
                cwd,
                cols: message.cols,
                rows: message.rows,
              });
              // Auto-subscribe the creator
              const tsubs = terminalSubscriptions.get(ws);
              if (tsubs) tsubs.add(terminal.id);
            } catch (err) {
              sendMessage(ws, {
                type: "error",
                message: err instanceof Error ? err.message : "Failed to create terminal",
              });
            }
            break;
          }

          case "terminal_input": {
            const tm = bindTerminalManager();
            if (tm && getAuthorizedTerminal(ws, tm, message.terminalId)) {
              tm.writeTerminal(message.terminalId, message.data);
            }
            break;
          }

          case "terminal_resize": {
            const tm = bindTerminalManager();
            if (tm && getAuthorizedTerminal(ws, tm, message.terminalId)) {
              tm.resizeTerminal(message.terminalId, message.cols, message.rows);
            }
            break;
          }

          case "terminal_close": {
            const tm = bindTerminalManager();
            if (tm) {
              // Silently ignore if terminal is already gone — the client may
              // race with a server-side terminal_removed broadcast.
              const terminal = tm.getTerminal(message.terminalId);
              if (terminal && canAccessTerminalScope(ws, terminal.scope)) {
                tm.closeTerminal(message.terminalId);
              }
            }
            break;
          }

          case "terminal_subscribe": {
            const tm = bindTerminalManager();
            if (tm) {
              if (!getAuthorizedTerminal(ws, tm, message.terminalId)) {
                break;
              }
              const tsubs = terminalSubscriptions.get(ws);
              if (tsubs) {
                tsubs.add(message.terminalId);
              }
              // Send scrollback for reconnect
              const scrollback = tm.getScrollback(message.terminalId);
              if (scrollback) {
                sendMessage(ws, {
                  type: "terminal_scrollback",
                  terminalId: message.terminalId,
                  data: scrollback,
                });
              }
            }
            break;
          }

          case "terminal_unsubscribe": {
            const tunsubs = terminalSubscriptions.get(ws);
            if (tunsubs) {
              tunsubs.delete(message.terminalId);
            }
            break;
          }

          case "repo_status_subscribe": {
            if (isRepoStatusTarget(message.target)) subscribeRepoStatus(ws, message.target);
            break;
          }

          case "repo_status_unsubscribe": {
            if (isRepoStatusTarget(message.target)) unsubscribeRepoStatus(ws, message.target);
            break;
          }

          case "terminal_list": {
            const tm = bindTerminalManager();
            if (!canAccessTerminalScope(ws, message.scope)) {
              sendMessage(ws, { type: "error", message: "Unauthorized terminal access" });
              break;
            }
            if (tm) {
              sendMessage(ws, {
                type: "terminal_list_response",
                scope: message.scope,
                terminals: tm.listTerminals(message.scope),
              });
            } else {
              sendMessage(ws, {
                type: "terminal_list_response",
                scope: message.scope,
                terminals: [],
              });
            }
            break;
          }

          default:
            log.warn("Unknown message type:", (message as { type: string }).type);
        }
      } catch (error) {
        log.error("Failed to parse WebSocket message:", error);
      }
    });

    ws.on("error", (error) => {
      log.error(`WebSocket error for ${connectionLabel}:`, error);
    });

    ws.on("close", () => {
      log.debug(`WebSocket disconnected: ${connectionLabel}`);
      subscriptions.delete(ws);
      terminalSubscriptions.delete(ws);
      clearRepoStatusSubscriptions(ws);
      missedPongs.delete(ws);
    });
  });

  return {
    wss,
    getConnectionCount(): number {
      return subscriptions.size;
    },
  };
}
