/**
 * Account mismatch guard — the compact notice at the top of a chat whose
 * account isn't the active one (a deep link, a tab left open across a switch).
 * It identifies, it never blocks: sends still go through the chat's own
 * account. Renders nothing below two accounts (`chatAccountMismatch` is null
 * there), so a single-account install never sees it.
 */

import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useActiveAccount } from "@/hooks/use-active-account";
import { chatAccountMismatch } from "@/lib/account-scope";
import type { AccountStatus, InstanceInfo } from "@shared/types";

export function AccountMismatchBanner({
  owner,
  onSwitch,
}: {
  owner: AccountStatus;
  onSwitch: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-warning/30 bg-warning/8 px-4 py-2 text-[0.75rem] text-text-muted max-[768px]:gap-2 max-[768px]:px-3"
    >
      <UserRound size={14} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate">
        This chat belongs to <span className="font-medium text-text-bright">{owner.label}</span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onSwitch}
        className="shrink-0 max-[768px]:min-h-10"
      >
        Switch to {owner.label}
      </Button>
    </div>
  );
}

/** The chat-level guard: the chat's `accountId` against the active account. */
export function ChatAccountMismatchBanner({
  instance,
}: {
  instance: Pick<InstanceInfo, "accountId">;
}) {
  const account = useActiveAccount();
  const owner = chatAccountMismatch(instance, account.activeId, account.accounts);
  if (!owner) return null;
  return <AccountMismatchBanner owner={owner} onSwitch={() => account.setActiveId(owner.id)} />;
}
