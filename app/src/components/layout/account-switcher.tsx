/**
 * Top-level account switcher — the browser-profile-style control that decides
 * which account everything in view belongs to.
 *
 * Three surfaces share one menu: the pill at the top of the sidebar (both
 * layouts via `SidebarHeader`, which the mobile drawer hosts too), the
 * collapsed rail's avatar button, and the compact pill in the mobile Home
 * header. Renders nothing below two accounts, so a single-account install
 * never grows a control. Switching changes the per-browser choice, re-runs
 * route loaders, and leaves a project-scoped route (chat, space, project page)
 * for the app root so the previous account's chat can't stay open unlabelled;
 * it never boots anything.
 */

import { Check, ChevronDown, Settings2 } from "lucide-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useActiveAccount } from "@/hooks/use-active-account";
import { useInstalledProviders } from "@/hooks/use-available-providers";
import { ProviderLogo } from "@/components/ui/provider-logo";
import {
  accountLoginLine,
  accountLoginSummary,
  accountPrimaryIdentity,
} from "@/lib/account-identity";
import { accountInitial, isProjectScopedPath } from "@/lib/account-scope";
import { getProviderDisplayName } from "@shared/provider-catalog";
import type { AccountStatus, ProviderKind } from "@shared/types";

type AccountSwitcherVariant = "pill" | "rail" | "compact";

/** Tinted monogram — the account's visual identity on every surface. */
function AccountMonogram({
  label,
  active,
  size = 24,
}: {
  label: string;
  active: boolean;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.46)) }}
      className={`flex shrink-0 items-center justify-center rounded-md font-bold uppercase leading-none ${
        active ? "bg-accent/15 text-accent" : "bg-surface-hover text-text"
      }`}
    >
      {accountInitial(label)}
    </span>
  );
}

/**
 * The row's second line: provider logos plus one identity when every login is
 * the same person, otherwise a `logo who` pair per login. Logos carry the
 * provider; the text never repeats a provider name.
 */
function AccountLoginLineView({
  account,
  providerOrder,
}: {
  account: AccountStatus;
  providerOrder: ReadonlyArray<ProviderKind>;
}) {
  const line = accountLoginLine(account, providerOrder);
  if (line.shared !== null) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted">
        <span className="flex shrink-0 items-center gap-1">
          {line.providers.map((provider) => (
            <ProviderLogo key={provider} provider={provider} className="h-2.5 w-2.5" />
          ))}
        </span>
        <span className="min-w-0 truncate">{line.shared}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col gap-0.5 text-[0.6875rem] text-muted">
      {line.perLogin.map(({ provider, who }) => (
        <span key={provider} className="flex min-w-0 items-center gap-1.5">
          <ProviderLogo provider={provider} className="h-2.5 w-2.5 shrink-0" />
          <span className="min-w-0 truncate">{who}</span>
        </span>
      ))}
    </span>
  );
}

function AccountMenuItems({
  accounts,
  activeId,
  providerOrder,
  onSwitch,
  onManage,
}: {
  accounts: AccountStatus[];
  activeId: string;
  providerOrder: ReadonlyArray<ProviderKind>;
  onSwitch: (id: string) => void;
  onManage: () => void;
}) {
  return (
    <>
      {accounts.map((account) => {
        const isActive = account.id === activeId;
        return (
          <Menu.Item
            key={account.id}
            role="menuitemradio"
            aria-checked={isActive}
            onClick={() => onSwitch(account.id)}
            className="!items-start !py-2"
          >
            <AccountMonogram label={account.label} active={isActive} size={22} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[0.8125rem] font-medium text-text-bright">
                {account.label}
              </span>
              <AccountLoginLineView account={account} providerOrder={providerOrder} />
            </span>
            {isActive ? <Check size={13} className="mt-1 shrink-0 text-accent" /> : null}
          </Menu.Item>
        );
      })}
      <Menu.Separator />
      <Menu.Item onClick={onManage}>
        <Settings2 size={13} strokeWidth={2} className="text-muted" />
        Manage accounts…
      </Menu.Item>
    </>
  );
}

