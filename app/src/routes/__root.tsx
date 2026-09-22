import { createRootRoute, Outlet, useRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { AuthProvider } from "../context/auth-context";
import { DevTools } from "../components/dev-tools";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// Queries whose last-known data is safe to restore on the next load. Scoped to
// the read-mostly metadata the entry screens render (projects, chat summaries,
// stats, icons) so the landing page paints complete immediately and refetches
// in the background instead of cascading skeletons on every visit.
const PERSISTED_QUERY_KEYS = new Set([
  "projects",
  "projectChats",
  "projectArtifacts",
  "projectIcons",
  "global-settings",
  "spaces",
]);

const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: "relay:query-cache",
});

const persistOptions = {
  persister,
  maxAge: 24 * 60 * 60 * 1000,
  // Bump when the shape of persisted query data changes incompatibly.
  // v2: global-settings gained `sidebarLayout` and chat summaries gained
  // `doneAt`. A cache without them paints the Projects sidebar first and
  // snaps to Inbox once the refetch lands.
  // v3: Inbox is now the default layout. Caches from v2 hold the old server's
  // null→"projects" normalization, which would flash Projects before the
  // refetch corrects it — clearing them lets first paint use the new default.
  // v4: Task records gained revision, archive, and closure metadata. Old
  // Project artifact caches must not seed edits without an expected revision.
  buster: "v4",
  dehydrateOptions: {
    // Structurally typed (not `Query`) to avoid nominal-type clashes between
    // the query-core copies hoisted by react-query vs the persist packages.
    shouldDehydrateQuery: (query: { state: { status: string }; queryKey: readonly unknown[] }) =>
      query.state.status === "success" && PERSISTED_QUERY_KEYS.has(String(query.queryKey[0])),
  },
};

function RootErrorComponent({ error }: { error: Error }) {
  const router = useRouter();

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-surface p-8 text-center">
      <AlertTriangle size={32} className="text-warning" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-text">Something went wrong</p>
        <p className="max-w-md text-xs text-muted">{error.message}</p>
      </div>
      <button
        type="button"
        onClick={() => router.invalidate()}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
      >
        <RotateCcw size={12} />
        Try again
      </button>
    </div>
  );
}

function RootComponent() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <AuthProvider>
        <Outlet />
        {import.meta.env.DEV ? <DevTools /> : null}
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}

export const Route = createRootRoute({
  errorComponent: RootErrorComponent,
  component: RootComponent,
});
