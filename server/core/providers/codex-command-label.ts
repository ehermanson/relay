/** Codex command metadata is advisory; the full command remains in activity input. */
interface CodexCommandAction {
  type: string;
  command?: string;
  cmd?: string;
  name?: string;
  path?: string | null;
  query?: string | null;
}

function compact(text: string, limit = 60): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

function basename(path: string): string {
  return path.replace(/\/$/, "").split("/").pop() || path;
}

/** A conservative lexical pass, never shell evaluation. Unsupported syntax gets a generic label. */
function commandWords(command: string): string[][] | undefined {
  if (command.length > 50_000 || /<<|`|\$\(/.test(command)) return undefined;
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  const flushWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const flushCommand = () => {
    flushWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      if (i + 1 >= command.length) return undefined;
      const next = command[++i];
      if (next !== "\n") {
        word += next;
        started = true;
      }
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (
      char === "&" &&
      (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")
    ) {
      word += char;
      started = true;
    } else if (/[;|&\n]/.test(char)) {
      flushCommand();
    } else if (/\s/.test(char)) {
      flushWord();
    } else {
      started = true;
      word += char;
    }
  }
  if (quote) return undefined;
  flushCommand();
  return commands;
}

const GIT_LABELS: Record<string, string> = {
  status: "Check Git status",
  diff: "Inspect changes",
  log: "View commit history",
  show: "Inspect commit",
  add: "Stage changes",
  commit: "Commit changes",
  push: "Push changes",
  pull: "Pull changes",
  fetch: "Fetch changes",
  branch: "Manage branches",
  checkout: "Check out branch or files",
  switch: "Switch branches",
  merge: "Merge changes",
  rebase: "Rebase changes",
  stash: "Manage stashed changes",
  reset: "Reset Git state",
  restore: "Restore files",
  worktree: "Manage worktrees",
};

function summarizeWords(words: string[], depth: number): string[] {
  if (depth >= 4) return ["Run shell command"];
  let i = 0;
  if (basename(words[i] || "") === "env") i++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] || "")) i++;
  const executable = basename(words[i++] || "");
  const args = words.slice(i);
  if (["sh", "bash", "zsh", "dash", "fish"].includes(executable)) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag >= 0 && args[flag + 1] && depth < 3) return fallbackLabels(args[flag + 1], depth + 1);
    return ["Run shell script"];
  }
  if (executable === "git") {
    let index = 0;
    while (args[index]?.startsWith("-")) {
      const option = args[index++];
      if (option === "-C" || option === "-c" || option === "--git-dir" || option === "--work-tree")
        index++;
      else if (
        !["--no-pager", "--paginate", "--literal-pathspecs"].includes(option) &&
        !/^--(?:git-dir|work-tree)=/.test(option)
      )
        return ["Run Git command"];
    }
    return [GIT_LABELS[args[index]] || "Run Git command"];
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const task = args[0] === "run" ? args[1] : args[0];
    if (task === "test" || task?.startsWith("test:")) return ["Run tests"];
    if (task === "build" || task?.startsWith("build:")) return ["Build project"];
    if (task === "typecheck" || task?.startsWith("typecheck:")) return ["Check types"];
    if (task === "lint" || task?.startsWith("lint:")) return ["Run lint checks"];
    if (["install", "ci", "add"].includes(task)) return ["Install dependencies"];
    if (task === "exec" && args[1]) return summarizeWords(args.slice(1), depth + 1);
    return ["Run package command"];
  }
  if (["node", "nodejs"].includes(executable))
    return [
      args.includes("--test") || args.some((arg) => /(?:^|\/)vitest(?:\.mjs)?$/.test(arg))
        ? "Run tests"
        : "Run JavaScript",
    ];
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) return ["Run Python script"];
  if (["vitest", "jest", "pytest"].includes(executable)) return ["Run tests"];
  if (["rg", "grep", "egrep", "fgrep"].includes(executable))
    return [args.includes("--files") ? "List files" : "Search files"];
  if (["ls", "find", "fd"].includes(executable)) return ["List files"];
  if (["cat", "head", "tail", "less", "more"].includes(executable)) return ["Read files"];
  if (executable === "sed")
    return [
      args.some((arg) => /^-[^-]*i/.test(arg) || arg.startsWith("--in-place"))
        ? "Edit files"
        : "Read files",
    ];
  if (executable === "pwd") return ["Show working directory"];
  if (executable === "cd") return ["Change directory"];
  return ["Run shell command"];
}

function fallbackLabels(command: string, depth = 0): string[] {
  const commands = commandWords(command);
  return commands?.length
    ? commands.flatMap((words) => summarizeWords(words, depth))
    : ["Run shell script"];
}

/** Both app-server commandActions and rollout parsed_cmd use these action shapes. */
export function describeCodexCommand(command: string, actions?: unknown): string {
  const labels =
    Array.isArray(actions) && actions.length
      ? actions.flatMap((raw): string[] => {
          if (!raw || typeof raw !== "object") return fallbackLabels(command);
          const action = raw as CodexCommandAction;
          if (action.type === "read") {
            const name = typeof action.name === "string" ? action.name : action.path;
            if (typeof name === "string" && name) return [`Read ${compact(basename(name))}`];
          }
          if (action.type === "listFiles" || action.type === "list_files")
            return [
              typeof action.path === "string" && action.path
                ? `List files in ${compact(action.path)}`
                : "List files",
            ];
          if (action.type === "search")
            return [
              typeof action.query === "string" && action.query
                ? `Search for “${compact(action.query, 45)}”`
                : "Search files",
            ];
          return fallbackLabels(
            typeof action.command === "string"
              ? action.command
              : typeof action.cmd === "string"
                ? action.cmd
                : command,
          );
        })
      : fallbackLabels(command);
  const unique = [...new Set(labels)];
  const visible = unique.slice(0, 2).join(" · ");
  return unique.length > 2 ? `${visible} (+${unique.length - 2} more)` : visible;
}
