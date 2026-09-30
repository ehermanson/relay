/**
 * Settings → Accounts: every Relay account and the provider logins it owns.
 *
 * An account is a named context ("Work", "Personal") with one login (config
 * dir) per provider it uses; the default account is the server's own logins.
 * Identity is probed, never typed, and is always visible text (tooltips don't
 * open on touch).
 *
 * With a single account the section is compact — the default account's login
 * rows and the Add account control. From two accounts up each account is a
 * card with its name, `Default`/`Active` badges, and (for non-default
 * accounts) edit logins / remove / "Switch to". Which account is *in use* is
 * the per-browser active account, never a stored default.
 *
 * Which providers can carry a second login comes from
 * `ProviderCapabilities.supportsAccountLogins` — never a provider-name branch.
 */

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { ACCOUNT_LABEL_MAX } from "@shared/accounts";
import { getProviderDisplayName } from "@shared/provider-catalog";
import type {
  AccountLoginHowTo,
  AccountLoginStatus,
  AccountStatus,
  ProviderDescriptor,
  ProviderKind,
} from "@shared/types";
import {
  addAccount,
  probeAccount,
  removeAccount,
  updateAccount,
  type AccountLoginsInput,
} from "@/lib/api";
import { accountLoginEntries, formatLoginIdentity } from "@/lib/account-identity";
import { ACCOUNTS_QUERY_KEY, useAccounts } from "@/hooks/use-accounts";
import { useActiveAccount } from "@/hooks/use-active-account";
import { useInstalledProviders } from "@/hooks/use-available-providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { Input } from "@/components/ui/input";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { SettingsSection } from "@/components/settings/settings-shared";
import { Tooltip } from "@/components/ui/tooltip";

const LABEL_CLASS = "text-[0.6875rem] font-medium text-muted";
const ICON_BUTTON_CLASS = "max-[768px]:h-10 max-[768px]:w-10";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Everything that depends on the account list or on which providers an account covers. */
function useAccountsInvalidation() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return {
    queryClient,
    replaceRow: (row: AccountStatus) => {
      queryClient.setQueryData<AccountStatus[]>(ACCOUNTS_QUERY_KEY, (prev) =>
        prev
          ? prev.some((a) => a.id === row.id)
            ? prev.map((a) => (a.id === row.id ? row : a))
            : [...prev, row]
          : [row],
      );
    },
    refetchAccounts: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY }),
    /** Logins or membership changed: provider availability and projects follow. */
    refetchDependents: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void router.invalidate();
    },
  };
}

