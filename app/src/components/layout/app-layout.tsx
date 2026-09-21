import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { InboxSidebar } from "@/components/layout/inbox-sidebar";
import { MiniSidebar } from "@/components/layout/mini-sidebar";
import { Sidebar } from "@/components/layout/sidebar";
import { NoProvidersLanding } from "@/components/no-providers-landing";
import { ProviderUpdateNotification } from "@/components/provider-update-notification";
import { SearchDialog, useSearchDialog } from "@/components/search-dialog";
import { RelayLogo } from "@/components/ui/relay-logo";
import { SwipeableDrawer } from "@/components/ui/swipeable-drawer";
import { useAvailableProviders } from "@/hooks/use-available-providers";
import { useSidebarLayout } from "@/hooks/use-global-settings";
import { useTheme } from "@/stores/theme-store";
import { useLayoutStore } from "@/stores/layout-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useWSState } from "@/context/websocket-context";

export function AppLayout() {
  const search = useSearchDialog();
  const { providers, isLoading: providersLoading } = useAvailableProviders();
  const location = useLocation();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const sidebarLayout = useSidebarLayout();
  const SidebarComponent = sidebarLayout === "inbox" ? InboxSidebar : Sidebar;
  const { isConnected } = useWSState();
  const { theme } = useTheme();
  const {
    sidebarCollapsed: collapsed,
    sidebarWidth: storedWidth,
    mobileSidebarOpen,
    toggleSidebar: toggleCollapsed,
    setSidebarWidth: setStoredWidth,
    setMobileSidebarOpen,
    persistWidth,
  } = useLayoutStore();

  const {
    panelRef: sidebarRef,
    isResizing,
    onResizeStart,
    width: dragWidth,
  } = useResizablePanel({
    side: "left",
    minWidth: 200,
    maxWidth: 500,
    defaultWidth: storedWidth,
    onResizeEnd: (w) => {
      setStoredWidth(w);
      // persistWidth reads from store; zustand set is sync so this is safe
      persistWidth();
    },
  });

  const sidebarWidth = dragWidth ?? storedWidth;

  // Delay content swap until after the collapse animation finishes
  const [showMini, setShowMini] = useState(collapsed);
  useEffect(() => {
    if (collapsed) {
      // Wait for the width transition to finish before swapping to MiniSidebar
      const timer = setTimeout(() => setShowMini(true), 200);
      return () => clearTimeout(timer);
    } else {
      // When expanding, show the full sidebar immediately
      setShowMini(false);
    }
  }, [collapsed]);

  // Auto-close mobile sidebar overlay on navigation
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname, setMobileSidebarOpen]);

  // Close mobile sidebar overlay on Escape
  useEffect(() => {
    if (!isMobile || !mobileSidebarOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, mobileSidebarOpen, setMobileSidebarOpen]);

  const toaster = (
    <Toaster
      position="bottom-right"
      theme={theme}
      toastOptions={{
        style: {
          fontFamily: "var(--font-sans)",
          background: "var(--color-glass)",
          border: "1px solid var(--color-glass-border)",
          color: "var(--color-text)",
          backdropFilter: "blur(20px) saturate(1.4)",
          WebkitBackdropFilter: "blur(20px) saturate(1.4)",
        },
      }}
    />
  );

  if (!providersLoading && providers.length === 0) {
    return <NoProvidersLanding />;
  }

  if (isMobile) {
    return (
      <div className="app-shell">
        <div className="app-shell-inner">
          <main className="app-shell-content flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
            <Outlet />
          </main>
        </div>
        {/* Mobile sidebar overlay — edge-swipe from the left opens it,
            swiping the panel left (or tapping the backdrop) dismisses. */}
        <SwipeableDrawer
          side="left"
          open={mobileSidebarOpen}
          onOpenChange={setMobileSidebarOpen}
          edgeSwipeOpen
          containerClassName="p-2 pt-[calc(var(--app-top-inset)+0.5rem)]"
          panelClassName="min-h-0 w-[85vw] max-w-sm"
        >
          <div className="app-shell-sidebar flex min-h-0 flex-1 flex-col">
            <SidebarComponent showLogo onSearchOpen={() => search.setOpen(true)} />
          </div>
        </SwipeableDrawer>
        <SearchDialog open={search.open} onOpenChange={search.setOpen} />
        {toaster}
        <ProviderUpdateNotification />
      </div>
    );
  }

  return (
    <>
      <div className="app-shell">
        <div className="app-shell-inner">
          {/* Animated sidebar container */}
          <div
            ref={sidebarRef}
            className={`app-shell-sidebar relative overflow-hidden ${isResizing ? "" : "transition-[width] duration-200 ease-in-out"}`}
            style={{ width: collapsed ? 48 : sidebarWidth }}
          >
            {showMini ? (
              <MiniSidebar onExpand={toggleCollapsed} />
            ) : (
              <SidebarComponent
                onCollapse={toggleCollapsed}
                onSearchOpen={() => search.setOpen(true)}
              />
            )}
            {/* Persistent logo – never unmounts, sits above both sidebars */}
            <Link
              to="/"
              className="absolute left-0.5 top-1 z-20 flex w-12 items-center justify-center pt-2.5 transition-opacity hover:opacity-80"
            >
              <RelayLogo size={28} connected={isConnected} />
            </Link>
            {/* Resize handle – only when expanded */}
            {!collapsed && (
              <div
                onMouseDown={onResizeStart}
                className="absolute inset-y-0 right-0 z-10 w-px cursor-col-resize bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 after:content-['']"
              />
            )}
          </div>
          <main className="app-shell-content flex h-full flex-col overflow-hidden bg-bg">
            <Outlet />
          </main>
        </div>
      </div>
      <SearchDialog open={search.open} onOpenChange={search.setOpen} />
      {toaster}
      <ProviderUpdateNotification />
    </>
  );
}
