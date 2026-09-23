import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { BranchChangeBanner } from "@/components/chat/branch-change-banner";
import { ConnectionStatusBanner } from "@/components/chat/connection-status-banner";
import { ChatDebug } from "@/components/chat/chat-debug";
import { ExternalSessionBar } from "@/components/chat/external-session-bar";
import { InputArea } from "@/components/chat/input-area";
import type { OutboxAttachment } from "@/lib/outbox-store";
import { MessageList } from "@/components/chat/message-list";
import {
  MessageRelayProvider,
  type InlineReplyFragment,
  type SpinOffRequest,
} from "@/components/chat/message-relay-context";
import { PermissionBanner } from "@/components/chat/permission-banner";
import { SuggestionCards } from "@/components/chat/suggestion-cards";
import { TerminalPermissionBar } from "@/components/chat/terminal-permission-bar";
import { TerminalInputBanner } from "@/components/chat/terminal-input-banner";
import { TerminalContextStrip } from "@/components/terminal/terminal-context-strip";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { CheckboxField } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { Textarea } from "@/components/ui/input";
import { RelayLogo } from "@/components/ui/relay-logo";
import { useInstanceViewContext } from "@/components/chat/instance-view-context";
import { useWSMethods, useWSState } from "@/context/websocket-context";
import { useProviderRuntimeStore } from "@/stores/provider-runtime-store";
import { createSpinOff, createInstance, markSpinOffSent } from "@/lib/api";
import { reportCreateInstanceError } from "@/stores/process-limit-store";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { getProjectName } from "@/lib/project-route";
import { buildReviewSendBackMessage, getReviewSourceInstance } from "@/lib/review-session";
import { ArrowRightFromLine, X } from "lucide-react";
import type { SpinOffPacket } from "@shared/types";
import { fetchProjectSuggestions, fetchInstanceGitStatus } from "@/lib/api";
import type { SuggestionCondition } from "@shared/types";

const MotionLogo = motion.create(RelayLogo);

// ---------------------------------------------------------------------------
// Spin-off draft metadata — stored alongside the composer draft so the source
// info can be rendered as a styled bar rather than inline bracket text.
// ---------------------------------------------------------------------------

const SPIN_OFF_META_PREFIX = "relay:spin-off-meta:";
const LEGACY_HANDOFF_META_PREFIX = "relay:handoff-meta:";
const DRAFT_PREFIX = "relay:draft:";

interface SpinOffMeta {
  sourceName: string;
  spinOffId: string;
}

interface SpinOffDraftEdits {
  currentState: string;
}

interface SpinOffDialogState {
  anchorIndex?: number;
  selectedText?: string;
}

