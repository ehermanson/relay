import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import { X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

function DrawerRoot({ open, onOpenChange, children }: DrawerProps) {
  return (
    <BaseDrawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="right">
      {children}
    </BaseDrawer.Root>
  );
}

interface DrawerContentProps {
  children: ReactNode;
  className?: string;
  /** Width class. Default: "w-[420px] max-w-[85vw]" */
  width?: string;
  /** Inline styles forwarded to the popup element (used for stacking transforms) */
  style?: CSSProperties;
  /** Show dark backdrop overlay. Default: true. When false, backdrop is invisible but still captures clicks. */
  showBackdrop?: boolean;
}

function DrawerContent({
  children,
  className = "",
  width = "w-[420px] max-w-[85vw]",
  style,
  showBackdrop = true,
}: DrawerContentProps) {
  return (
    <BaseDrawer.Portal>
      <BaseDrawer.Backdrop
        className={`fixed inset-0 z-[9999] transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 ${showBackdrop ? "bg-black/40 backdrop-blur-sm" : ""}`}
      />
      <BaseDrawer.Popup
        className={`fixed inset-y-0 right-0 z-[9999] flex ${width} flex-col border-l border-border/70 bg-surface pt-[var(--app-top-inset)] shadow-2xl transition-[transform,translate,scale,box-shadow,opacity] duration-200 ease-out data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full ${className}`}
        style={style}
      >
        {children}
      </BaseDrawer.Popup>
    </BaseDrawer.Portal>
  );
}

function DrawerHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex items-center justify-between border-b border-border px-5 py-4 ${className}`}
    >
      {children}
    </div>
  );
}

function DrawerTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <BaseDrawer.Title className={`text-[0.9375rem] font-semibold text-text-bright ${className}`}>
      {children}
    </BaseDrawer.Title>
  );
}

function DrawerClose({ className = "" }: { className?: string }) {
  return (
    <BaseDrawer.Close
      className={`flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text ${className}`}
    >
      <X size={16} />
    </BaseDrawer.Close>
  );
}

function DrawerBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex-1 overflow-y-auto ${className}`}>{children}</div>;
}

export const Drawer = {
  Root: DrawerRoot,
  Content: DrawerContent,
  Header: DrawerHeader,
  Title: DrawerTitle,
  Close: DrawerClose,
  Body: DrawerBody,
};
