/**
 * Claude Process Manager
 *
 * Manages Claude Code using print mode (-p) for clean text output.
 * Each message spawns a new process with --continue to maintain conversation context.
 */

import { EventEmitter } from "events";
import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import type {
  OutputMessage,
  ExitMessage,
  ActivityMessage,
  TaskItem,
  FileChange,
  SessionStats,
  ProviderRequest,
  ProviderRuntimeBinding,
  ProviderRuntimeMode,
  SystemEventMessage,
  UserInputQuestion,
} from "#core/types.js";
import type { CoreConfig } from "#core/config.js";
import type { ProviderSession } from "#core/provider.js";
import {
  describeToolUse,
  describeToolDetail,
  extractInputDescription,
  extractToolResultText,
  buildToolResultActivity,
  getContextWindow,
  capDetail,
  TASK_TOOLS,
  FILE_WRITE_TOOLS,
} from "#core/tools.js";
import { isPathWithinWorkspace } from "#core/workspace-paths.js";

// =============================================================================
// Types
// =============================================================================

export interface ClaudeProcessEvents {
  output: [OutputMessage];
  exit: [ExitMessage];
  activity: [ActivityMessage];
  /** CLI sessions never emit this — included for ProviderSession compatibility. */
  systemEvent: [SystemEventMessage];
  stats: [SessionStats];
  /** CLI sessions never emit this — included for ProviderSession compatibility. */
  providerError: [string];
  /** CLI sessions never emit this — included for ProviderSession compatibility. */
  permissionRequest: [ProviderRequest];
  /** CLI sessions never emit this — included for ProviderSession compatibility. */
  titleUpdate: [string];
}

export interface ClaudeProcess {
  on<E extends keyof ClaudeProcessEvents>(
    event: E,
    listener: (...args: ClaudeProcessEvents[E]) => void,
  ): this;
  emit<E extends keyof ClaudeProcessEvents>(event: E, ...args: ClaudeProcessEvents[E]): boolean;
  off<E extends keyof ClaudeProcessEvents>(
    event: E,
    listener: (...args: ClaudeProcessEvents[E]) => void,
  ): this;
}

// =============================================================================
// ClaudeProcess Class
// =============================================================================

/**
 * Manages Claude Code using print mode for clean output.
 * Implements ProviderSession so InstanceManager can treat it
 * identically to the SDK-based provider.
 */
export class ClaudeProcess extends EventEmitter implements ProviderSession {
  private currentProcess: ChildProcess | null = null;
  private _isProcessing = false;
  private claudePath: string;
  private cwd: string;
  private isFirstMessage = true;
  private config: CoreConfig;
  private resumeSessionId: string | null;
  private allowedTools: string[] = [];
  private taskMap = new Map<string, TaskItem>();
  private pendingTaskCreates = new Map<string, { subject: string; activeForm?: string }>();
  private fileMap = new Map<string, FileChange>();
  private _cancelledForPermission = false;
  private _cancelledByUser = false;
  private _processTimeout: ReturnType<typeof setTimeout> | null = null;
  private _preferredModel: string | null = null;
  private _runtimeMode: ProviderRuntimeMode;
  private _stats: SessionStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  get stats(): SessionStats {
    return { ...this._stats };
  }

  get provider(): "claude" {
    return "claude";
  }

