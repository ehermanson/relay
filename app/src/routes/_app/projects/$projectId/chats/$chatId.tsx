import { createFileRoute, isRedirect, redirect, useSearch } from "@tanstack/react-router";
import { InstanceView } from "@/components/chat/instance-view";
import { SplitChatView } from "@/components/chat/split-chat-view";
import { useImmersiveTopInset } from "@/hooks/use-immersive-top-inset";
import { useMediaQuery } from "@/hooks/use-media-query";
import { fetchInstanceSummary } from "@/lib/api";
import { getInstanceChatRoute } from "@/lib/project-route";
import { validateChatSearch } from "@/routes/_app/projects/$projectId/chats/-search";

function ChatRoute() {
  const { split } = useSearch({ from: "/_app/projects/$projectId/chats/$chatId" });
  const isMobile = useMediaQuery("(max-width: 768px)");
  // The chat header owns the top safe-area inset so iOS 26+ fills the top edge
  // solid instead of blurring the header. See use-immersive-top-inset.ts.
  useImmersiveTopInset();

  if (split && !isMobile) {
    return <SplitChatView splitId={split} />;
  }

  return <InstanceView />;
}

export const Route = createFileRoute("/_app/projects/$projectId/chats/$chatId")({
  loader: async ({ params }) => {
    try {
      const chat = await fetchInstanceSummary(params.chatId);
      if (chat?.spaceId) {
        throw redirect({
          ...getInstanceChatRoute(chat),
        });
      }
    } catch (err) {
      if (isRedirect(err)) throw err;
      // Fetch failed — don't block navigation, let the component handle it
    }
  },
  component: ChatRoute,
  validateSearch: validateChatSearch,
});
