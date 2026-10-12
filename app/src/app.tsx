import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const router = createRouter({
  routeTree,
  defaultPendingMs: 150,
  defaultPendingMinMs: 200,
});

export function getRouterMemoryStats() {
  return {
    cachedMatches: router.stores.cachedMatchesSnapshot.state.length,
    activeMatches: router.state.matches.length,
  };
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}
