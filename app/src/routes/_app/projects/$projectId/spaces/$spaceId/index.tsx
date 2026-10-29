import { createFileRoute, redirect } from "@tanstack/react-router";

// Spaces were removed. Keep the old path as a permanent redirect so old
// tabs/bookmarks land on the project's Overview.
export const Route = createFileRoute("/_app/projects/$projectId/spaces/$spaceId/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/projects/$projectId", params: { projectId: params.projectId } });
  },
});