  constructor(
    config: CoreConfig,
    options?: {
      resumeSessionId?: string;
      model?: string;
      runtimeMode?: ProviderRuntimeMode;
    },
  ) {
    super();
    this.config = config;
    this.resumeSessionId = options?.resumeSessionId ?? null;
    this._preferredModel = options?.model ?? null;
    this._runtimeMode = options?.runtimeMode ?? config.defaultRuntimeMode;
    this.claudePath = this.findClaudeBinary();
    this.cwd = config.workingDirectory;
    config.logger.debug(`[Claude] Binary: ${this.claudePath}`);
    config.logger.debug(`[Claude] Working directory: ${this.cwd}`);
    if (this.resumeSessionId) {
      config.logger.debug(`[Claude] Resuming session: ${this.resumeSessionId}`);
    }
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  /** PID of the currently running child process, or undefined if idle */
  get pid(): number | undefined {
    return this.currentProcess?.pid;
  }

  getRuntimeBinding(): ProviderRuntimeBinding {
    return {
      provider: "claude",
      providerSessionId: this.resumeSessionId ?? undefined,
      resumeCursor: this.resumeSessionId ? { sessionId: this.resumeSessionId } : undefined,
      runtimePayload: {
        cwd: this.cwd,
        model: this._preferredModel ?? undefined,
      },
      runtimeMode: this._runtimeMode,
    };
  }

  /**
   * Set the session ID after it has been captured from the JSONL file.
   * Subsequent sends will use --resume <id> for precise session targeting
   * instead of --continue (which picks up the "last" session in the CWD).
   */
  setSessionId(sessionId: string): void {
    this.resumeSessionId = sessionId;
  }

  /**
   * Add a tool to the allowed list. Subsequent sends will include
   * --allowedTools with all accumulated tools. Deduplicates.
   */
  addAllowedTool(tool: string): void {
    if (!this.allowedTools.includes(tool)) {
      this.allowedTools.push(tool);
    }
  }

  setRuntimeMode(mode: ProviderRuntimeMode): void {
    if (mode !== "approval-required" && mode !== "full-access" && mode !== "plan") {
      this.config.logger.warn(`[Claude] Unknown runtime mode: ${mode}`);
      return;
    }
    this._runtimeMode = mode;
  }

  /**
   * Set the preferred model for subsequent sends. Pass null to clear.
   */
  setModel(model: string | null): void {
    this._preferredModel = model;
  }

  /**
   * Cancel the process due to a permission denial. Sends SIGINT but lets
   * the close handler manage _isProcessing cleanup to avoid races.
   */
  cancelForPermission(): void {
    if (this.currentProcess) {
      this._cancelledForPermission = true;
      this.config.logger.info("[Claude] Cancelling for permission denial");
      this.currentProcess.kill("SIGINT");
    }
  }

  /**
   * Apply a TodoWrite tool payload — replaces the entire task list.
   * TodoWrite sends all todos at once (unlike TaskCreate/TaskUpdate which are incremental).
   */
  private applyTodoWrite(input: Record<string, unknown>): void {
    const todos = input.todos as
      | Array<{ content?: string; status?: string; activeForm?: string }>
      | undefined;
    if (!Array.isArray(todos)) return;
    this.taskMap.clear();
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      if (!t.content) continue;
      const id = `todo-${i}`;
      this.taskMap.set(id, {
        id,
        subject: t.content,
        status: (t.status as TaskItem["status"]) || "pending",
        activeForm: t.activeForm,
      });
    }
    this.emitTaskList();
  }

  private emitTaskList(): void {
    const activity: ActivityMessage = {
      type: "activity",
      activity: "task_list",
      description: "Tasks",
      tasks: Array.from(this.taskMap.values()).map((t) => ({ ...t })),
    };
    this.emit("activity", activity);
  }

  private trackFileChange(toolName: string, input: Record<string, unknown> | undefined): void {
    if (!input || !FILE_WRITE_TOOLS.has(toolName)) return;
    const filePath = (input.file_path || input.path || input.notebook_path) as string | undefined;
    if (!filePath) return;
    // Skip files outside the working directory (e.g. memory files in ~/.claude/).
    if (!isPathWithinWorkspace(this.cwd, filePath)) return;
    const existing = this.fileMap.get(filePath);
    if (existing) {
      existing.editCount++;
    } else {
      this.fileMap.set(filePath, {
        path: filePath,
        editCount: 1,
        type: toolName === "Write" ? "added" : "edited",
      });
    }
    this.emitFileList();
  }

  private emitFileList(): void {
    const activity: ActivityMessage = {
      type: "activity",
      activity: "file_list",
      description: "Files changed",
      files: Array.from(this.fileMap.values()).map((f) => ({ ...f })),
    };
    this.emit("activity", activity);
  }

