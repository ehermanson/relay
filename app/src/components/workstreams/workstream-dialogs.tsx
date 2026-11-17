/**
 * The create / rename / delete dialogs for Workstreams, mounted once in the
 * app layout and driven by `useWorkstreamUiStore.dialog`.
 */

import { useEffect, useRef, useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import type { Workstream } from "@shared/types";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDirectoryBrowser } from "@/hooks/use-directory-browser";
import { useWorkstreamActions } from "@/hooks/use-workstreams";
import { browsePath } from "@/lib/api";
import { canChooseFolders, getDesktop } from "@/lib/desktop";
import { useWorkstreamUiStore } from "@/stores/workstream-ui-store";

export function WorkstreamDialogs() {
  const dialog = useWorkstreamUiStore((s) => s.dialog);
  const close = useWorkstreamUiStore((s) => s.closeDialog);
  const reveal = useWorkstreamUiStore((s) => s.reveal);
  const { create, update, remove } = useWorkstreamActions();
  const [name, setName] = useState("");
  const linking = dialog?.kind === "folder" ? dialog : null;

  const naming = dialog?.kind === "create" || dialog?.kind === "rename" ? dialog : null;

  useEffect(() => {
    if (dialog?.kind === "create") setName("");
    else if (dialog?.kind === "rename") setName(dialog.workstream.name);
  }, [dialog]);

  const trimmed = name.trim();

  const commit = () => {
    if (!naming || !trimmed) return;
    if (naming.kind === "create") {
      void create(trimmed, naming.instanceId).then((workstream) => {
        // Open the new folder so the result of the action is visible.
        if (workstream) reveal(workstream.id);
      });
    } else if (trimmed !== naming.workstream.name) {
      void update(naming.workstream.id, { name: trimmed });
    }
    close();
  };

  return (
    <>
      <Dialog.Root open={!!naming} onOpenChange={(open) => !open && close()}>
        {naming && (
          <Dialog.Content maxWidth="max-w-sm">
            <Dialog.Title>
              {naming.kind === "create" ? "New workstream" : "Rename workstream"}
            </Dialog.Title>
            {naming.kind === "create" && (
              <p className="text-[0.8125rem] text-muted">
                A workstream groups the chats of one long-running effort, across projects.
              </p>
            )}
            <Input
              autoFocus
              value={name}
              maxLength={80}
              placeholder="e.g. GraphQL performance"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") close();
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" disabled={!trimmed} onClick={commit}>
                {naming.kind === "create" ? "Create" : "Rename"}
              </Button>
            </div>
          </Dialog.Content>
        )}
      </Dialog.Root>

      <Dialog.Root open={!!linking} onOpenChange={(open) => !open && close()}>
        {linking && <LinkFolderDialog workstream={linking.workstream} onClose={close} />}
      </Dialog.Root>

      <ConfirmActionDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => !open && close()}
        title="Delete workstream"
        description={
          dialog?.kind === "delete" ? (
            <>
              <span className="font-medium text-text">{dialog.workstream.name}</span> will be
              removed. Its chats are kept and stay in the inbox.
            </>
          ) : null
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (dialog?.kind === "delete") void remove(dialog.workstream.id);
          close();
        }}
        maxWidth="max-w-sm"
      />
    </>
  );
}

/**
 * Link a folder to a Workstream. In the desktop app the native folder chooser
 * is the main way in. A browser can't hand a page an absolute path, so there
 * (and as a fallback everywhere) the path field suggests the server's folders
 * as you type. Mounted only while open, so its state starts fresh each time.
 */