export function AccountSwitcher({
  variant = "pill",
  className = "",
}: {
  variant?: AccountSwitcherVariant;
  className?: string;
}) {
  const account = useActiveAccount();
  const router = useRouter();
  const navigate = useNavigate();
  // Labels and order come from the installed providers (unscoped: the menu
  // describes every account, not just the active one's providers).
  const { providers } = useInstalledProviders();
  if (!account.isMulti || !account.active) return null;

  const active = account.active;
  const providerOrder = providers.map((p) => p.provider);
  const providerLabel = (provider: ProviderKind) =>
    providers.find((p) => p.provider === provider)?.label ?? getProviderDisplayName(provider);
  // Tooltip text for the rail: the full per-provider summary in words.
  const identity = accountLoginSummary(active, providerLabel, providerOrder);
  // The pill is one narrow line: the first login's email identifies the
  // account, and each provider's identity is one click away in the menu.
  const pillIdentity = accountPrimaryIdentity(active, providerLabel, providerOrder);
  const ariaLabel = `Account: ${active.label}`;

  const switchTo = (id: string) => {
    if (id === account.activeId) return;
    account.setActiveId(id);
    // Anything under /projects/ shows the account just left (a chat's
    // composer would keep sending through it while the switcher says
    // otherwise), so leave for the app root. Home and Settings stay put.
    if (isProjectScopedPath(router.state.location.pathname)) {
      void navigate({ to: "/" });
    }
    // Route loaders (project artifacts) read the stored account; re-run them.
    void router.invalidate();
  };
  const manage = () => navigate({ to: "/settings/providers" });

  const items = (
    <AccountMenuItems
      accounts={account.accounts}
      activeId={account.activeId}
      providerOrder={providerOrder}
      onSwitch={switchTo}
      onManage={manage}
    />
  );

  if (variant === "rail") {
    return (
      <Menu.Root>
        <Tooltip content={`${active.label} · ${identity}`} side="right">
          <Menu.Trigger
            aria-label={ariaLabel}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-surface-hover ${className}`}
          >
            <AccountMonogram label={active.label} active size={22} />
          </Menu.Trigger>
        </Tooltip>
        <Menu.Content side="right" align="start" className="w-64">
          {items}
        </Menu.Content>
      </Menu.Root>
    );
  }

  if (variant === "compact") {
    return (
      <Menu.Root>
        <Menu.Trigger
          aria-label={ariaLabel}
          className={`flex min-h-10 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[0.75rem] font-medium text-text transition-colors hover:bg-surface-hover ${className}`}
        >
          <AccountMonogram label={active.label} active size={20} />
          <span className="max-w-28 truncate">{active.label}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </Menu.Trigger>
        <Menu.Content align="end" className="w-64 max-w-[calc(100vw-1.5rem)]">
          {items}
        </Menu.Content>
      </Menu.Root>
    );
  }

  return (
    <div className={`shrink-0 px-3 pb-2 ${className}`}>
      <Menu.Root>
        <Menu.Trigger
          aria-label={ariaLabel}
          className="group flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-bg-2"
        >
          <AccountMonogram label={active.label} active />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[0.75rem] font-medium text-text-bright">
              {active.label}
            </span>
            <span className="truncate text-[0.625rem] text-muted">{pillIdentity}</span>
          </span>
          <ChevronDown
            size={12}
            strokeWidth={2.5}
            className="shrink-0 opacity-50 transition-opacity group-hover:opacity-90"
          />
        </Menu.Trigger>
        {/* Exactly as wide as the pill (the sidebar's content width), so a long
            identity truncates instead of spilling over the main pane. */}
        <Menu.Content align="start" className="w-[var(--anchor-width)] min-w-60">
          {items}
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}