  private emitToolUseActivity(
    toolName: string,
    input: Record<string, unknown> | undefined,
    toolUseId?: string,
  ): void {
    const activityInput =
      toolName === "AskUserQuestion" && toolUseId ? { ...input, requestId: toolUseId } : input;

    if (toolName === "AskUserQuestion" && toolUseId) {
      const questions = Array.isArray(input?.questions)
        ? input.questions
            .filter(
              (question): question is UserInputQuestion =>
                typeof question === "object" &&
                question !== null &&
                typeof (question as UserInputQuestion).id === "string" &&
                typeof (question as UserInputQuestion).question === "string",
            )
            // The Claude harness always offers a freeform "Other" answer; flag it
            // so the UI enables the composer (see claude-sdk.ts / instance-manager.ts).
            // Normalize multiSelect to a boolean to match the SDK/replay mappers.
            .map((question) => ({
              ...question,
              multiSelect: question.multiSelect === true,
              isOther: true,
            }))
        : [];
      if (questions.length > 0) {
        const request: ProviderRequest = {
          requestId: toolUseId,
          kind: "user_input",
          tool: "AskUserQuestion",
          description: questions[0]?.question,
          questions,
        };
        this.emit("permissionRequest", request);
      }
    }

    const activity: ActivityMessage = {
      type: "activity",
      activity: "tool_use",
      tool: toolName,
      description: describeToolUse(toolName, input),
      detail: describeToolDetail(toolName, input),
      input: activityInput,
      inputDescription: extractInputDescription(toolName, input),
    };
    this.emit("activity", activity);
  }

  private handleBashProgress(data: Record<string, unknown>): void {
    const elapsed = data.elapsed_seconds as number | undefined;
    const output = data.output as string | undefined;
    if (elapsed == null) return;
    const activity: ActivityMessage = {
      type: "activity",
      activity: "tool_use",
      tool: "Bash",
      description: `Running... ${Math.round(elapsed)}s`,
      detail: output ? (output.length > 300 ? output.slice(-300) : output) : undefined,
    };
    this.emit("activity", activity);
  }

