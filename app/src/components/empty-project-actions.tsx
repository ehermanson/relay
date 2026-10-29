import { MessageSquare } from "lucide-react";
import { Button } from "./ui/button";

interface EmptyProjectActionsProps {
  onNewChat: () => void;
  size?: "default" | "compact";
}

export function EmptyProjectActions({ onNewChat, size = "default" }: EmptyProjectActionsProps) {
  if (size === "compact") {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewChat}
          className="flex-1 text-[0.6875rem] border border-border bg-bg hover:border-border-bright"
        >
          <MessageSquare size={11} />
          New Chat
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="lg"
        onClick={onNewChat}
        className="flex-1 border border-border bg-bg hover:border-border-bright"
      >
        <MessageSquare size={14} />
        New Chat
      </Button>
    </div>
  );
}