export function AccountsSettingsSection() {
  const { data: accounts = [], isLoading, error } = useAccounts();
  const account = useActiveAccount();
  const { providers } = useInstalledProviders();
  const router = useRouter();
  const { queryClient, replaceRow, refetchAccounts, refetchDependents } = useAccountsInvalidation();

  const providerOrder = providers.map((p) => p.provider);
  const providerLabel = (provider: ProviderKind) =>
    providers.find((p) => p.provider === provider)?.label ?? getProviderDisplayName(provider);
  const loginProviders = providers.filter((p) => p.capabilities.supportsAccountLogins);
  const isMulti = account.isMulti;

  const probe = useMutation({
    mutationFn: (id: string) => probeAccount(id),
    onSuccess: replaceRow,
    onError: (err) => toast.error(errorMessage(err, "Failed to check account")),
    onSettled: refetchAccounts,
  });

  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => updateAccount(id, { label }),
    onSuccess: (row) => {
      replaceRow(row);
      toast.success("Account renamed");
    },
    onError: (err) => toast.error(errorMessage(err, "Failed to rename account")),
    onSettled: refetchAccounts,
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeAccount(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<AccountStatus[]>(ACCOUNTS_QUERY_KEY, (prev) =>
        prev?.filter((a) => a.id !== id),
      );
      // Project membership changed server-side, and the active account may
      // have just fallen back to the default one.
      refetchDependents();
      toast.success("Account removed");
    },
    onError: (err) => toast.error(errorMessage(err, "Failed to remove account")),
    onSettled: refetchAccounts,
  });

  const switchTo = (id: string) => {
    if (id === account.activeId) return;
    account.setActiveId(id);
    void router.invalidate();
  };

  const renderLogins = (row: AccountStatus) => {
    const entries = accountLoginEntries(row, providerOrder);
    const probing = probe.isPending && probe.variables === row.id;
    if (entries.length === 0) {
      return <div className="py-2.5 text-[0.75rem] text-muted">No provider logins.</div>;
    }
    return (
      <div className="flex flex-col divide-y divide-border/30">
        {entries.map(([provider, login]) => (
          <LoginRow
            key={provider}
            provider={provider}
            providerLabel={providerLabel(provider)}
            login={login}
            probing={probing}
            onProbe={() => probe.mutate(row.id)}
          />
        ))}
      </div>
    );
  };

  return (
    <SettingsSection
      title="Accounts"
      description={
        isMulti
          ? "Each account has its own login per provider. The active account (switch at the top of the sidebar) decides which projects, chats and providers are in view."
          : "The provider logins Relay runs chats under. Add an account to keep another set of logins — work and personal, say — side by side."
      }
    >
      <div className="flex flex-col gap-3 pb-5">
        {error ? (
          <div className="text-[0.75rem] text-error">
            {errorMessage(error, "Failed to load accounts")}
          </div>
        ) : null}

        {isLoading && accounts.length === 0 ? (
          <div className="flex items-center gap-2 text-[0.75rem] text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading accounts…
          </div>
        ) : null}

        {isMulti
          ? accounts.map((row) => (
              <AccountCard
                key={row.id}
                account={row}
                active={account.activeId === row.id}
                loginProviders={loginProviders}
                renaming={rename.isPending && rename.variables?.id === row.id}
                removing={remove.isPending && remove.variables === row.id}
                onSwitch={() => switchTo(row.id)}
                onRename={(label) => rename.mutate({ id: row.id, label })}
                onRemove={() => remove.mutate(row.id)}
              >
                {renderLogins(row)}
              </AccountCard>
            ))
          : accounts.slice(0, 1).map((row) => <div key={row.id}>{renderLogins(row)}</div>)}

        <AddAccount loginProviders={loginProviders} />
      </div>
    </SettingsSection>
  );
}

// ─── Login row ─────────────────────────────────────────────────────────────

function LoginRow({
  provider,
  providerLabel,
  login,
  probing,
  onProbe,
}: {
  provider: ProviderKind;
  providerLabel: string;
  login: AccountLoginStatus;
  probing: boolean;
  onProbe: () => void;
}) {
  const busy = probing || login.probeState === "probing";
  const identityTone =
    login.probeState === "error"
      ? "text-warning"
      : login.probeState === "ok"
        ? "text-text"
        : "text-muted";

  return (
    <div className="flex items-start gap-2.5 py-2.5">
      <ProviderLogo provider={provider} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[0.8125rem] font-medium text-text-bright">{providerLabel}</span>
        <span className={`break-words text-[0.75rem] ${identityTone}`}>
          {formatLoginIdentity(login)}
        </span>
        <span className="truncate font-mono text-[0.6875rem] text-muted/80">{login.configDir}</span>
      </div>
      <Tooltip content="Re-check sign-in">
        <Button
          type="button"
          variant="icon"
          size="icon-md"
          className={`shrink-0 ${ICON_BUTTON_CLASS}`}
          onClick={onProbe}
          disabled={busy}
          aria-label={`Re-check ${providerLabel} sign-in`}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </Button>
      </Tooltip>
    </div>
  );
}

// ─── Account card (two or more accounts) ───────────────────────────────────

