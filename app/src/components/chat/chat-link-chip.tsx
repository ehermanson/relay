import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { useChatById } from "@/hooks/use-chat-by-id";
import { getInstanceChatRoute } from "@/lib/project-route";

/**
 * A `relay://chat/<id>` link: the chat's provider logo and live title,
 * opening it in its own Project chat route. An author-written label wins
 * over the title. Chats that aren't loaded (or were deleted) render inert.
 */
export function ChatLinkChip({
  chatId,
  label,
  className,
}: {
  chatId: string;
  label?: string;
  className: string;
}) {
  const chat = useChatById(chatId);
  if (!chat) {
    return (
      <span className={className} title="Chat not available">
        <MessageSquare size={12} className="h-3 w-3 shrink-0 text-muted" />
        <span className="max-w-[16rem] truncate">{label ?? "Unknown chat"}</span>
      </span>
    );
  }
  const route = getInstanceChatRoute(chat);
  return (
    <Link to={route.to} params={route.params} className={className} title={chat.name}>
      <ProviderLogo provider={chat.provider} className="h-3 w-3 shrink-0" />
      <span className="max-w-[16rem] truncate">{label ?? chat.name}</span>
    </Link>
  );
}
