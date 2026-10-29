/**
 * TerminalManager — Terminal lifecycle management for Relay
 *
 * Manages embedded PTY terminals scoped to a single chat session. Terminals
 * live in memory only; their ptys die with the server.
 *
 * Uses a pluggable PtyAdapterFactory so the PTY backend can be swapped.
 */

import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { PtyAdapterFactory, PtyProcess } from "#core/pty-adapter.js";
import type { TerminalInfo, TerminalScope, TerminalScopeSummary } from "#core/types.js";
import type { Logger } from "#core/logger.js";

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const MAX_SCROLLBACK_BYTES = 512 * 1024; // 512 KB

// ── Internal terminal state ──────────────────────────────────────────

interface Terminal {
  info: TerminalInfo;
  /** null while waiting for the first resize to arrive with real dimensions. */
  pty: PtyProcess | null;
  /** Stored so we can spawn the PTY lazily after creation. */
  pendingCwd: string;
  scrollback: string[];
  scrollbackBytes: number;
}

// ── Events ───────────────────────────────────────────────────────────

export interface TerminalManagerEvents {
  "terminal:created": [terminal: TerminalInfo];
  "terminal:output": [terminalId: string, data: string];
  "terminal:exit": [terminalId: string, code: number, signal?: string];
  "terminal:removed": [terminalId: string];
}

export interface TerminalManager {
  on<E extends keyof TerminalManagerEvents>(
    event: E,
    listener: (...args: TerminalManagerEvents[E]) => void,
  ): this;
  emit<E extends keyof TerminalManagerEvents>(event: E, ...args: TerminalManagerEvents[E]): boolean;
  off<E extends keyof TerminalManagerEvents>(
    event: E,
    listener: (...args: TerminalManagerEvents[E]) => void,
  ): this;
}

function scopeKey(scope: TerminalScope): string {
  return `instance:${scope.instanceId}`;
}

// ── TerminalManager ──────────────────────────────────────────────────

export class TerminalManager extends EventEmitter {
  private terminals = new Map<string, Terminal>();
  private ptyFactory: PtyAdapterFactory;
  private log: Logger;

  constructor(ptyFactory: PtyAdapterFactory, log: Logger) {
    super();
    this.ptyFactory = ptyFactory;
    this.log = log;
  }

  /**
   * Create a new terminal session.
   *
   * When cols/rows are omitted the PTY spawn is deferred until the first
   * `resizeTerminal` call arrives with the real client dimensions.  This
   * avoids a double-prompt: the shell would otherwise render at the default
   * 120×30, then immediately get SIGWINCH when the client sends the actual
   * size, causing a second prompt redraw.
   */
  createTerminal(options: {
    scope: TerminalScope;
    cwd: string;
    cols?: number;
    rows?: number;
  }): TerminalInfo {
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const hasDimensions = options.cols != null && options.rows != null;
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;

    const info: TerminalInfo = {
      id,
      scope: options.scope,
      cwd: options.cwd,
      cols,
      rows,
      createdAt: Date.now(),
      exited: false,
    };

    const terminal: Terminal = {
      info,
      pty: null,
      pendingCwd: options.cwd,
      scrollback: [],
      scrollbackBytes: 0,
    };

    this.terminals.set(id, terminal);

    // If the caller already knows the dimensions, spawn immediately.
    if (hasDimensions) {
      this.spawnPty(terminal);
    }

    this.log.info(
      `Terminal ${id} created (scope=${scopeKey(options.scope)}, cwd=${options.cwd}, deferred=${!hasDimensions})`,
    );
    this.emit("terminal:created", info);
    return info;
  }

  /**
   * Write data to a terminal's PTY stdin.
   */
  writeTerminal(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    // Lazily spawn if the user types before resize arrives
    if (!terminal.pty) this.spawnPty(terminal);
    terminal.pty!.write(data);
  }

