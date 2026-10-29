import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateChatSearch } from "@/routes/_app/projects/$projectId/chats/-search";

// Spaces were removed: every chat lives at the chats route. Keep the old path
// as a permanent redirect so old tabs, bookmarks and push links still open the
// chat.
export const Route = createFileRoute("/_app/projects/$projectId/spaces/$spaceId/$chatId")({
  validateSearch: validateChatSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/projects/$projectId/chats/$chatId",
      params: { projectId: params.projectId, chatId: params.chatId },
      search,
    });
  },
});
