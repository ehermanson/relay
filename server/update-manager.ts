import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "#core/logger.js";
import type {
  UpdateCommit,
  UpdateInstallResult,
  UpdateSnapshot,
  UpdateStage,
} from "#core/types.js";

const execFileAsync = promisify(execFile);
const CHECK_TTL_MS = 5 * 60 * 1000;
const MAX_INCOMING_COMMITS = 20;

export interface UpdateManagerOptions {
  installDir: string;
  currentVersion: string;
  logger: Logger;
  requestRestart: () => void;
  restartSupported?: boolean;
}

interface GitTarget {
  pullSource: string;
  checkSource: string;
  branch: string;
}

export class UpdateManager {
  private installDir: string;
  private logger: Logger;
  private requestRestart: () => void;
  private snapshot: UpdateSnapshot;
  private checkPromise: Promise<UpdateSnapshot> | null;
  private installPromise: Promise<UpdateInstallResult> | null;
  private gitTarget: GitTarget | null;
  private forceAvailable: boolean;
  private devMode: boolean;
  private restartSupported: boolean;

  constructor(options: UpdateManagerOptions) {
    this.installDir = options.installDir;
    this.logger = options.logger;
    this.requestRestart = options.requestRestart;
    this.snapshot = {
      enabled: false,
      installAction: "restart",
      status: "unavailable",
      stage: null,
      currentVersion: options.currentVersion,
      currentCommit: null,
      latestCommit: null,
      incomingCommits: [],
      incomingCommitCount: 0,
      updateAvailable: false,
      checkedAt: null,
      error: null,
    };
    this.checkPromise = null;
    this.installPromise = null;
    this.gitTarget = null;
    this.devMode = process.env.DEV === "1";
    this.forceAvailable = process.env.RELAY_UPDATE_FORCE_AVAILABLE === "1";
    this.restartSupported = options.restartSupported ?? true;
  }

  async init(): Promise<void> {
    if (!this.restartSupported) {
      this.snapshot = {
        ...this.snapshot,
        enabled: false,
        status: "unavailable",
        error: "Updates are only available when Relay is launched via the CLI.",
      };
      return;
    }

    if (this.devMode) {
      this.snapshot = {
        ...this.snapshot,
        enabled: false,
        status: "unavailable",
        error: "Updates are only available in production installs.",
      };
      return;
    }

    const gitTarget = await this.resolveGitTarget();
    const currentCommit = gitTarget ? await this.resolveCurrentCommit() : null;
    this.gitTarget = gitTarget;
    this.snapshot = {
      ...this.snapshot,
      enabled: gitTarget !== null,
      status: gitTarget ? "idle" : "unavailable",
      currentCommit,
      error: gitTarget ? null : "Updates are only available for git-based Relay installs.",
    };
  }

  getSnapshot(): UpdateSnapshot {
    return { ...this.snapshot };
  }

  async checkForUpdates(options: { force?: boolean } = {}): Promise<UpdateSnapshot> {
    if (!this.snapshot.enabled || !this.gitTarget) {
      return this.getSnapshot();
    }
    if (this.snapshot.status === "updating" || this.snapshot.status === "restart_pending") {
      return this.getSnapshot();
    }
    if (
      !options.force &&
      this.snapshot.checkedAt &&
      Date.now() - this.snapshot.checkedAt < CHECK_TTL_MS
    ) {
      return this.getSnapshot();
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }

    this.snapshot = {
      ...this.snapshot,
      status: "checking",
      stage: null,
      error: null,
    };

    const checkPromise = this.runCheck();
    this.checkPromise = checkPromise;
    try {
      return await checkPromise;
    } finally {
      if (this.checkPromise === checkPromise) {
        this.checkPromise = null;
      }
    }
  }

  async installUpdate(): Promise<UpdateInstallResult> {
    if (!this.snapshot.enabled || !this.gitTarget) {
      return {
        ok: false,
        action: "restart",
        error: "Updates are unavailable for this Relay checkout.",
      };
    }
    if (this.snapshot.status === "updating" || this.snapshot.status === "restart_pending") {
      return { ok: true, action: "restart" };
    }
    if (this.installPromise) {
      return this.installPromise;
    }

    const installPromise = this.runInstall();
    this.installPromise = installPromise;
    try {
      return await installPromise;
    } finally {
      if (this.installPromise === installPromise) {
        this.installPromise = null;
      }
    }
  }

