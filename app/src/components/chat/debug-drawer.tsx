/**
 * Debug drawer shell used by the chat debug surface.
 * Provides the drawer chrome (title, close, body) — callers compose
 * their own content inside.
 */

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FlaskConical } from "lucide-react";
import { Drawer } from "../ui/drawer";

interface DebugDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function DebugDrawer({ open, onClose, title, children }: DebugDrawerProps) {
  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content width="w-[680px] max-w-[90vw]" showBackdrop={false}>
        <Drawer.Header>
          <Drawer.Title>{title}</Drawer.Title>
          <Drawer.Close />
        </Drawer.Header>
        <Drawer.Body className="px-5 py-4">{children}</Drawer.Body>
        <div className="relative z-10 shrink-0 border-t border-border/50 bg-surface px-5 py-3">
          <Link
            to="/sandbox"
            className="inline-flex items-center gap-1.5 text-[0.75rem] text-muted transition-colors hover:text-text"
          >
            <FlaskConical size={12} />
            Open Chat Sandbox
          </Link>
        </div>
      </Drawer.Content>
    </Drawer.Root>
  );
}
