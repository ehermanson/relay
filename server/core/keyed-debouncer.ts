/**
 * Per-key trailing debounce for expensive async refreshes.
 *
 * - Bursts of `schedule(key)` coalesce into one run after `delayMs` of quiet,
 *   but a run is never deferred more than `maxWaitMs` past the first request.
 * - A key never runs concurrently with itself: requests that arrive while a
 *   run is in flight set a rerun flag, and exactly one trailing run follows.
 * - `schedule(key, { immediate: true })` skips the quiet period (still
 *   respecting the in-flight guard), e.g. to force a refresh at turn end.
 */

export interface KeyedDebouncerOptions {
  delayMs: number;
  maxWaitMs: number;
  run: (key: string) => Promise<void>;
  onError?: (key: string, err: unknown) => void;
}

interface KeyState {
  timer: ReturnType<typeof setTimeout> | null;
  firstRequestedAt: number | null;
  inFlight: Promise<void> | null;
  rerun: boolean;
  rerunImmediate: boolean;
}

export class KeyedTrailingDebouncer {
  /** Mutable so tests can shorten the windows. */
  delayMs: number;
  maxWaitMs: number;
  private readonly runFn: (key: string) => Promise<void>;
  private readonly onError?: (key: string, err: unknown) => void;
  private readonly states = new Map<string, KeyState>();

  constructor(opts: KeyedDebouncerOptions) {
    this.delayMs = opts.delayMs;
    this.maxWaitMs = opts.maxWaitMs;
    this.runFn = opts.run;
    this.onError = opts.onError;
  }

  schedule(key: string, opts?: { immediate?: boolean }): void {
    let state = this.states.get(key);
    if (!state) {
      state = {
        timer: null,
        firstRequestedAt: null,
        inFlight: null,
        rerun: false,
        rerunImmediate: false,
      };
      this.states.set(key, state);
    }
    if (state.inFlight) {
      state.rerun = true;
      if (opts?.immediate) state.rerunImmediate = true;
      return;
    }
    const now = Date.now();
    if (state.firstRequestedAt === null) state.firstRequestedAt = now;
    const remainingMaxWait = Math.max(0, state.firstRequestedAt + this.maxWaitMs - now);
    const wait = opts?.immediate ? 0 : Math.min(this.delayMs, remainingMaxWait);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => this.fire(key), wait);
    state.timer.unref?.();
  }

  /** Whether a run is queued or in flight for `key`. */
  isPending(key: string): boolean {
    const state = this.states.get(key);
    return !!state && (state.timer !== null || state.inFlight !== null);
  }

  /** Resolves once any in-flight run (and its trailing rerun) for `key` settles. Test helper. */
  async idle(key: string): Promise<void> {
    for (;;) {
      const state = this.states.get(key);
      if (!state) return;
      if (state.inFlight) {
        await state.inFlight;
        continue;
      }
      if (state.timer) {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      return;
    }
  }

  /** Drop any queued run for `key`. An in-flight run completes but won't rerun. */
  cancel(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.rerun = false;
    state.rerunImmediate = false;
    state.firstRequestedAt = null;
    if (!state.inFlight) this.states.delete(key);
  }

  cancelAll(): void {
    for (const key of Array.from(this.states.keys())) this.cancel(key);
  }

  private fire(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.timer = null;
    state.firstRequestedAt = null;
    const run = (async () => {
      try {
        await this.runFn(key);
      } catch (err) {
        this.onError?.(key, err);
      }
    })();
    state.inFlight = run;
    void run.then(() => {
      state.inFlight = null;
      if (this.states.get(key) !== state) return;
      if (state.rerun) {
        const immediate = state.rerunImmediate;
        state.rerun = false;
        state.rerunImmediate = false;
        this.schedule(key, { immediate });
      } else if (!state.timer) {
        this.states.delete(key);
      }
    });
  }
}
