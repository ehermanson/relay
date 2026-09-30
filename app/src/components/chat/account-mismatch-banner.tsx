/**
 * Account mismatch guard — the compact notice at the top of a chat or space
 * whose account isn't the active one (a deep link, a tab left open across a
 * switch). It identifies, it never blocks: sends still go through the chat's
 * own account. Renders nothing below two accounts (`chatAccountMismatch` /
 * `projectAccountMismatch` are null there), so a single-account install never
 * sees it.
 *
 * A space whose project is outside the active account shows the space-level
 * notice and suppresses the per-chat one inside it (`AccountMismatchHost`),
 * otherwise the same account would be named twice, one bar above the other.
 */

import { createContext, useContext } from "react";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useActiveAccount } from "@/hooks/use-active-account";
import { chatAccountMismatch, projectAccountMismatch } from "@/lib/account-scope";
import type { AccountStatus, InstanceInfo, Project } from "@shared/types";

/** True inside a space view that already shows its own account notice. */
const AccountMismatchHost = createContext(false);

export const AccountMismatchHostProvider = AccountMismatchHost.Provider;

export function AccountMismatchBanner({
  owner,
  subject,
  onSwitch,
}: {
  owner: AccountStatus;
  subject: "chat" | "space";
  onSwitch: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-warning/30 bg-warning/8 px-4 py-2 text-[0.75rem] text-text-muted max-[768px]:gap-2 max-[768px]:px-3"
    >
      <UserRound size={14} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate">
        This {subject} belongs to{" "}
        <span className="font-medium text-text-bright">{owner.label}</span>
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
  const hosted = useContext(AccountMismatchHost);
  const owner = chatAccountMismatch(instance, account.activeId, account.accounts);
  if (!owner || hosted) return null;
  return (
    <AccountMismatchBanner
      owner={owner}
      subject="chat"
      onSwitch={() => account.setActiveId(owner.id)}
    />
  );
}

/**
 * The space-level guard: the space's project membership against the active
 * account. Returns the owner so the host can wrap its chats in
 * `AccountMismatchHostProvider`.
 */
export function useProjectAccountMismatch(
  project: Pick<Project, "accountIds"> | undefined,
): AccountStatus | null {
  const account = useActiveAccount();
  if (!project) return null;
  return projectAccountMismatch(project, account.activeId, account.accounts);
}

export function SpaceAccountMismatchBanner({ owner }: { owner: AccountStatus }) {
  const account = useActiveAccount();
  return (
    <AccountMismatchBanner
      owner={owner}
      subject="space"
      onSwitch={() => account.setActiveId(owner.id)}
    />
  );
}