  private async runCheck(): Promise<UpdateSnapshot> {
    if (!this.gitTarget) {
      return this.getSnapshot();
    }

    try {
      const [currentCommit, latestCommit] = await Promise.all([
        this.resolveCurrentCommit(),
        this.resolveRemoteCommit(this.gitTarget),
      ]);
      if (latestCommit) {
        await this.ensureCommitLocal(latestCommit.trim(), this.gitTarget);
      }
      const isBehind =
        !!currentCommit &&
        !!latestCommit &&
        currentCommit.trim() !== latestCommit.trim() &&
        (await this.isCommitAncestor(currentCommit.trim(), latestCommit.trim()));
      const updateAvailable = this.forceAvailable || isBehind;
      const incoming =
        isBehind && currentCommit && latestCommit
          ? await this.resolveIncomingCommits(currentCommit.trim(), latestCommit.trim())
          : { commits: [], count: 0 };
      this.snapshot = {
        ...this.snapshot,
        currentCommit,
        latestCommit: latestCommit ?? currentCommit,
        incomingCommits: incoming.commits,
        incomingCommitCount: incoming.count,
        updateAvailable,
        status: updateAvailable ? "available" : "up_to_date",
        stage: null,
        checkedAt: Date.now(),
        error: null,
      };
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        status: "error",
        stage: null,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return this.getSnapshot();
  }

  private async runInstall(): Promise<UpdateInstallResult> {
    const snapshot = this.snapshot.updateAvailable
      ? this.snapshot
      : await this.checkForUpdates({ force: true });
    if ((!snapshot.updateAvailable && !this.forceAvailable) || !this.gitTarget) {
      return { ok: false, action: "restart", error: "Relay is already up to date." };
    }

    this.setStage("pulling");

    try {
      const stashed = await this.stashLocalChanges();
      try {
        await this.execGit(["pull", "--ff-only", this.gitTarget.pullSource, this.gitTarget.branch]);
      } finally {
        if (stashed) await this.popStash();
      }
      this.setStage("installing");
      await this.execPnpm(["install", "--frozen-lockfile"], true);
      this.setStage("building");
      await this.execPnpm(["build"]);

      const currentCommit = await this.resolveCurrentCommit();
      this.snapshot = {
        ...this.snapshot,
        currentCommit,
        latestCommit: currentCommit,
        incomingCommits: [],
        incomingCommitCount: 0,
        updateAvailable: false,
        checkedAt: Date.now(),
        status: "restart_pending",
        stage: "restarting",
        error: null,
      };

      setTimeout(() => {
        try {
          this.requestRestart();
        } catch (error) {
          this.logger.error(
            "[Relay] Failed to request restart after update:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }, 150);

      return { ok: true, action: "restart" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot = {
        ...this.snapshot,
        status: "error",
        stage: null,
        checkedAt: Date.now(),
        error: message,
      };
      return { ok: false, action: "restart", error: message };
    }
  }

  private setStage(stage: UpdateStage): void {
    this.snapshot = {
      ...this.snapshot,
      status: stage === "restarting" ? "restart_pending" : "updating",
      stage,
      error: null,
    };
  }

  private async resolveGitTarget(): Promise<GitTarget | null> {
    try {
      const overrideSource = process.env.RELAY_UPDATE_REMOTE?.trim();
      const overrideBranch = process.env.RELAY_UPDATE_BRANCH?.trim() || "main";
      if (overrideSource) {
        return {
          pullSource: overrideSource,
          checkSource: overrideSource,
          branch: overrideBranch,
        };
      }

      const remotes = await this.execGit(["remote"]);
      const remoteNames = remotes
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const remoteName = remoteNames.includes("origin") ? "origin" : (remoteNames[0] ?? null);
      if (!remoteName) return null;
      const remoteUrl = await this.execGit(["remote", "get-url", remoteName]);
      if (!/github\.com[:/]ehermanson\/relay(\.git)?$/i.test(remoteUrl.trim())) {
        return null;
      }
      return {
        pullSource: remoteName,
        checkSource: remoteUrl.trim(),
        branch: "main",
      };
    } catch {
      return null;
    }
  }

  /** Stash local changes if any. Returns true if a stash was created. */
  private async stashLocalChanges(): Promise<boolean> {
    const status = await this.execGit(["status", "--porcelain"]);
    if (!status.trim()) return false;
    await this.execGit([
      "stash",
      "push",
      "--include-untracked",
      "--message",
      "relay-update-autostash",
    ]);
    return true;
  }

  /** Pop the most recent stash. Errors are logged but not re-thrown — the update already succeeded. */
  private async popStash(): Promise<void> {
    try {
      await this.execGit(["stash", "pop"]);
    } catch (error) {
      this.logger.warn(
        "[Relay] Could not restore stashed local changes after update:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async resolveCurrentCommit(): Promise<string | null> {
    try {
      return (await this.execGit(["rev-parse", "HEAD"])).trim();
    } catch {
      return null;
    }
  }

  private async resolveRemoteCommit(target: GitTarget): Promise<string> {
    const output = await this.execGit([
      "ls-remote",
      target.checkSource,
      `refs/heads/${target.branch}`,
    ]);
    const match = /^([0-9a-f]{40})\s+/i.exec(output.trim());
    if (!match) {
      throw new Error("Failed to resolve the latest Relay commit from GitHub.");
    }
    return match[1];
  }

  /**
   * Subjects of the commits an update would pull in. Best effort: the check
   * already fetched `targetCommit`, but a failed fetch just means no list.
   */
  private async resolveIncomingCommits(
    localCommit: string,
    targetCommit: string,
  ): Promise<{ commits: UpdateCommit[]; count: number }> {
    try {
      const range = `${localCommit}..${targetCommit}`;
      const [countOutput, logOutput] = await Promise.all([
        this.execGit(["rev-list", "--count", range]),
        this.execGit(["log", `--max-count=${MAX_INCOMING_COMMITS}`, "--format=%H%x1f%s", range]),
      ]);
      const commits = logOutput
        .split("\n")
        .map((line) => line.split("\x1f"))
        .filter(([commit, subject]) => commit && subject !== undefined)
        .map(([commit, subject]) => ({ commit, subject }));
      const count = Number.parseInt(countOutput, 10);
      return { commits, count: Number.isFinite(count) ? count : commits.length };
    } catch (error) {
      this.logger.debug(
        "[Relay] update check could not read incoming commits:",
        error instanceof Error ? error.message : String(error),
      );
      return { commits: [], count: 0 };
    }
  }

  private async isCommitAncestor(localCommit: string, targetCommit: string): Promise<boolean> {
    try {
      await this.execGit(["merge-base", "--is-ancestor", localCommit, targetCommit]);
      return true;
    } catch {
      return false;
    }
  }

  private async hasCommitLocally(commit: string): Promise<boolean> {
    try {
      await this.execGit(["cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureCommitLocal(commit: string, target: GitTarget): Promise<void> {
    if (await this.hasCommitLocally(commit)) return;
    try {
      await this.execGit(["fetch", "--no-tags", "--quiet", target.pullSource, target.branch]);
    } catch (error) {
      this.logger.debug(
        "[Relay] update check fetch failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.installDir,
      encoding: "utf8",
      timeout: 30_000,
    });
    return stdout.trim();
  }

  private async execPnpm(args: string[], allowFallback = false): Promise<void> {
    try {
      await execFileAsync("pnpm", args, {
        cwd: this.installDir,
        encoding: "utf8",
        timeout: 10 * 60 * 1000,
      });
    } catch (error) {
      if (!allowFallback) {
        throw this.toExecError(error);
      }
      await execFileAsync("pnpm", ["install"], {
        cwd: this.installDir,
        encoding: "utf8",
        timeout: 10 * 60 * 1000,
      });
    }
  }

  private toExecError(error: unknown): Error {
    if (!(error instanceof Error)) {
      return new Error(String(error));
    }
    const cause = error as Error & { stdout?: string; stderr?: string };
    const detail = [cause.message, cause.stderr, cause.stdout].filter(Boolean).join("\n").trim();
    return new Error(detail || "Command failed");
  }
}