  private handleAgentProgress(data: Record<string, unknown>): void {
    const message = data.message as Record<string, unknown> | undefined;
    if (!message) return;
    const innerMessage = message.message as Record<string, unknown> | undefined;
    if (!innerMessage) return;
    const content = innerMessage.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === "tool_use") {
        const tool = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        this.emitToolUseActivity(tool, input, block.id as string | undefined);
      }
    }
  }

  private accumulateUsage(
    model: string,
    usage: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    },
  ): void {
    if (!usage.input_tokens && !usage.output_tokens) return;
    const u = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    };
    this._stats.inputTokens += u.input_tokens;
    this._stats.outputTokens += u.output_tokens;
    this._stats.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    this._stats.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    // Only record the primary (first) model — Claude Code may use cheaper
    // models (e.g. Haiku) internally for subagent/tool operations.
    if (!this._stats.model) {
      this._stats.model = model;
    }
    // Snapshot this turn's total input = current context window utilization
    this._stats.contextTokens =
      u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (!this._stats.contextWindow) {
      this._stats.contextWindow = getContextWindow(this._stats.model);
    }
    this.emit("stats", { ...this._stats });
  }

  /**
   * Extract context window budget from Claude's inline system tags.
   * `<budget:token_budget>N</budget:token_budget>` at session start, or
   * `<system_warning>Token usage: X/Y; Z remaining</system_warning>` after tool calls.
   */
  private extractContextBudget(text: string): void {
    const budgetMatch = text.match(/<budget:token_budget>([\d,]+)<\/budget:token_budget>/);
    if (budgetMatch) {
      this._stats.contextWindow = parseInt(budgetMatch[1].replace(/,/g, ""), 10);
      this.emit("stats", { ...this._stats });
      return;
    }
    const warningMatch = text.match(/<system_warning>Token usage:\s*([\d,]+)\s*\/\s*([\d,]+)/);
    if (warningMatch) {
      const used = parseInt(warningMatch[1].replace(/,/g, ""), 10);
      const total = parseInt(warningMatch[2].replace(/,/g, ""), 10);
      if (total === 0 && used === 0) return;
      // Only use the warning's context window if we don't already have one
      // from our known model mapping — Claude Code can report incorrect limits.
      if (total > 0 && !this._stats.contextWindow) {
        this._stats.contextWindow = total;
      }
      if (used > 0) {
        this._stats.contextTokens = used;
      }
      this.emit("stats", { ...this._stats });
    }
  }

  private findClaudeBinary(): string {
    const commonPaths = [
      `${process.env.HOME}/.local/bin/claude`,
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ];

    for (const p of commonPaths) {
      if (existsSync(p)) {
        return p;
      }
    }

    try {
      const result = execSync("which claude", { encoding: "utf-8" }).trim();
      if (result) return result;
    } catch {
      // ignore
    }

    return "claude";
  }

  /**
   * Send a message to Claude.
   * Images should be referenced in the message text as `[Image: source: /path]`
   * so Claude can read them via its Read tool.
   */
  send(message: string): void {
    if (this._isProcessing) {
      this.config.logger.info("[Claude] Already processing, ignoring message");
      return;
    }

    this._isProcessing = true;
    this.config.logger.info(`[Claude] Sending: "${message.slice(0, 50)}..."`);

    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    if (this._runtimeMode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (this._runtimeMode === "full-access") {
      args.push("--dangerously-skip-permissions");
    }

    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", this.allowedTools.join(" "));
    }

    if (this._preferredModel) {
      args.push("--model", this._preferredModel);
    }

    if (this.resumeSessionId) {
      args.push("--resume", this.resumeSessionId);
    } else if (!this.isFirstMessage) {
      args.push("--continue");
    }

    args.push(message);

    this.config.logger.debug(`[Claude] Running: claude ${args.join(" ")}`);

    this.currentProcess = spawn(this.claudePath, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.config.logger.debug(`[Claude] Process spawned with PID: ${this.currentProcess.pid}`);

    this.currentProcess.stdin?.end();

    let lineBuffer = "";
    let hasEmittedContent = false;
    // Map tool_use_id → tool name so tool_result denials know which tool was denied
    const pendingTools = new Map<string, string>();

    this.currentProcess.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      lineBuffer += chunk;

      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line);

          this.config.logger.debug(`[Claude] event: ${JSON.stringify(event).slice(0, 200)}`);

          if (event.type === "system") {
            this.config.logger.debug("[Claude] system init");
          } else if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "thinking" && block.thinking) {
                const activity: ActivityMessage = {
                  type: "activity",
                  activity: "thinking",
                  description: "Reasoning...",
                  detail: capDetail(block.thinking),
                };
                this.emit("activity", activity);
                hasEmittedContent = true;
              } else if (block.type === "tool_use") {
                const toolName = block.name || "Unknown tool";
                if (block.id) pendingTools.set(block.id, toolName);
                if (TASK_TOOLS.has(toolName)) {
                  const input = block.input as Record<string, unknown> | undefined;
                  if (toolName === "TodoWrite" && input) {
                    this.applyTodoWrite(input);
                  } else if (toolName === "TaskCreate" && input && block.id) {
                    this.pendingTaskCreates.set(block.id, {
                      subject: (input.subject as string) || "Untitled task",
                      activeForm: input.activeForm as string | undefined,
                    });
                  } else if (toolName === "TaskUpdate" && input) {
                    const taskId = input.taskId as string;
                    const status = input.status as string | undefined;
                    if (taskId && status === "deleted") {
                      this.taskMap.delete(taskId);
                      this.emitTaskList();
                    } else if (taskId && status && this.taskMap.has(taskId)) {
                      const task = this.taskMap.get(taskId)!;
                      task.status = status as TaskItem["status"];
                      if (input.subject) task.subject = input.subject as string;
                      if (input.activeForm) task.activeForm = input.activeForm as string;
                      this.emitTaskList();
                    }
                  }
                  // TaskList/TaskGet: suppress — no activity emitted
                } else {
                  const input = block.input as Record<string, unknown> | undefined;
                  this.trackFileChange(toolName, input);
                  this.emitToolUseActivity(toolName, input, block.id as string | undefined);
                }
              } else if (block.type === "text" && block.text) {
                this.extractContextBudget(block.text);
                const outputMessage: OutputMessage = {
                  type: "output",
                  text: block.text,
                  isWaiting: false,
                };
                this.emit("output", outputMessage);
                hasEmittedContent = true;
              }
            }
            // Extract usage from assistant event
            if (event.message?.usage && event.message?.model) {
              this.accumulateUsage(event.message.model, event.message.usage);
            }
          } else if (event.type === "tool_use") {
            const toolName = event.name || event.tool || "Unknown tool";
            if (event.id) pendingTools.set(event.id, toolName);
            if (TASK_TOOLS.has(toolName)) {
              const input = event.input as Record<string, unknown> | undefined;
              if (toolName === "TodoWrite" && input) {
                this.applyTodoWrite(input);
              } else if (toolName === "TaskCreate" && input && event.id) {
                this.pendingTaskCreates.set(event.id, {
                  subject: (input.subject as string) || "Untitled task",
                  activeForm: input.activeForm as string | undefined,
                });
              } else if (toolName === "TaskUpdate" && input) {
                const taskId = input.taskId as string;
                const status = input.status as string | undefined;
                if (taskId && status === "deleted") {
                  this.taskMap.delete(taskId);
                  this.emitTaskList();
                } else if (taskId && status && this.taskMap.has(taskId)) {
                  const task = this.taskMap.get(taskId)!;
                  task.status = status as TaskItem["status"];
                  if (input.subject) task.subject = input.subject as string;
                  if (input.activeForm) task.activeForm = input.activeForm as string;
                  this.emitTaskList();
                }
              }
            } else {
              const input = event.input as Record<string, unknown> | undefined;
              this.trackFileChange(toolName, input);
              this.emitToolUseActivity(toolName, input, event.id as string | undefined);
            }
          } else if (event.type === "tool_result") {
            const toolName = pendingTools.get(event.tool_use_id);
            if (TASK_TOOLS.has(toolName || "")) {
              if (toolName === "TaskCreate") {
                const content = event.content || "";
                const idMatch = content.match(/Task #(\d+)/);
                const pending = this.pendingTaskCreates.get(event.tool_use_id);
                if (idMatch && pending) {
                  const taskId = idMatch[1];
                  this.taskMap.set(taskId, {
                    id: taskId,
                    subject: pending.subject,
                    status: "pending",
                    activeForm: pending.activeForm,
                  });
                  this.pendingTaskCreates.delete(event.tool_use_id);
                  this.emitTaskList();
                }
              }
              // Other task tool results: suppress
            } else {
              const content = extractToolResultText(event.content);
              const toolName = pendingTools.get(event.tool_use_id);
              const activity = buildToolResultActivity(event.is_error, toolName, content);

              // Suppress duplicate denial emissions after cancel
              if (activity.permissionDenied && this._cancelledForPermission) continue;

              this.emit("activity", activity);

              // Cancel process on first permission denial to stop retry loop
              if (activity.permissionDenied) {
                this.cancelForPermission();
              }
            }
          } else if (event.type === "user" && event.message?.content) {
            // tool_result blocks arrive inside "user" type events in stream-json
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result") {
                  const toolName = pendingTools.get(block.tool_use_id);
                  if (TASK_TOOLS.has(toolName || "")) {
                    if (toolName === "TaskCreate") {
                      const text = block.content || "";
                      const idMatch = text.match(/Task #(\d+)/);
                      const pending = this.pendingTaskCreates.get(block.tool_use_id);
                      if (idMatch && pending) {
                        const taskId = idMatch[1];
                        this.taskMap.set(taskId, {
                          id: taskId,
                          subject: pending.subject,
                          status: "pending",
                          activeForm: pending.activeForm,
                        });
                        this.pendingTaskCreates.delete(block.tool_use_id);
                        this.emitTaskList();
                      }
                    }
                  } else {
                    const text = extractToolResultText(block.content);
                    const toolName = pendingTools.get(block.tool_use_id);
                    const activity = buildToolResultActivity(block.is_error, toolName, text);

                    // Suppress duplicate denial emissions after cancel
                    if (activity.permissionDenied && this._cancelledForPermission) continue;

                    this.emit("activity", activity);

                    // Cancel process on first permission denial to stop retry loop
                    if (activity.permissionDenied) {
                      this.cancelForPermission();
                    }
                  }
                }
              }
            }
          } else if (event.type === "result") {
            this.config.logger.debug(`[Claude] result: success=${!event.is_error}`);
            if (event.result) {
              this.extractContextBudget(event.result);
            }
            if (!hasEmittedContent && event.result) {
              const outputMessage: OutputMessage = {
                type: "output",
                text: event.result,
                isWaiting: false,
              };
              this.emit("output", outputMessage);
            }
            // Extract usage from result event
            if (event.usage && event.model) {
              this.accumulateUsage(event.model, event.usage);
            }
          } else if (event.type === "progress" && event.data) {
            const dataType = (event.data as Record<string, unknown>).type;
            if (dataType === "bash_progress") {
              this.handleBashProgress(event.data as Record<string, unknown>);
            } else if (dataType === "agent_progress") {
              this.handleAgentProgress(event.data as Record<string, unknown>);
            }
            // hook_progress: skip
          } else {
            this.config.logger.debug(`[Claude] event: ${event.type}`);
          }
        } catch {
          this.config.logger.debug(`[Claude] raw text: "${line.slice(0, 50)}..."`);
          const outputMessage: OutputMessage = {
            type: "output",
            text: line + "\n",
            isWaiting: false,
          };
          this.emit("output", outputMessage);
        }
      }
    });

    let stderrBuffer = "";
    this.currentProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.config.logger.debug(`[Claude] stderr: "${text.slice(0, 100).replace(/\n/g, "\\n")}..."`);
      stderrBuffer += text;
      if (stderrBuffer.length > 2000) {
        stderrBuffer = stderrBuffer.slice(-2000);
      }
    });

    this.currentProcess.on("close", (code, signal) => {
      this.config.logger.info(`[Claude] Process exited with code: ${code}, signal: ${signal}`);
      const wasCancelledForPermission = this._cancelledForPermission;
      const wasCancelledByUser = this._cancelledByUser;
      this._cancelledForPermission = false;
      this._cancelledByUser = false;
      this._isProcessing = false;
      this.currentProcess = null;
      this.isFirstMessage = false;

      const doneMessage: OutputMessage = {
        type: "output",
        text: "",
        isWaiting: true,
      };
      this.emit("output", doneMessage);

      if (this._processTimeout) {
        clearTimeout(this._processTimeout);
        this._processTimeout = null;
      }
      // Suppress error exit when we intentionally cancelled (user or permission denial)
      if ((code !== 0 || signal) && !wasCancelledForPermission && !wasCancelledByUser) {
        const trimmedStderr = stderrBuffer.trim().slice(-500) || undefined;
        const exitMessage: ExitMessage = {
          type: "exit",
          code: code ?? 1,
          signal: signal ?? undefined,
          stderr: trimmedStderr,
        };
        this.emit("exit", exitMessage);
      }
    });

    this.currentProcess.on("error", (err) => {
      this.config.logger.error("[Claude] Process error:", err);
      this._isProcessing = false;
      this.currentProcess = null;
    });

    // Timeout protection
    if (this.config.processTimeout > 0) {
      this._processTimeout = setTimeout(() => {
        if (this._isProcessing && this.currentProcess) {
          this.config.logger.warn(
            `[Claude] Process timeout after ${this.config.processTimeout}ms, killing...`,
          );
          this.currentProcess.kill("SIGKILL");
          this._isProcessing = false;
          this.currentProcess = null;
        }
      }, this.config.processTimeout);
    }
  }

  /**
   * Cancel the current operation (SIGINT).
   * The session is preserved — the next sendMessage() resumes via --resume.
   */
  cancel(): void {
    if (this.currentProcess) {
      this.config.logger.info("[Claude] Cancelling...");
      this._cancelledByUser = true;
      this.currentProcess.kill("SIGINT");
      this._isProcessing = false;
      this.currentProcess = null;
    }
  }

  /** ProviderSession: interrupt the current turn (alias for cancel). */
  interrupt(): void {
    this.cancel();
  }

  private waitForProcessExit(graceMs = 2000): Promise<void> {
    const child = this.currentProcess;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onExit);
        if (this.currentProcess === child) {
          this.currentProcess = null;
          this._isProcessing = false;
        }
        resolve();
      };
      const onExit = () => finish();
      const timer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGKILL");
        }
        finish();
      }, graceMs);
      timer.unref?.();
      child.once("exit", onExit);
      child.once("error", onExit);
      if (child.exitCode !== null) {
        finish();
      }
    });
  }

  kill(): void {
    const child = this.currentProcess;
    if (!child) return;
    if (this._processTimeout) {
      clearTimeout(this._processTimeout);
      this._processTimeout = null;
    }
    child.kill("SIGKILL");
    this.currentProcess = null;
    this._isProcessing = false;
  }

  /** ProviderSession: close the session and release resources. */
  async close(): Promise<void> {
    const child = this.currentProcess;
    if (!child) return;
    if (this._processTimeout) {
      clearTimeout(this._processTimeout);
      this._processTimeout = null;
    }
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
    await this.waitForProcessExit();
  }
}
