/**
 * Settings → Providers → Accounts: the provider's account profiles (one login
 * per config dir), their probed identity, and which one new chats use.
 *
 * Rendered only when `ProviderCapabilities.supportsAccountProfiles` is true —
 * the caller gates on the capability, never on the provider name. The
 * identity line is always visible text (tooltips don't open on touch).
 */

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import {
  addProviderProfile,
  probeProviderProfile,
  removeProviderProfile,
  renameProviderProfile,
} from "@/lib/api";
import { formatProfileIdentity } from "@/lib/account-profiles";
import { providerProfilesQueryKey, useProviderProfiles } from "@/hooks/use-provider-profiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DEFAULT_ACCOUNT_PROFILE_ID,
  type ProviderAccountProfileStatus,
  type ProviderDescriptor,
} from "@shared/types";

const LABEL_CLASS = "text-[0.6875rem] font-medium text-muted";

interface AccountProfilesBlockProps {
  provider: ProviderDescriptor;
  /** `providerDefaults[provider].profileId`; null/absent = the default profile. */
  selectedProfileId: string | null | undefined;
  onSelectProfile: (profileId: string | null) => void;
}

export function AccountProfilesBlock({
  provider,
  selectedProfileId,
  onSelectProfile,
}: AccountProfilesBlockProps) {
  const providerKind = provider.provider;
  const queryClient = useQueryClient();
  const queryKey = providerProfilesQueryKey(providerKind);
  const {
    data: profiles = [],
    isLoading,
    error,
  } = useProviderProfiles(providerKind, { poll: true });

  const replaceRow = (row: ProviderAccountProfileStatus) => {
    queryClient.setQueryData<ProviderAccountProfileStatus[]>(queryKey, (prev) =>
      prev ? prev.map((p) => (p.id === row.id ? row : p)) : [row],
    );
  };
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const probe = useMutation({
    mutationFn: (id: string) => probeProviderProfile(providerKind, id),
    onSuccess: replaceRow,
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to check account"),
    onSettled: invalidate,
  });

  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      renameProviderProfile(providerKind, id, label),
    onSuccess: (row) => {
      replaceRow(row);
      toast.success("Account renamed");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to rename account"),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeProviderProfile(providerKind, id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<ProviderAccountProfileStatus[]>(queryKey, (prev) =>
        prev?.filter((p) => p.id !== id),
      );
      // A removed profile can't stay the default for new chats.
      if (selectedProfileId === id) onSelectProfile(null);
      toast.success("Account removed");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove account"),
    onSettled: invalidate,
  });

  // The radio value is always a concrete id: the default profile stands in
  // for "no global override" (saved as null).
  const selectedValue =
    selectedProfileId && profiles.some((p) => p.id === selectedProfileId)
      ? selectedProfileId
      : DEFAULT_ACCOUNT_PROFILE_ID;

  const handleSelect = (value: string) => {
    onSelectProfile(value === DEFAULT_ACCOUNT_PROFILE_ID ? null : value);
  };

  return (
    <div className="mt-4 border-t border-border/30 pl-7 pt-4">
      <div className={LABEL_CLASS}>Accounts</div>
      <div className="mt-0.5 text-[0.75rem] text-muted">
        Which {provider.label} login new chats use. Projects can pick their own.
      </div>

      {error ? (
        <div className="mt-2 text-[0.75rem] text-error">
          {error instanceof Error ? error.message : "Failed to load accounts"}
        </div>
      ) : null}

      {isLoading && profiles.length === 0 ? (
        <div className="mt-3 flex items-center gap-2 text-[0.75rem] text-muted">
          <Loader2 size={12} className="animate-spin" /> Loading accounts…
        </div>
      ) : null}

      {profiles.length > 0 ? (
        <RadioGroup
          value={selectedValue}
          onValueChange={handleSelect}
          className="mt-2 !flex-col !gap-0 divide-y divide-border/30"
          name={`account-profile-${providerKind}`}
        >
          {profiles.map((profile) => (
            <AccountProfileRow
              key={profile.id}
              profile={profile}
              selected={selectedValue === profile.id}
              probing={probe.isPending && probe.variables === profile.id}
              renaming={rename.isPending && rename.variables?.id === profile.id}
              removing={remove.isPending && remove.variables === profile.id}
              onProbe={() => probe.mutate(profile.id)}
              onRename={(label) => rename.mutate({ id: profile.id, label })}
              onRemove={() => remove.mutate(profile.id)}
            />
          ))}
        </RadioGroup>
      ) : null}

      <AddAccountForm provider={provider} />
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────────

function AccountProfileRow({
  profile,
  selected,
  probing,
  renaming,
  removing,
  onProbe,
  onRename,
  onRemove,
}: {
  profile: ProviderAccountProfileStatus;
  selected: boolean;
  probing: boolean;
  renaming: boolean;
  removing: boolean;
  onProbe: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.label);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const radioId = `account-profile-${profile.provider}-${profile.id}`;
  const identityLine = formatProfileIdentity(profile);
  const identityTone =
    profile.probeState === "error"
      ? "text-warning"
      : profile.probeState === "ok"
        ? "text-text"
        : "text-muted";
  const busy = probing || renaming || removing || profile.probeState === "probing";

  const startEditing = () => {
    setDraft(profile.label);
    setEditing(true);
  };
  const commitRename = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== profile.label) onRename(next);
  };

  return (
    <div className="flex items-start gap-3 py-2.5">
      {/* The whole label column is the hit target for "use for new chats", so
          the 16px radio isn't the only thing to tap on a phone. */}
      <label
        htmlFor={radioId}
        className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-start gap-3"
      >
        <RadioGroupItem
          id={radioId}
          value={profile.id}
          className="mt-1"
          aria-label={`Use ${profile.label} for new chats`}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {editing ? (
              <Input
                inputSize="sm"
                autoFocus
                value={draft}
                maxLength={40}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(false);
                  }
                }}
                onBlur={commitRename}
                onClick={(e) => e.preventDefault()}
                className="w-44"
                aria-label="Account name"
              />
            ) : (
              <span className="text-[0.8125rem] font-medium text-text-bright">{profile.label}</span>
            )}
            {profile.isDefault ? (
              <Badge size="sm" variant="default">
                Default
              </Badge>
            ) : null}
            {selected ? (
              <Badge size="sm" variant="accent">
                New chats
              </Badge>
            ) : null}
          </span>
          <span className={`text-[0.75rem] ${identityTone}`}>{identityLine}</span>
          <span className="truncate font-mono text-[0.6875rem] text-muted/80">
            {profile.configDir}
          </span>
        </span>
      </label>

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content="Re-check sign-in">
          <Button
            type="button"
            variant="icon"
            size="icon-md"
            className="max-[768px]:h-10 max-[768px]:w-10"
            onClick={onProbe}
            disabled={busy}
            aria-label={`Re-check ${profile.label}`}
          >
            {probing || profile.probeState === "probing" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
          </Button>
        </Tooltip>
        {!profile.isDefault ? (
          <>
            <Tooltip content={editing ? "Save name" : "Rename"}>
              <Button
                type="button"
                variant="icon"
                size="icon-md"
                className="max-[768px]:h-10 max-[768px]:w-10"
                onMouseDown={(e) => {
                  // Keep focus on the input so the blur commit runs once, after click.
                  if (editing) e.preventDefault();
                }}
                onClick={editing ? commitRename : startEditing}
                disabled={busy}
                aria-label={editing ? "Save account name" : `Rename ${profile.label}`}
              >
                {editing ? <Check size={13} /> : <Pencil size={13} />}
              </Button>
            </Tooltip>
            <Tooltip content="Remove">
              <Button
                type="button"
                variant="icon"
                size="icon-md"
                className="max-[768px]:h-10 max-[768px]:w-10 hover:text-error"
                onClick={() => setConfirmRemove(true)}
                disabled={busy}
                aria-label={`Remove ${profile.label}`}
              >
                <Trash2 size={13} />
              </Button>
            </Tooltip>
            <ConfirmActionDialog
              open={confirmRemove}
              onOpenChange={setConfirmRemove}
              title={`Remove ${profile.label}?`}
              description={
                <>
                  Relay stops offering this account for new chats. The login in{" "}
                  <code className="font-mono text-[0.6875rem] text-text">{profile.configDir}</code>{" "}
                  is left in place, and existing chats keep using it.
                </>
              }
              confirmLabel="Remove"
              isLoading={removing}
              onConfirm={() => {
                setConfirmRemove(false);
                onRemove();
              }}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Add form ──────────────────────────────────────────────────────────────

function AddAccountForm({ provider }: { provider: ProviderDescriptor }) {
  const providerKind = provider.provider;
  const queryClient = useQueryClient();
  const queryKey = providerProfilesQueryKey(providerKind);
  const [label, setLabel] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => addProviderProfile(providerKind, { label, configDir }),
    onSuccess: (row) => {
      queryClient.setQueryData<ProviderAccountProfileStatus[]>(queryKey, (prev) =>
        prev ? [...prev.filter((p) => p.id !== row.id), row] : [row],
      );
      queryClient.invalidateQueries({ queryKey });
      setLabel("");
      setConfigDir("");
      setFormError(null);
      toast.success(`Added ${row.label}`);
    },
    onError: (err) => {
      // Validation messages are user-facing; keep them next to the form.
      setFormError(err instanceof Error ? err.message : "Failed to add account");
    },
  });

  const canSubmit = label.trim().length > 0 && configDir.trim().length > 0 && !add.isPending;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setFormError(null);
    add.mutate();
  };

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLASS} htmlFor={`add-account-label-${providerKind}`}>
            Name
          </label>
          <Input
            id={`add-account-label-${providerKind}`}
            inputSize="md"
            value={label}
            maxLength={40}
            placeholder="Work"
            onChange={(e) => setLabel(e.target.value)}
            className="w-36"
            autoComplete="off"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label className={LABEL_CLASS} htmlFor={`add-account-dir-${providerKind}`}>
            Config directory
          </label>
          <Input
            id={`add-account-dir-${providerKind}`}
            inputSize="md"
            value={configDir}
            placeholder="~/.claude-work"
            onChange={(e) => setConfigDir(e.target.value)}
            className="min-w-48 font-mono"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!canSubmit}
          className="max-[768px]:min-h-10"
        >
          {add.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
          Add account
        </Button>
      </div>
      {formError ? (
        <div className="flex items-start gap-1.5 text-[0.75rem] text-error">
          <X size={12} className="mt-0.5 shrink-0" />
          <span>{formError}</span>
        </div>
      ) : null}
      <p className="text-[0.75rem] leading-relaxed text-muted">
        Sign in to another {provider.label} account by running{" "}
        <code className="rounded bg-surface-hover px-1 py-px font-mono text-[0.6875rem] text-text">
          CLAUDE_CONFIG_DIR=~/.claude-work claude
        </code>{" "}
        and <code className="font-mono text-[0.6875rem] text-text">/login</code>, then add that
        directory here.
      </p>
    </form>
  );
}