function AccountCard({
  account,
  active,
  loginProviders,
  renaming,
  removing,
  onSwitch,
  onRename,
  onRemove,
  children,
}: {
  account: AccountStatus;
  active: boolean;
  loginProviders: ProviderDescriptor[];
  renaming: boolean;
  removing: boolean;
  onSwitch: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const [editingName, setEditingName] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const [editingLogins, setEditingLogins] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const busy = renaming || removing;

  const startRename = () => {
    setDraft(account.label);
    setEditingName(true);
  };
  const commitRename = () => {
    const next = draft.trim();
    setEditingName(false);
    if (next && next !== account.label) onRename(next);
  };

  return (
    <div className="rounded-lg border border-border/50 px-3.5 pb-1 pt-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {editingName ? (
            <Input
              inputSize="sm"
              autoFocus
              value={draft}
              maxLength={ACCOUNT_LABEL_MAX}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingName(false);
                }
              }}
              onBlur={commitRename}
              className="w-44"
              aria-label="Account name"
            />
          ) : (
            <span className="truncate text-[0.875rem] font-semibold text-text-bright">
              {account.label}
            </span>
          )}
          {account.isDefault ? (
            <Badge size="sm" variant="default">
              Default
            </Badge>
          ) : null}
          {active ? (
            <Badge size="sm" variant="accent">
              Active
            </Badge>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {!active ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-[768px]:min-h-10"
              onClick={onSwitch}
              aria-label={`Switch to ${account.label}`}
            >
              Switch to
            </Button>
          ) : null}
          <Tooltip content={editingName ? "Save name" : "Rename"}>
            <Button
              type="button"
              variant="icon"
              size="icon-md"
              className={ICON_BUTTON_CLASS}
              // Keep focus on the input so blur doesn't commit before the click does.
              onMouseDown={(e) => e.preventDefault()}
              onClick={editingName ? commitRename : startRename}
              disabled={busy}
              aria-label={editingName ? "Save name" : `Rename ${account.label}`}
            >
              {renaming ? (
                <Loader2 size={13} className="animate-spin" />
              ) : editingName ? (
                <Check size={13} />
              ) : (
                <Pencil size={13} />
              )}
            </Button>
          </Tooltip>
          {!account.isDefault ? (
            <Tooltip content="Remove account">
              <Button
                type="button"
                variant="icon"
                size="icon-md"
                className={`${ICON_BUTTON_CLASS} hover:text-error`}
                onClick={() => setConfirmRemove(true)}
                disabled={busy}
                aria-label={`Remove ${account.label}`}
              >
                <Trash2 size={13} />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {editingLogins ? (
        <LoginsForm
          mode="edit"
          account={account}
          loginProviders={loginProviders}
          onDone={() => setEditingLogins(false)}
        />
      ) : (
        <>
          {children}
          {!account.isDefault ? (
            <div className="border-t border-border/30 py-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 max-[768px]:min-h-10"
                onClick={() => setEditingLogins(true)}
                disabled={busy}
              >
                Edit logins
              </Button>
            </div>
          ) : null}
        </>
      )}

      {!account.isDefault ? (
        <ConfirmActionDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove ${account.label}?`}
          description="Relay stops offering this account. Projects that belonged only to it move to the default account. Its provider logins are left in place on disk, and existing chats keep using them."
          confirmLabel="Remove"
          isLoading={removing}
          onConfirm={() => {
            setConfirmRemove(false);
            onRemove();
          }}
        />
      ) : null}
    </div>
  );
}

// ─── Add account ───────────────────────────────────────────────────────────

function AddAccount({ loginProviders }: { loginProviders: ProviderDescriptor[] }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div>
        <Button
          type="button"
          variant="ghost"
          size="md"
          className="-ml-2 max-[768px]:min-h-10"
          onClick={() => setOpen(true)}
          // Nothing to add until a provider that supports separate logins is installed.
          disabled={loginProviders.length === 0}
        >
          <Plus size={13} />
          Add account
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 px-3.5 py-3">
      <div className="text-[0.8125rem] font-medium text-text-bright">Add account</div>
      <LoginsForm mode="add" loginProviders={loginProviders} onDone={() => setOpen(false)} />
    </div>
  );
}

// ─── Logins form (add an account / edit an account's logins) ───────────────

function dirsFromAccount(
  account: AccountStatus | undefined,
): Partial<Record<ProviderKind, string>> {
  const dirs: Partial<Record<ProviderKind, string>> = {};
  for (const [provider, login] of Object.entries(account?.logins ?? {})) {
    if (login) dirs[provider as ProviderKind] = login.configDir;
  }
  return dirs;
}

function LoginsForm({
  mode,
  account,
  loginProviders,
  onDone,
}: {
  mode: "add" | "edit";
  account?: AccountStatus;
  loginProviders: ProviderDescriptor[];
  onDone: () => void;
}) {
  const { replaceRow, refetchAccounts, refetchDependents } = useAccountsInvalidation();
  const [label, setLabel] = useState("");
  const [dirs, setDirs] = useState(() => dirsFromAccount(account));
  const [formError, setFormError] = useState<string | null>(null);
  const idPrefix = mode === "add" ? "add-account" : `edit-account-${account?.id}`;

  // An existing login for a provider that isn't installed right now still gets
  // a field, so saving never drops it silently.
  // The sign-in hint is provider copy carried by `ProviderCapabilities`, never
  // a provider-name table here.
  const fields: Array<{ provider: ProviderKind; label: string; howTo?: AccountLoginHowTo }> = [
    ...loginProviders.map((p) => ({
      provider: p.provider,
      label: p.label,
      howTo: p.capabilities.accountLoginHowTo,
    })),
    ...(Object.keys(account?.logins ?? {}) as ProviderKind[])
      .filter((provider) => !loginProviders.some((p) => p.provider === provider))
      .map((provider) => ({ provider, label: getProviderDisplayName(provider) })),
  ];

  const logins: AccountLoginsInput = {};
  for (const { provider } of fields) {
    const dir = dirs[provider]?.trim();
    if (dir) logins[provider] = { configDir: dir };
  }
  const hasLogin = Object.keys(logins).length > 0;

  const submit = useMutation({
    mutationFn: () =>
      mode === "add"
        ? addAccount({ label: label.trim(), logins })
        : updateAccount(account!.id, { logins }),
    onSuccess: (row) => {
      replaceRow(row);
      void refetchAccounts();
      refetchDependents();
      toast.success(mode === "add" ? `Added ${row.label}` : `Updated ${row.label}`);
      onDone();
    },
    // Validation messages are user-facing; keep them next to the form.
    onError: (err) =>
      setFormError(
        errorMessage(err, mode === "add" ? "Failed to add account" : "Failed to update account"),
      ),
  });

  const canSubmit = hasLogin && (mode === "edit" || label.trim().length > 0) && !submit.isPending;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setFormError(null);
    submit.mutate();
  };

  return (
    <form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-3 pb-2">
      {mode === "add" ? (
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLASS} htmlFor={`${idPrefix}-label`}>
            Name
          </label>
          <Input
            id={`${idPrefix}-label`}
            inputSize="md"
            autoFocus
            value={label}
            maxLength={ACCOUNT_LABEL_MAX}
            placeholder="Work"
            onChange={(e) => setLabel(e.target.value)}
            className="w-full max-w-56"
            autoComplete="off"
          />
        </div>
      ) : null}

      {fields.map(({ provider, label: providerLabel, howTo }) => {
        return (
          <div key={provider} className="flex flex-col gap-1.5">
            <label
              className={`${LABEL_CLASS} flex items-center gap-1.5`}
              htmlFor={`${idPrefix}-dir-${provider}`}
            >
              <ProviderLogo provider={provider} className="h-3 w-3" />
              {providerLabel} config directory
              <span className="font-normal text-muted/70">(optional)</span>
            </label>
            <Input
              id={`${idPrefix}-dir-${provider}`}
              inputSize="md"
              value={dirs[provider] ?? ""}
              placeholder={howTo?.exampleDir ?? "/path/to/config-dir"}
              onChange={(e) => setDirs((prev) => ({ ...prev, [provider]: e.target.value }))}
              className="w-full font-mono"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="text-[0.75rem] leading-relaxed text-muted">
              {howTo ? (
                <>
                  Sign in with{" "}
                  <code className="break-all rounded bg-surface-hover px-1 py-px font-mono text-[0.6875rem] text-text">
                    {howTo.command}
                  </code>
                  {howTo.followUp ? (
                    <>
                      {" "}
                      then{" "}
                      <code className="font-mono text-[0.6875rem] text-text">{howTo.followUp}</code>
                    </>
                  ) : null}
                  , then enter that directory here.
                </>
              ) : (
                <>Sign {providerLabel} in under its own config directory, then enter it here.</>
              )}
            </p>
          </div>
        );
      })}

      <p className="text-[0.75rem] text-muted">
        Leave a provider empty to keep it out of this account — it won’t be offered while the
        account is active. At least one login is required.
      </p>

      {formError ? (
        <div className="flex items-start gap-1.5 text-[0.75rem] text-error" role="alert">
          <X size={12} className="mt-0.5 shrink-0" />
          <span>{formError}</span>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!canSubmit}
          className="max-[768px]:min-h-10"
        >
          {submit.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
          {mode === "add" ? "Add account" : "Save logins"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="md"
          className="max-[768px]:min-h-10"
          onClick={onDone}
          disabled={submit.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