function nextInlineReplyId(): string {
  return `inline-reply-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

const INLINE_REPLIES_PREFIX = "relay:inline-replies:";

function loadInlineReplyFragments(instanceId: string): InlineReplyFragment[] {
  try {
    const raw = sessionStorage.getItem(`${INLINE_REPLIES_PREFIX}${instanceId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveInlineReplyFragments(instanceId: string, fragments: InlineReplyFragment[]): void {
  try {
    if (fragments.length > 0) {
      sessionStorage.setItem(`${INLINE_REPLIES_PREFIX}${instanceId}`, JSON.stringify(fragments));
    } else {
      sessionStorage.removeItem(`${INLINE_REPLIES_PREFIX}${instanceId}`);
    }
  } catch {
    // sessionStorage full or unavailable
  }
}

function clearInlineReplyFragments(instanceId: string): void {
  try {
    sessionStorage.removeItem(`${INLINE_REPLIES_PREFIX}${instanceId}`);
  } catch {
    // ignore
  }
}

function storeSpinOffMeta(instanceId: string, meta: SpinOffMeta): void {
  try {
    sessionStorage.setItem(`${SPIN_OFF_META_PREFIX}${instanceId}`, JSON.stringify(meta));
  } catch {
    // ignore
  }
}

function loadSpinOffMeta(instanceId: string): SpinOffMeta | null {
  try {
    const raw =
      sessionStorage.getItem(`${SPIN_OFF_META_PREFIX}${instanceId}`) ??
      sessionStorage.getItem(`${LEGACY_HANDOFF_META_PREFIX}${instanceId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSpinOffMeta(instanceId: string): void {
  try {
    sessionStorage.removeItem(`${SPIN_OFF_META_PREFIX}${instanceId}`);
    sessionStorage.removeItem(`${LEGACY_HANDOFF_META_PREFIX}${instanceId}`);
  } catch {
    // ignore
  }
}

function hasStoredDraft(instanceId: string): boolean {
  try {
    return !!(
      window.localStorage.getItem(`${DRAFT_PREFIX}${instanceId}`) ??
      sessionStorage.getItem(`${DRAFT_PREFIX}${instanceId}`)
    )?.trim();
  } catch {
    return false;
  }
}

function cleanSection(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatQuotedSelection(value: string): string {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function renderPacketFromEdits(
  sourceName: string,
  basePacket: SpinOffPacket,
  edits: SpinOffDraftEdits,
  selectedText?: string,
  includeTouchedFiles?: boolean,
): string {
  const packet = {
    ...basePacket,
    currentState: cleanSection(edits.currentState) ?? basePacket.currentState,
  };

  const sections: string[] = [`[Spun off from: ${sourceName}]`, ""];
  if (cleanSection(selectedText)) {
    sections.push(`## Selected text\n${formatQuotedSelection(cleanSection(selectedText)!)}`);
  }
  if (packet.currentState) sections.push(`## Context\n${packet.currentState}`);
  if (includeTouchedFiles && packet.touchedFiles) {
    sections.push(`## Touched files\n${packet.touchedFiles}`);
  }
  return sections.join("\n\n");
}

/** Strip the visible source prefix from rendered spin-off text. */
function stripSpinOffPrefix(text: string): string {
  return text.replace(/^\[(?:Handoff|Spun off) from:\s+.+?\]\s*\n*/, "");
}

function SpinOffSourceBar({ meta, onClear }: { meta: SpinOffMeta | null; onClear: () => void }) {
  if (!meta) return null;

  return (
    <div className="flex items-center gap-2 border-b border-accent/20 bg-accent/5 px-3 py-1.5">
      <ArrowRightFromLine size={12} className="shrink-0 text-accent" />
      <span className="flex-1 truncate text-[0.75rem] text-accent">
        Spun off from <span className="font-medium">{meta.sourceName}</span>
      </span>
      <button
        onClick={() => {
          onClear();
        }}
        className="rounded p-0.5 text-muted transition-colors hover:bg-surface-hover hover:text-text"
        title="Remove source attribution"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ReviewSourceBar({
  sourceName,
  scope,
  fileCount,
}: {
  sourceName: string;
  scope: "session-files" | "branch";
  fileCount: number;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-warning/20 bg-warning/5 px-3 py-1.5">
      <ArrowRightFromLine size={12} className="shrink-0 text-warning" />
      <span className="flex-1 truncate text-[0.75rem] text-warning">
        Reviewing{" "}
        {scope === "session-files"
          ? `${fileCount} touched file${fileCount === 1 ? "" : "s"}`
          : "whole branch/worktree"}{" "}
        from {sourceName}
      </span>
    </div>
  );
}

function EmptyChatState({ projectName }: { projectName: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 max-[768px]:py-6">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <RelayLogo size={64} animated className="mb-5 opacity-80 max-[768px]:mb-3" />
        <p className="text-[0.875rem] font-medium text-text-bright">Ready when you are</p>
        <p className="mt-1 hidden text-[0.75rem] text-muted sm:block">
          Start a conversation in <span className="text-text">{projectName}</span>. Use{" "}
          <kbd className="rounded bg-surface-hover px-1 py-px text-[0.6875rem] text-text">@</kbd> to
          attach files or{" "}
          <kbd className="rounded bg-surface-hover px-1 py-px text-[0.6875rem] text-text">/</kbd>{" "}
          for commands.
        </p>
        <p className="mt-1 text-[0.75rem] text-muted sm:hidden">
          Start a conversation in <span className="text-text">{projectName}</span>
        </p>
      </div>
    </div>
  );
}

function SpinOffPrepDialog({
  open,
  onOpenChange,
  edits,
  onChange,
  onConfirm,
  isSubmitting,
  selectedText,
  includeTouchedFiles,
  onIncludeTouchedFilesChange,
  canIncludeTouchedFiles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edits: SpinOffDraftEdits;
  onChange: (next: SpinOffDraftEdits) => void;
  onConfirm: () => void;
  isSubmitting: boolean;
  selectedText?: string;
  includeTouchedFiles: boolean;
  onIncludeTouchedFilesChange: (checked: boolean) => void;
  canIncludeTouchedFiles: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open && (
        <Dialog.Content maxWidth="max-w-lg">
          <Dialog.Header>
            <Dialog.Title>Spin off to new chat</Dialog.Title>
            <Dialog.Close />
          </Dialog.Header>
          <div className="space-y-4 overflow-y-auto">
            <p className="text-sm text-muted">Add any extra context worth carrying over.</p>
            {selectedText && (
              <div className="space-y-1.5">
                <p className="text-[0.75rem] font-medium text-muted">Selected text</p>
                <div className="rounded-md border border-border bg-surface-hover px-3 py-2 text-[0.8125rem] leading-relaxed text-text">
                  <span className="line-clamp-5 whitespace-pre-wrap">
                    &ldquo;{selectedText}&rdquo;
                  </span>
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-[0.75rem] font-medium text-muted" htmlFor="spin-off-state">
                Context
              </label>
              <Textarea
                id="spin-off-state"
                autoFocus
                rows={4}
                placeholder="What should the new chat know before it starts?"
                value={edits.currentState}
                onChange={(e) => onChange({ ...edits, currentState: e.target.value })}
              />
            </div>
            {canIncludeTouchedFiles && (
              <CheckboxField
                id="spin-off-include-files"
                checked={includeTouchedFiles}
                onCheckedChange={onIncludeTouchedFilesChange}
                label="Include related files from this chat?"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => onOpenChange(false)}
                className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={isSubmitting}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Preparing..." : "Create draft"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      )}
    </Dialog.Root>
  );
}

export function InstanceViewContent() {
  const { shared, actions } = useInstanceViewContext();
  const { instances: allInstances } = useWSState();
  const providerGlobalState = useProviderRuntimeStore((s) => s.providerGlobalState);
  const { send, reconnectNow } = useWSMethods();
  const navigate = useNavigate();
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);

  const spaceId = shared.instance.spaceId;
  const instanceId = shared.id;
  const projectId = shared.instance.projectId;
  const workingDirectory = shared.instance.workingDirectory;
  const canIncludeTouchedFiles = !!shared.currentFiles?.length;
  // Whether the composer currently has any non-empty content. Used to dim
  // (not hide) the suggestion cards while a draft is being composed. The
  // empty state / suggestion visibility is gated purely on "has this chat
  // received a message yet" — see `hasMessagesSent` below.
  const [composerHasContent, setComposerHasContent] = useState(() => hasStoredDraft(shared.id));
  const [spinOffMeta, setSpinOffMeta] = useState<SpinOffMeta | null>(() =>
    loadSpinOffMeta(shared.id),
  );
  const [spinOffDialogOpen, setSpinOffDialogOpen] = useState(false);
  const [spinOffSubmitting, setSpinOffSubmitting] = useState(false);
  const [spinOffDialogState, setSpinOffDialogState] = useState<SpinOffDialogState | null>(null);
  const [spinOffIncludeTouchedFiles, setSpinOffIncludeTouchedFiles] = useState(false);
  const [spinOffEdits, setSpinOffEdits] = useState<SpinOffDraftEdits>({
    currentState: "",
  });
  const [inlineReplyFragments, setInlineReplyFragments] = useState<InlineReplyFragment[]>(() =>
    loadInlineReplyFragments(shared.id),
  );
  const reviewSource = shared.instance.review
    ? getReviewSourceInstance(shared.instance, allInstances)
    : null;
  const isReviewMode = !!shared.instance.review || !!shared.embeddedSourceChat;

  useEffect(() => {
    setSpinOffMeta(loadSpinOffMeta(shared.id));
    setInlineReplyFragments(loadInlineReplyFragments(shared.id));
    setComposerHasContent(hasStoredDraft(shared.id));
  }, [shared.id]);

  // Prepend source attribution when a spun-off draft is sent for the first time.
  const handleSendWithSpinOff = useCallback(
    (text: string, images?: string[], internal?: boolean, attachments?: string[]) => {
      const meta = spinOffMeta;
      const attributed = meta ? `[Spun off from: ${meta.sourceName}]\n\n${text}` : text;
      const sent = actions.handleSend(attributed, images, internal, attachments);
      if (meta && sent) {
        clearSpinOffMeta(instanceId);
        setSpinOffMeta(null);
      }
      return sent;
    },
    [instanceId, actions, spinOffMeta],
  );

  // Wrap send to clear inline reply fragments after sending.
  const handleSendWithContext = useCallback(
    (text: string, images?: string[], internal?: boolean, attachments?: string[]) => {
      const sent = handleSendWithSpinOff(text, images, internal, attachments);
      if (sent && inlineReplyFragments.length > 0) {
        setInlineReplyFragments([]);
        clearInlineReplyFragments(instanceId);
      }
      return sent;
    },
    [instanceId, inlineReplyFragments, handleSendWithSpinOff],
  );

  const handleQueueWithContext = useCallback(
    async (text: string, attachments: OutboxAttachment[]) => {
      const attributed = spinOffMeta
        ? `[Spun off from: ${spinOffMeta.sourceName}]\n\n${text}`
        : text;
      await actions.handleQueue(attributed, attachments);
      if (spinOffMeta) {
        clearSpinOffMeta(instanceId);
        setSpinOffMeta(null);
      }
      if (inlineReplyFragments.length > 0) {
        setInlineReplyFragments([]);
        clearInlineReplyFragments(instanceId);
      }
    },
    [actions, spinOffMeta, instanceId, inlineReplyFragments],
  );

  const handleRemoveInlineReply = useCallback(
    (id: string) => {
      setInlineReplyFragments((prev) => {
        const next = prev.filter((f) => f.id !== id);
        saveInlineReplyFragments(instanceId, next);
        return next;
      });
    },
    [instanceId],
  );

  const handleSpinOff = useCallback(async () => {
    const anchorIndex = spinOffDialogState?.anchorIndex;
    const selectedText = spinOffDialogState?.selectedText;
    setSpinOffSubmitting(true);
    try {
      const draft = await createSpinOff(instanceId, anchorIndex);
      const sourceName = draft.sourceChatName || "Unknown";
      const mergedText = renderPacketFromEdits(
        sourceName,
        draft.packet,
        spinOffEdits,
        selectedText,
        spinOffIncludeTouchedFiles,
      );
      const draftBody = stripSpinOffPrefix(mergedText);

      if (spaceId) {
        // Space chat: dispatch event so the space view creates a tab
        window.dispatchEvent(
          new CustomEvent("relay:send-to-new-chat", {
            detail: {
              spaceId,
              message: draftBody,
              spinOffId: draft.id,
              spinOffSourceName: sourceName,
            },
          }),
        );
      } else {
        // Standalone chat: create a new instance, prefill draft, navigate
        const created = await createInstance({ workingDirectory });
        // Store source metadata for the styled bar
        storeSpinOffMeta(created.id, { sourceName, spinOffId: draft.id });
        // Seed the composer draft so the user can review/edit before sending
        try {
          sessionStorage.setItem(`relay:draft:${created.id}`, draftBody);
        } catch {
          // sessionStorage unavailable — fall back to sending directly
          send({
            type: "instance_message",
            instanceId: created.id,
            text: mergedText,
          });
        }
        markSpinOffSent(draft.id, created.id).catch(() => {
          // Non-fatal — packet was already delivered as a message
        });
        if (projectId) {
          void navigate({
            to: "/projects/$projectId/chats/$chatId",
            params: { projectId, chatId: created.id },
          });
        }
      }
      setSpinOffDialogOpen(false);
      setSpinOffDialogState(null);
      setSpinOffIncludeTouchedFiles(false);
      setSpinOffEdits({ currentState: "" });
      toast.success("Spin-off draft ready");
    } catch (err) {
      if (!reportCreateInstanceError(err)) {
        toast.error(err instanceof Error ? err.message : "Failed to create spin-off");
      }
    } finally {
      setSpinOffSubmitting(false);
    }
  }, [
    instanceId,
    navigate,
    projectId,
    send,
    spaceId,
    spinOffDialogState,
    spinOffEdits,
    spinOffIncludeTouchedFiles,
    workingDirectory,
  ]);

  // Fetch resolved suggestions for this project
  const { data: resolvedSuggestions } = useQuery({
    queryKey: ["project-suggestions", projectId],
    queryFn: () => (projectId ? fetchProjectSuggestions(projectId) : Promise.resolve([])),
    staleTime: 60_000,
    enabled: !!projectId,
  });

  // "Fresh chat" = nothing sent yet. Empty state and suggestions stay up until
  // a message lands, regardless of whether there's a pending draft.
  const hasMessagesSent = shared.items.length > 0;
  const isFreshChat = !hasMessagesSent && !shared.isActive && !shared.instance.external;

  // Does any resolved suggestion actually depend on git state? Avoid a pointless
  // git call when none do (e.g. user disabled review-changes/write-tests globally).
  const needsGitStatus = !!resolvedSuggestions?.some((s) =>
    s.conditions?.some((c) => c === "has-changes" || c === "has-reviewable-diff"),
  );

  // Per-instance dirty check — a space chat's worktree may differ from the project
  // root, so project-level branch data would give the wrong answer here.
  const { data: instanceGitStatus } = useQuery({
    queryKey: ["instance-git-status", instanceId],
    queryFn: () => fetchInstanceGitStatus(instanceId),
    staleTime: 15_000,
    enabled: isFreshChat && needsGitStatus,
  });

  // Filter suggestions by conditions the client can evaluate
  const isInSpace = !!spaceId && allInstances.filter((i) => i.spaceId === spaceId).length > 1;
  const hasChanges = instanceGitStatus?.dirty ?? false;
  // Fall back to `dirty` if server didn't populate `reviewableDiff` (older builds).
  const hasReviewableDiff = instanceGitStatus?.reviewableDiff ?? instanceGitStatus?.dirty ?? false;

  const filteredSuggestions = useMemo(() => {
    if (!resolvedSuggestions) return undefined;

    // Client-evaluated conditions only; server-evaluated ones (e.g. has-tasks)
    // are pre-filtered before reaching the client.
    const conditionState: Partial<Record<SuggestionCondition, boolean>> = {
      "has-changes": hasChanges,
      "has-reviewable-diff": hasReviewableDiff,
      "in-space": isInSpace,
    };

    return resolvedSuggestions.filter((s) => {
      if (!s.conditions?.length) return true;
      return s.conditions.every((c) => conditionState[c] ?? true);
    });
  }, [resolvedSuggestions, hasChanges, hasReviewableDiff, isInSpace]);

  const clearPendingDraft = useCallback(() => setPendingDraft(null), []);

  const relayValue = useMemo(() => {
    const embeddedSourceChat = shared.embeddedSourceChat;
    const relaySource =
      embeddedSourceChat ??
      (reviewSource ? { id: reviewSource.id, name: reviewSource.name } : undefined);
    const siblings =
      isReviewMode || embeddedSourceChat
        ? []
        : spaceId
          ? allInstances
              .filter((inst) => inst.spaceId === spaceId && inst.id !== instanceId)
              .map((inst) => ({ id: inst.id, name: inst.name, status: inst.status }))
          : [];

    return {
      siblings,
      instanceId,
      onSendToChat: (targetId: string, messageText: string) => {
        const sourceChat = allInstances.find((inst) => inst.id === instanceId);
        const sourceName = sourceChat?.name || "Unknown";
        const attributed = `[From: ${sourceName}] ${messageText}`;
        send({ type: "instance_message", instanceId: targetId, text: attributed });
      },
      onSendToNewChat: (messageText: string) => {
        if (isReviewMode || embeddedSourceChat) return;
        const sourceChat = allInstances.find((inst) => inst.id === instanceId);
        const sourceName = sourceChat?.name || "Unknown";
        const attributed = `[From: ${sourceName}] ${messageText}`;
        if (spaceId) {
          window.dispatchEvent(
            new CustomEvent("relay:send-to-new-chat", {
              detail: { spaceId, message: attributed },
            }),
          );
        }
      },
      sourceChat: relaySource,
      onSendToSourceChat: relaySource
        ? (messageText: string) => {
            const attributed = buildReviewSendBackMessage({
              reviewName: shared.instance.name,
              sourceName: relaySource.name,
              message: messageText,
            });
            send({ type: "instance_message", instanceId: relaySource.id, text: attributed });
          }
        : undefined,
      allowSpinOff: !isReviewMode && !embeddedSourceChat,
      onSpinOff: (request?: SpinOffRequest) => {
        if (isReviewMode || embeddedSourceChat) return;
        setSpinOffDialogState(request ?? {});
        setSpinOffDialogOpen(true);
      },
      onInlineReply: (request: { anchorIndex?: number; selectedText: string; reply: string }) => {
        const fragment: InlineReplyFragment = {
          id: nextInlineReplyId(),
          selectedText: request.selectedText,
          reply: request.reply,
        };
        setInlineReplyFragments((prev) => {
          const next = [...prev, fragment];
          saveInlineReplyFragments(instanceId, next);
          return next;
        });
      },
    };
  }, [
    spaceId,
    instanceId,
    allInstances,
    isReviewMode,
    reviewSource,
    send,
    shared.instance.name,
    shared.embeddedSourceChat,
  ]);

  const loadingContent = (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-md flex-col items-center px-6 py-8 text-center">
        <MotionLogo
          size={112}
          connected={shared.isConnected}
          showPulseRings
          className="mb-5"
          initial={{ opacity: 0, scale: 0.82 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", duration: 0.9, bounce: 0.25 }}
        />
        <p className="text-[0.875rem] font-medium text-text-bright">Loading chat</p>
        <p className="mt-1 text-[0.75rem] text-muted">
          Replaying history and restoring live state for this chat.
        </p>
      </div>
    </div>
  );

  return (
    <>
      {shared.isLoadingSession || (!shared.hasLoadedHistory && shared.items.length === 0) ? (
        loadingContent
      ) : !hasMessagesSent && !shared.isActive && !shared.showThinkingIndicator ? (
        // Empty state + suggestions share one scrollable region so the composer
        // (shrink-0, below) always stays on screen even on short viewports.
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <EmptyChatState projectName={getProjectName(shared.instance.workingDirectory)} />
          {!shared.instance.external &&
            !isReviewMode &&
            filteredSuggestions &&
            filteredSuggestions.length > 0 && (
              <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-2 max-[768px]:px-3">
                <SuggestionCards
                  suggestions={filteredSuggestions}
                  onSelect={setPendingDraft}
                  settingsHref="/settings/suggestions"
                  dimmed={composerHasContent}
                />
              </div>
            )}
        </div>
      ) : (
        <ErrorBoundary name="Message list">
          <MaybeRelayProvider value={relayValue}>
            <MessageList
              key={shared.id}
              persistKey={shared.id}
              items={shared.items}
              searchFocus={shared.searchFocus}
              isProcessing={shared.isActive}
              showThinkingIndicator={shared.showThinkingIndicator}
              instanceStatus={shared.instance.status}
              lastActivity={shared.lastActivity}
              processingStartedAt={shared.processingStartedAt}
              onSendMessage={actions.handleSend}
              onAnswerUserInput={actions.handleAnswerUserInput}
              isInteractive={!shared.isStopped}
              onApproveTool={actions.handleApproveTool}
              approvedTools={shared.approvedTools}
              isExternal={!!shared.instance.sessionId}
              pendingInteraction={!!shared.instance.pendingPlan || !!shared.pendingUserInput}
              planChildId={shared.planChild?.id}
              planChildName={shared.planChild?.name}
              onInterruptAndSend={actions.handleInterruptAndSend}
              onEditQueued={actions.handleEditQueued}
              onRemoveQueued={actions.handleRemoveQueued}
              agents={shared.agents}
              agentItems={shared.agentItems}
              instanceId={shared.id}
              provider={shared.instance.provider}
              pendingRequest={shared.instance.pendingPermission ?? null}
            />
          </MaybeRelayProvider>
        </ErrorBoundary>
      )}

      {shared.showDebugPaste && (
        <ChatDebug
          instance={shared.instance}
          items={shared.items}
          rawHistory={shared.rawHistory}
          isProcessing={shared.isActive}
          providerGlobalState={providerGlobalState[shared.instance.provider]}
          onClose={() => actions.setShowDebugPaste(false)}
        />
      )}

      <ConfirmActionDialog
        open={shared.confirmDelete}
        onOpenChange={actions.setConfirmDelete}
        title="Delete chat?"
        description={
          <>
            <span className="font-medium text-text">{shared.instance.name}</span> will be
            permanently removed.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => {
          actions.sendRemoveInstance();
          actions.setConfirmDelete(false);
          actions.navigateAfterDelete();
        }}
      />

      {shared.isPendingApproval &&
        shared.pendingApprovalRequest &&
        !shared.instance.external &&
        !shared.instance.pendingPlan && (
          <PermissionBanner
            key={shared.pendingApprovalRequest.requestId}
            provider={shared.instance.provider}
            request={shared.pendingApprovalRequest}
            onRespond={actions.handleRespondToRequest}
          />
        )}

      {shared.pendingTerminalInput && !shared.pendingUserInput && !shared.instance.external && (
        <TerminalInputBanner
          provider={shared.instance.provider}
          request={shared.pendingTerminalInput}
          onRespond={actions.handleRespondToRequest}
        />
      )}

      {shared.pendingTerminalTool && !shared.pendingUserInput && !shared.pendingTerminalInput && (
        <TerminalPermissionBar
          provider={shared.instance.provider}
          pendingTool={shared.pendingTerminalTool}
        />
      )}

      {shared.connectionBanner && (
        <ConnectionStatusBanner
          kind={shared.connectionBanner.kind}
          onContinue={shared.connectionBanner.onContinue}
          onDismiss={shared.connectionBanner.onDismiss}
          onRetry={shared.connectionBanner.onRetry}
        />
      )}

      {!shared.isLoadingSession &&
        shared.showBranchChangeBanner &&
        shared.instance.branchChanged && (
          <BranchChangeBanner
            originalBranch={shared.instance.branchChanged.originalBranch}
            currentBranch={shared.instance.branchChanged.currentBranch}
            onDismiss={actions.dismissBranchChangeBanner}
          />
        )}

      {!shared.isLoadingSession &&
        (shared.instance.external ? (
          <ExternalSessionBar
            isStopped={shared.isStopped}
            isConnected={shared.isConnected}
            onTakeover={actions.handleTakeover}
            provider={shared.instance.provider}
            model={shared.instance.stats?.model}
          />
        ) : (
          <ErrorBoundary name="Input area" inline>
            <InputArea
              onSend={handleSendWithContext}
              onQueue={handleQueueWithContext}
              onAnswerUserInput={actions.handleAnswerUserInput}
              onCancel={actions.handleCancel}
              onSwitchProvider={actions.handleSwitchProvider}
              isProcessing={shared.isActive}
              isConnected={shared.isConnected}
              onReconnect={reconnectNow}
              instanceId={shared.id}
              projectId={shared.instance.projectId}
              spaceId={shared.instance.spaceId}
              isStopped={shared.isStopped}
              provider={shared.instance.provider}
              preferredModel={shared.instance.preferredModel}
              modelOptions={shared.instance.modelOptions}
              runtimeMode={shared.instance.runtimeMode}
              hasMessages={shared.items.length > 0}
              pendingUserInput={shared.pendingUserInput}
              pendingPlan={shared.instance.pendingPlan}
              providerStatus={shared.instance.providerStatus}
              inlineReplyFragments={inlineReplyFragments}
              onRemoveInlineReply={handleRemoveInlineReply}
              pendingDraft={pendingDraft}
              onPendingDraftApplied={clearPendingDraft}
              queuedRestore={shared.queuedRestore}
              onQueuedRestoreApplied={actions.clearQueuedRestore}
              onDraftChange={setComposerHasContent}
              mode={isReviewMode ? "review" : "default"}
              topSlot={
                <>
                  {shared.instance.review ? (
                    <ReviewSourceBar
                      sourceName={shared.instance.review.sourceName}
                      scope={shared.instance.review.scope}
                      fileCount={shared.instance.review.filePaths?.length ?? 0}
                    />
                  ) : null}
                  <SpinOffSourceBar
                    meta={spinOffMeta}
                    onClear={() => {
                      clearSpinOffMeta(shared.id);
                      setSpinOffMeta(null);
                    }}
                  />
                  <TerminalContextStrip
                    attachments={shared.terminalContexts}
                    onRemove={actions.removeTerminalContext}
                  />
                </>
              }
            />
          </ErrorBoundary>
        ))}
      <SpinOffPrepDialog
        open={spinOffDialogOpen}
        onOpenChange={(open) => {
          setSpinOffDialogOpen(open);
          if (!open) {
            setSpinOffDialogState(null);
            setSpinOffIncludeTouchedFiles(false);
            setSpinOffEdits({ currentState: "" });
          }
        }}
        edits={spinOffEdits}
        onChange={setSpinOffEdits}
        onConfirm={handleSpinOff}
        isSubmitting={spinOffSubmitting}
        selectedText={spinOffDialogState?.selectedText}
        includeTouchedFiles={spinOffIncludeTouchedFiles}
        onIncludeTouchedFilesChange={setSpinOffIncludeTouchedFiles}
        canIncludeTouchedFiles={canIncludeTouchedFiles}
      />
    </>
  );
}

/** Wraps children in MessageRelayProvider when cross-chat actions are available. */
function MaybeRelayProvider({
  value,
  children,
}: {
  value: Parameters<typeof MessageRelayProvider>[0]["value"] | null;
  children: React.ReactNode;
}) {
  if (!value) return <>{children}</>;
  return <MessageRelayProvider value={value}>{children}</MessageRelayProvider>;
}
