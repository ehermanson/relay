import { Ellipsis, ExternalLink, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { Menu } from "@/components/ui/menu";
import { getDesktop } from "@/lib/desktop";

/** Paths come from the file-change stream; the desktop host validates access. */
export function DesktopFileActions({ path }: { path: string }) {
  const desktop = getDesktop();
  if (!desktop?.capabilities?.localFiles || !path) return null;
  const invoke = async (action: "open" | "reveal") => {
    try {
      await (action === "open" ? desktop.openPath(path) : desktop.revealPath(path));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not open file");
    }
  };
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <Menu.Root>
        <Menu.Trigger
          aria-label="File actions"
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-hover hover:text-text"
        >
          <Ellipsis size={14} />
        </Menu.Trigger>
        <Menu.Content>
          <Menu.Item onClick={() => void invoke("reveal")}>
            <FolderOpen size={14} />
            Reveal in{" "}
            {desktop.platform === "darwin"
              ? "Finder"
              : desktop.platform === "win32"
                ? "Explorer"
                : "file manager"}
          </Menu.Item>
          <Menu.Item onClick={() => void invoke("open")}>
            <ExternalLink size={14} />
            Open with default app
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}
