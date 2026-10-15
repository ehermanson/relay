import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getDesktop } from "@/lib/desktop";
import { useSidebarNavigationController } from "@/hooks/use-sidebar-navigation-controller";
import { AddProjectDialog } from "@/components/layout/sidebar-chrome";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** Native menu commands reuse the same navigation and chat creation as the sidebar. */
export function DesktopCommands({
  onSearch,
  onToggleSidebar,
}: {
  onSearch: () => void;
  onToggleSidebar: () => void;
}) {
  const navigate = useNavigate();
  const { registeredDirs, projectEntries, createNewChat, currentProjectId } =
    useSidebarNavigationController();
  const [projectOpen, setProjectOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // One stable preload subscription: `projectEntries` gets a new identity on
  // every WS instance_list broadcast, so the handler reads the mutable inputs
  // through a ref instead of re-subscribing to the native listener per render.
  const context = {
    onSearch,
    onToggleSidebar,
    navigate,
    projectEntries,
    currentProjectId,
    createNewChat,
  };
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(
    () =>
      getDesktop()?.onCommand((command) => {
        const {
          onSearch,
          onToggleSidebar,
          navigate,
          projectEntries,
          currentProjectId,
          createNewChat,
        } = contextRef.current;
        if (command === "search") onSearch();
        if (command === "toggle-sidebar") onToggleSidebar();
        if (command === "settings") void navigate({ to: "/settings/general" });
        if (command === "new-project") setProjectOpen(true);
        if (command === "new-chat") {
          const selected =
            projectEntries.find((project) => project.projectId === currentProjectId) ??
            (projectEntries.length === 1 ? projectEntries[0] : undefined);
          if (selected) createNewChat(selected.dir);
          else if (projectEntries.length) setChatOpen(true);
          else setProjectOpen(true);
        }
      }),
    [],
  );
  return (
    <>
      <AddProjectDialog
        open={projectOpen}
        onOpenChange={setProjectOpen}
        registeredDirs={registeredDirs}
      />
      <Dialog.Root open={chatOpen} onOpenChange={setChatOpen}>
        <Dialog.Content maxWidth="max-w-md">
          <Dialog.Header>
            <Dialog.Title>New chat</Dialog.Title>
            <Dialog.Close />
          </Dialog.Header>
          <p className="mb-3 text-sm text-muted">Choose a Project for this chat.</p>
          <div className="flex flex-col gap-2">
            {projectEntries.map((project) => (
              <Button
                key={project.dir}
                onClick={() => {
                  createNewChat(project.dir);
                  setChatOpen(false);
                }}
              >
                {project.name}
              </Button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
