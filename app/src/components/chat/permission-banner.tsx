import { useState } from "react";
import { Lock, X } from "lucide-react";
import type { ProviderKind, ProviderRequest } from "@shared/types";
import { getProviderDisplayName } from "@shared/provider-catalog";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

const FILE_WRITE_GROUP = ["Edit", "Write", "NotebookEdit"];

function getProviderLabel(provider: ProviderKind): string {
  return getProviderDisplayName(provider);
}

function getPermissionLabel(provider: ProviderKind, tool: string, agentId?: string): string {
  const label = agentId ? `Agent ${agentId}` : getProviderLabel(provider);
  if (FILE_WRITE_GROUP.includes(tool)) return `${label} needs permission to edit files`;
  if (tool === "Bash") return `${label} needs permission to run commands`;
  return `${label} needs permission to use ${tool}`;
}

export function PermissionBanner({
  provider,
  request,
  onRespond,
}: {
  provider: ProviderKind;
  request: ProviderRequest;
  onRespond: (requestId: string, tool: string, decision?: "accept" | "decline") => void;
}) {
  const [exiting, setExiting] = useState(false);
  const [gone, setGone] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<"accept" | "decline" | null>(null);

  const tool = request.tool ?? "Permissions";
  const detail =
    request.command ??
    request.reason ??
    request.description ??
    (request.files?.length ? request.files.join(", ") : undefined);

  if (gone) return null;

  const handleExit = () => {
    setExiting(true);
  };

  const handleApprove = () => {
    setPendingDecision("accept");
    setExiting(true);
  };

  const handleDecline = () => {
    setPendingDecision("decline");
    setExiting(true);
  };

  return (
    <div
      className={`shrink-0 overflow-hidden ${exiting ? "animate-fade-out-collapse" : "mb-2"}`}
      onAnimationEnd={() => {
        if (exiting) {
          setGone(true);
          if (pendingDecision) onRespond(request.requestId, tool, pendingDecision);
        }
      }}
    >
      <div className="mx-auto max-w-3xl px-6 max-[768px]:px-2">
        <div className="animate-fade-in flex items-center gap-3 rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 max-[768px]:gap-2 max-[768px]:px-3 max-[768px]:py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 max-[768px]:h-7 max-[768px]:w-7">
            <Lock size={16} className="text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[0.8125rem] font-medium text-text-bright">
              {getPermissionLabel(provider, tool, request.agentId)}
            </p>
            {detail && <p className="truncate text-[0.75rem] text-muted">{detail}</p>}
          </div>
          <Button
            variant="ghost"
            className="shrink-0 max-[768px]:h-10 max-[768px]:px-4"
            onClick={handleDecline}
          >
            Deny
          </Button>
          <Button
            variant="primary"
            className="shrink-0 max-[768px]:h-10 max-[768px]:px-4"
            onClick={handleApprove}
          >
            Allow
          </Button>
          <Tooltip content="Dismiss">
            <Button variant="icon" className="shrink-0 max-[768px]:hidden" onClick={handleExit}>
              <X size={14} />
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