  /**
   * Resize a terminal's PTY.
   *
   * If the PTY hasn't been spawned yet (deferred creation), this spawns it
   * at the given dimensions — no SIGWINCH, no double prompt.
   */
  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    if (!terminal.pty) {
      // First resize — spawn the PTY at the correct size
      terminal.info.cols = cols;
      terminal.info.rows = rows;
      this.spawnPty(terminal);
    } else if (cols !== terminal.info.cols || rows !== terminal.info.rows) {
      // Only send SIGWINCH when dimensions actually changed — avoids a
      // redundant prompt redraw when the UI re-opens at the same size.
      terminal.info.cols = cols;
      terminal.info.rows = rows;
      terminal.pty.resize(cols, rows);
    }
  }

  /**
   * Close and remove a terminal.
   */
  closeTerminal(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    if (terminal.pty && !terminal.info.exited) {
      terminal.pty.kill();
    }
    this.terminals.delete(terminalId);
    this.log.info(`Terminal ${terminalId} closed`);
    this.emit("terminal:removed", terminalId);
  }

  /**
   * Get terminal info by ID.
   */
  getTerminal(terminalId: string): TerminalInfo | undefined {
    return this.terminals.get(terminalId)?.info;
  }

  /**
   * Get the scrollback buffer for a terminal (for reconnect replay).
   */
  getScrollback(terminalId: string): string {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return "";
    return terminal.scrollback.join("");
  }

  /**
   * List all terminals, optionally filtered by scope.
   */
  listTerminals(scope?: TerminalScope): TerminalInfo[] {
    const all = Array.from(this.terminals.values()).map((t) => t.info);
    if (!scope) return all;
    const key = scopeKey(scope);
    return all.filter((t) => scopeKey(t.scope) === key);
  }

  /**
   * Summarize live (non-exited) terminals grouped by scope. Used to broadcast
   * a global "which scopes have running terminals" snapshot to the sidebar.
   */
  listActiveScopes(): TerminalScopeSummary[] {
    const byKey = new Map<string, TerminalScopeSummary>();
    for (const { info } of this.terminals.values()) {
      if (info.exited) continue;
      const key = scopeKey(info.scope);
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        byKey.set(key, { scope: info.scope, count: 1 });
      }
    }
    return Array.from(byKey.values());
  }

  /**
   * Close all terminals for a given scope (e.g. when a chat is removed).
   */
  closeAllForScope(scope: TerminalScope): void {
    const key = scopeKey(scope);
    for (const [id, terminal] of this.terminals) {
      if (scopeKey(terminal.info.scope) === key) {
        this.closeTerminal(id);
      }
    }
  }

  /**
   * Close all terminals. Called during server shutdown.
   */
  closeAll(): void {
    for (const id of Array.from(this.terminals.keys())) {
      this.closeTerminal(id);
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Actually spawn the PTY process for a terminal that was created with
   * deferred spawn.  Uses the dimensions currently stored in `terminal.info`.
   */
  private spawnPty(terminal: Terminal): void {
    const { info } = terminal;
    const pty = this.ptyFactory({
      cwd: terminal.pendingCwd,
      cols: info.cols,
      rows: info.rows,
    });

    terminal.pty = pty;

    pty.on("data", (data: string) => {
      this.appendScrollback(terminal, data);
      this.emit("terminal:output", info.id, data);
    });

    pty.on("exit", (code: number, signal?: string) => {
      info.exited = true;
      info.exitCode = code;
      this.log.info(`Terminal ${info.id} exited (code=${code}, signal=${signal ?? "none"})`);
      this.emit("terminal:exit", info.id, code, signal);
    });
  }

  private appendScrollback(terminal: Terminal, data: string): void {
    terminal.scrollback.push(data);
    terminal.scrollbackBytes += data.length;

    // Trim old scrollback when we exceed the limit
    while (terminal.scrollbackBytes > MAX_SCROLLBACK_BYTES && terminal.scrollback.length > 1) {
      const removed = terminal.scrollback.shift()!;
      terminal.scrollbackBytes -= removed.length;
    }
  }
}
