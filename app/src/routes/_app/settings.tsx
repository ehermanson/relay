import {
  createFileRoute,
  Outlet,
  Link,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Settings2, Cpu, GitBranch, Sparkles, ChevronLeft, ChevronRight } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { MobileSidebarToggle } from "@/components/ui/view-header";

const NAV_ITEMS = [
  {
    to: "/settings/general",
    label: "General",
    description: "Appearance and default behaviors",
    icon: Settings2,
  },
  {
    to: "/settings/providers",
    label: "Providers",
    description: "AI provider configuration",
    icon: Cpu,
  },
  { to: "/settings/git", label: "Git", description: "Version control settings", icon: GitBranch },
  {
    to: "/settings/suggestions",
    label: "Suggestions",
    description: "Prompt suggestions for new chats",
    icon: Sparkles,
  },
] as const;

function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 768px)");

  const isRoot = location.pathname === "/settings" || location.pathname === "/settings/";
  const activeItem = NAV_ITEMS.find((item) => location.pathname === item.to);

  // ── Mobile: single-column nav → content flow ────────────────────
  if (isMobile) {
    if (isRoot) {
      return (
        <div className="flex h-full flex-1 flex-col overflow-y-auto">
          <div className="flex items-center gap-2 px-2 pb-2 pt-3">
            <MobileSidebarToggle />
            <h1 className="text-lg font-bold text-text-bright">Settings</h1>
          </div>
          <ul className="px-2 pb-6">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-text transition-colors hover:bg-surface-hover"
                  >
                    <Icon size={18} className="shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[0.875rem] font-medium">{item.label}</div>
                      <div className="text-[0.75rem] text-muted">{item.description}</div>
                    </div>
                    <ChevronRight size={16} className="shrink-0 text-muted/50" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2 py-2">
          <button
            type="button"
            onClick={() => void navigate({ to: "/settings" })}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <ChevronLeft size={20} strokeWidth={2} />
          </button>
          <span className="text-[0.875rem] font-semibold text-text-bright">
            {activeItem?.label ?? "Settings"}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-5">
            <Outlet />
          </div>
        </div>
      </div>
    );
  }

  // ── Desktop: two-column layout ──────────────────────────────────
  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <nav className="w-44 shrink-0 overflow-y-auto border-r border-border px-3 py-6">
        <h1 className="desktop-window-header mb-5 px-2 text-lg font-bold text-text-bright">
          Settings
        </h1>
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = location.pathname === item.to;
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[0.8125rem] font-medium transition-colors ${
                    active
                      ? "bg-accent/10 text-accent"
                      : "text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <Icon size={15} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
  beforeLoad: ({ location }) => {
    // On desktop, redirect /settings to /settings/general.
    // On mobile, /settings shows the nav list — skip redirect.
    // SSR / beforeLoad doesn't have window, so check context or default to redirecting.
    const isMobile =
      typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;
    if (!isMobile && (location.pathname === "/settings" || location.pathname === "/settings/")) {
      throw redirect({ to: "/settings/general" });
    }
  },
});
