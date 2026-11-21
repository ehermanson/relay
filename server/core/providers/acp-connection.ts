/**
 * Agent Client Protocol (ACP) connection
 *
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio, in both
 * directions: Relay calls the agent (`initialize`, `session/prompt`, …) and
 * the agent calls Relay (`session/request_permission`, `fs/read_text_file`)
 * and streams `session/update` notifications.
 *
 * Provider-neutral: the Antigravity driver owns everything agent-specific.
 */

import type { ChildProcess } from "child_process";

export interface AcpRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, error: AcpRpcError) {
    super(error.message || `ACP ${method} failed (${error.code})`);
    this.name = "AcpRequestError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

export interface AcpConnectionHandlers {
  /** A notification from the agent (`session/update`, …). */
  onNotification(method: string, params: Record<string, unknown>): void;
  /**
   * A request from the agent. Return the result, or throw an `AcpRequestError`
   * (or any error) to answer with a JSON-RPC error. May be async: a
   * permission request stays open until the user answers.
   */
  onRequest(method: string, params: Record<string, unknown>, id: string | number): unknown;
  /** A stdout line that is not JSON-RPC (sign-in banners, stray logs). */
  onStrayLine?(line: string): void;
}

interface PendingCall {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export class AcpConnection {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private closedError: Error | null = null;
  private readonly child: ChildProcess;
  private readonly handlers: AcpConnectionHandlers;

  constructor(child: ChildProcess, handlers: AcpConnectionHandlers) {
    this.child = child;
    this.handlers = handlers;
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    // A write racing the agent's exit fails with EPIPE on stdin. Unhandled,
    // that stream error would take down the whole server.
    child.stdin?.on("error", (error) => this.close(error));
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  /** Call an agent method and wait for its result. */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const call: PendingCall = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (options.timeoutMs) {
        call.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }
      this.pending.set(id, call);
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        if (call.timer) clearTimeout(call.timer);
        reject(new Error(`ACP ${method}: agent stdin is closed`));
      }
    });
  }

  /** Send a notification (no response), e.g. `session/cancel`. */
  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Fail every outstanding call; later calls reject immediately. */
  close(error: Error = new Error("ACP connection closed")): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const [id, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }

  private write(message: Record<string, unknown>): boolean {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable || this.closedError) return false;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    return true;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.handlers.onStrayLine?.(line);
      return;
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      this.handlers.onStrayLine?.(line);
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = message.id as string | number | undefined;
    const params = (message.params ?? {}) as Record<string, unknown>;

    if (method && id !== undefined && id !== null) {
      void this.answer(method, params, id);
      return;
    }
    if (method) {
      try {
        this.handlers.onNotification(method, params);
      } catch {
        // A handler bug must never take the stream down.
      }
      return;
    }
    if (typeof id === "number") {
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      if (call.timer) clearTimeout(call.timer);
      if (message.error)
        call.reject(new AcpRequestError(call.method, message.error as AcpRpcError));
      else call.resolve(message.result);
    }
  }

  private async answer(
    method: string,
    params: Record<string, unknown>,
    id: string | number,
  ): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params, id);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const rpc =
        error instanceof AcpRequestError
          ? { code: error.code, message: error.message }
          : { code: -32603, message: error instanceof Error ? error.message : String(error) };
      this.write({ jsonrpc: "2.0", id, error: rpc });
    }
  }
}

/** JSON-RPC "method not found" — the answer to agent requests Relay doesn't serve. */
export function acpMethodNotFound(method: string): AcpRequestError {
  return new AcpRequestError(method, { code: -32601, message: `Method not found: ${method}` });
}
