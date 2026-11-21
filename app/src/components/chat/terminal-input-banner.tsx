import { getProviderDisplayName } from "@shared/provider-catalog";
import { useState } from "react";
import { Terminal } from "lucide-react";
import type { ProviderKind, ProviderRequest } from "@shared/types";
import { Button } from "../ui/button";

export function TerminalInputBanner({
  provider,
  request,
  onRespond,
}: {
  provider: ProviderKind;
  request: ProviderRequest;
  onRespond: (
    requestId: string,
    tool: string,
    decision?: "accept" | "decline",
    text?: string,
  ) => void;
}) {
  const [value, setValue] = useState("");
  const tool = request.tool ?? "Bash";
  const prompt = request.prompt ?? request.description ?? "Command is waiting for input";
  const command = request.command;

  return (
    <div className="shrink-0 border-t border-warning/25 bg-warning/5">
      <div className="mx-auto max-w-3xl px-6 py-3">
        <div className="animate-fade-in rounded-xl border border-warning/25 bg-surface/90 px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/15">
              <Terminal size={16} className="text-warning" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[0.8125rem] font-medium text-text-bright">
                {provider === "claude" ? "Agent" : getProviderDisplayName(provider)} needs terminal
                input
              </p>
              <p className="mt-0.5 text-[0.75rem] text-muted">{prompt}</p>
              {command ? (
                <pre className="mt-2 overflow-x-auto rounded-lg border border-border/70 bg-panel px-3 py-2 text-[0.75rem] text-text">
                  {command}
                </pre>
              ) : null}
              <textarea
                value={value}
                onChange={(event) => setValue(event.target.value)}
                rows={3}
                placeholder="Type input to send to the running command"
                className="mt-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-[0.8125rem] text-text placeholder:text-muted focus:border-warning/50 focus:outline-none"
              />
              <div className="mt-3 flex items-center gap-2">
                <Button
                  variant="primary"
                  onClick={() => onRespond(request.requestId, tool, "accept", value)}
                  disabled={!value.trim()}
                >
                  Send Input
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => onRespond(request.requestId, tool, "decline")}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