function LinkFolderDialog({
  workstream,
  onClose,
}: {
  workstream: Workstream;
  onClose: () => void;
}) {
  const { setFolder } = useWorkstreamActions();
  const [path, setPath] = useState(workstream.folderPath ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const browser = useDirectoryBrowser();
  const desktop = getDesktop();
  const nativeChooser = canChooseFolders(desktop) ? desktop : undefined;

  // The home directory comes from the browse route itself: `fetchHome` returns
  // the default chat directory, which is not what "~" means.
  const [home, setHome] = useState("");
  useEffect(() => {
    let live = true;
    void browsePath("").then((data) => {
      if (live && data.home) setHome(data.home);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (browser.activeIndex < 0) return;
    listRef.current
      ?.querySelectorAll(".dir-item")
      [browser.activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [browser.activeIndex]);

  const link = (target: string) => {
    const value = target.trim();
    if (!value || saving) return;
    setSaving(true);
    void setFolder(workstream.id, value)
      .then((failure) => {
        if (failure) setError(failure);
        else onClose();
      })
      .finally(() => setSaving(false));
  };

  // The server browses absolute paths under home; let the user type "~".
  const suggest = (value: string) => {
    const absolute =
      home && (value === "~" || value.startsWith("~/")) ? home + value.slice(1) : value;
    if (absolute.startsWith("/")) browser.browse(absolute);
    else browser.close();
  };

  const change = (value: string) => {
    setPath(value);
    setError(null);
    suggest(value);
  };

  // Picking a suggestion steps into it, so the next level is offered at once.
  const pick = (dir: string) => {
    setPath(dir);
    setError(null);
    browser.browse(dir + "/");
  };

  const chooseNative = async () => {
    if (!nativeChooser || choosing) return;
    setChoosing(true);
    setError(null);
    try {
      const directory = await nativeChooser.chooseDirectory();
      if (directory) {
        setPath(directory);
        browser.close();
        link(directory);
      }
    } catch {
      setError("Could not open the folder chooser.");
    } finally {
      setChoosing(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const open = browser.isOpen && browser.suggestions.length > 0;
    if (open && e.key === "ArrowDown") {
      e.preventDefault();
      browser.setActiveIndex((i) => Math.min(i + 1, browser.suggestions.length - 1));
    } else if (open && e.key === "ArrowUp") {
      e.preventDefault();
      browser.setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (open && (e.key === "Enter" || e.key === "Tab") && browser.activeIndex >= 0) {
      e.preventDefault();
      pick(browser.suggestions[browser.activeIndex]);
    } else if (e.key === "Enter") {
      link(path);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      browser.close();
    }
  };

  return (
    <Dialog.Content maxWidth="max-w-md">
      <Dialog.Title>Folder for {workstream.name}</Dialog.Title>
      <p className="text-[0.8125rem] leading-relaxed text-muted">
        Chats in this workstream are told about the folder, given its README and STATUS when they
        start, and can read and write files in it. Relay never changes the folder itself.
      </p>
      {nativeChooser && (
        <Button variant="primary" disabled={choosing || saving} onClick={() => void chooseNative()}>
          <FolderOpen size={14} />
          {choosing ? "Choosing…" : saving ? "Linking…" : "Choose folder…"}
        </Button>
      )}
      <div className="space-y-1.5">
        {nativeChooser && (
          <label className="text-[0.75rem] text-muted" htmlFor="workstream-folder-path">
            Or enter a path
          </label>
        )}
        <Input
          id="workstream-folder-path"
          autoFocus={!nativeChooser}
          value={path}
          placeholder="~/work/projects/graphql-performance"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => change(e.target.value)}
          onFocus={() => {
            if (!path) suggest("~/");
          }}
          onBlur={() => browser.close()}
          onKeyDown={onKeyDown}
        />
        {browser.isOpen && browser.suggestions.length > 0 && (
          <div
            ref={listRef}
            className="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-surface-raised"
          >
            {browser.suggestions.map((dir, i) => (
              <button
                key={dir}
                type="button"
                tabIndex={-1}
                className={`dir-item flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  i === browser.activeIndex ? "bg-accent-dim" : "hover:bg-surface-hover"
                }`}
                // mousedown, not click: the input must keep focus.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(dir);
                }}
                onMouseEnter={() => browser.setActiveIndex(i)}
              >
                <Folder size={13} className="shrink-0 text-muted" />
                <span
                  className={`truncate text-[0.8125rem] ${i === browser.activeIndex ? "text-accent" : "text-text"}`}
                >
                  {dir.split("/").pop() || dir}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-[0.75rem] text-error">{error}</p>}
      <p className="text-[0.75rem] text-muted/80">
        Applies to chats started from now on. A chat that is already running picks it up the next
        time its session starts.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant={nativeChooser ? "ghost" : "primary"}
          className={nativeChooser ? "border border-border text-text" : ""}
          size="sm"
          disabled={!path.trim() || saving}
          onClick={() => link(path)}
        >
          {saving ? "Linking..." : "Link folder"}
        </Button>
      </div>
    </Dialog.Content>
  );
}
