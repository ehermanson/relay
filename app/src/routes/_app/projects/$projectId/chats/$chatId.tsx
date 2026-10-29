import { createFileRoute, useSearch } from "@tanstack/react-router";
import { InstanceView } from "@/components/chat/instance-view";
import { SplitChatView } from "@/components/chat/split-chat-view";
import { useMediaQuery } from "@/hooks/use-media-query";
import { validateChatSearch } from "@/routes/_app/projects/$projectId/chats/-search";

function ChatRoute() {
  const { split } = useSearch({ from: "/_app/projects/$projectId/chats/$chatId" });
  const isMobile = useMediaQuery("(max-width: 768px)");

  if (split && !isMobile) {
    return <SplitChatView splitId={split} />;
  }

  return <InstanceView />;
}

export const Route = createFileRoute("/_app/projects/$projectId/chats/$chatId")({
  component: ChatRoute,
  validateSearch: validateChatSearch,
});
