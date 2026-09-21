import type { ActivityMessage } from "#core/types.js";
import { capDetail } from "#core/tools.js";

/** Preserve freeform custom-tool input as well as JSON function arguments. */
export function buildCodexGenericToolUse(name: string, raw: unknown): ActivityMessage {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Code-mode exec input is JavaScript, not JSON.
    }
  }
  const code = name === "exec" && typeof raw === "string" ? raw : undefined;
  const input =
    code !== undefined
      ? { code }
      : parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : raw == null
          ? {}
          : { input: raw };
  return {
    type: "activity",
    activity: "tool_use",
    tool: code !== undefined ? "ExecuteCode" : name,
    description: code !== undefined ? "Run code" : `Using ${name}`,
    input,
  };
}

/** Transcript custom outputs and app-server contentItems can be block arrays. */
export function extractCodexToolOutput(output: unknown): string {
  if (typeof output === "string") return capDetail(output);
  if (!Array.isArray(output)) return "";
  return capDetail(
    output
      .flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const { type, text } = block as Record<string, unknown>;
        return (type === "text" ||
          type === "input_text" ||
          type === "output_text" ||
          type == null) &&
          typeof text === "string"
          ? [text]
          : [];
      })
      .join("\n"),
  );
}
