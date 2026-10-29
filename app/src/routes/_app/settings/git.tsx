import { createFileRoute, redirect } from "@tanstack/react-router";

// The Git settings page held only the default Space branch, removed with
// Spaces. Keep the old path as a redirect so bookmarks land on General.
export const Route = createFileRoute("/_app/settings/git")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general" });
  },
});
