import { createFileRoute } from "@tanstack/react-router";

// Matches /settings/<section> so the parent route's redirect runs for it.
export const Route = createFileRoute("/_app/settings/$")({});
