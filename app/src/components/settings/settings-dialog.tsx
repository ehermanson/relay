import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, Cpu, Settings2, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  GeneralSettingsSection,
  InstructionsSettingsSection,
  ProvidersSettingsSection,
  SuggestionsSettingsSection,
} from "@/pages/global-settings-page";
import { SettingsSectionBoundary } from "@/components/settings/settings-shared";
import { useSettingsDialog, type SettingsSection } from "@/stores/settings-dialog-store";

const NAV_ITEMS: {
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Settings2;
}[] = [
  {
    id: "general",
    label: "General",
    description: "Appearance and default behaviors",
    icon: Settings2,
  },
  {
    id: "providers",
    label: "Providers",
    description: "AI provider configuration",
    icon: Cpu,
  },
  {
    id: "suggestions",
    label: "Suggestions",
    description: "Prompt suggestions for new chats",
    icon: Sparkles,
  },
];

function SectionContent({ section }: { section: SettingsSection }) {
  if (section === "providers") {
    return (
      <SettingsSectionBoundary name="Providers">
        <ProvidersSettingsSection />
      </SettingsSectionBoundary>
    );
  }
  if (section === "suggestions") {
    return (
      <SettingsSectionBoundary name="Suggestions">
        <SuggestionsSettingsSection />
      </SettingsSectionBoundary>
    );
  }
  return (
    <div className="space-y-10">
      <SettingsSectionBoundary name="General">
        <GeneralSettingsSection />
      </SettingsSectionBoundary>
      <SettingsSectionBoundary name="Global Instructions">
        <InstructionsSettingsSection />
      </SettingsSectionBoundary>
    </div>
  );
}

const CLOSE_CLASS =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text max-[768px]:h-10 max-[768px]:w-10";

function CloseButton({ className = "" }: { className?: string }) {
  return (
    <BaseDialog.Close aria-label="Close settings" className={`${CLOSE_CLASS} ${className}`}>
      <X size={16} />
    </BaseDialog.Close>
  );
}

/** Phones: the dialog fills the screen and steps from the section list into one section. */
function MobileSettings({
  section,
  setSection,
}: {
  section: SettingsSection | null;
  setSection: (section: SettingsSection | null) => void;
}) {
  const active = NAV_ITEMS.find((item) => item.id === section);
  let header: ReactNode;
  let body: ReactNode;
  if (!active) {
    header = (
      <BaseDialog.Title className="flex-1 pl-2 text-lg font-bold text-text-bright">
        Settings
      </BaseDialog.Title>
    );
    body = (
      <ul className="px-2 py-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setSection(item.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-text transition-colors hover:bg-surface-hover"
              >
                <Icon size={18} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="text-[0.875rem] font-medium">{item.label}</div>
                  <div className="text-[0.75rem] text-muted">{item.description}</div>
                </div>
                <ChevronRight size={16} className="shrink-0 text-muted/50" />
              </button>
            </li>
          );
        })}
      </ul>
    );
  } else {
    header = (
      <>
        <button
          type="button"
          aria-label="All settings"
          onClick={() => setSection(null)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        <BaseDialog.Title className="flex-1 text-[0.875rem] font-semibold text-text-bright">
          {active.label}
        </BaseDialog.Title>
      </>
    );
    body = (
      <div className="px-4 py-5">
        <SectionContent section={active.id} />
      </div>
    );
  }
  return (
    <div className="pointer-events-auto flex h-full w-full flex-col bg-bg pt-[var(--app-top-inset)]">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2 py-2">
        {header}
        <CloseButton />
      </div>
      <div key={active?.id ?? "list"} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {body}
      </div>
    </div>
  );
}

function DesktopSettings({
  section,
  setSection,
}: {
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
}) {
  return (
    <div className="pointer-events-auto relative flex h-full max-h-[66rem] w-full max-w-[86rem] overflow-hidden rounded-xl border border-border/70 bg-bg shadow-2xl animate-fade-in">
      <nav className="w-52 shrink-0 overflow-y-auto border-r border-border bg-surface px-3 py-5">
        <BaseDialog.Title className="mb-4 px-2 text-lg font-bold text-text-bright">
          Settings
        </BaseDialog.Title>
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.id === section;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[0.8125rem] font-medium transition-colors ${
                    active
                      ? "bg-accent/10 text-accent"
                      : "text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <Icon size={15} />
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {/* Keyed by section so each one starts at the top. */}
      <div key={section} className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl px-8 py-7">
          <SectionContent section={section} />
        </div>
      </div>
      <CloseButton className="absolute right-3 top-3" />
    </div>
  );
}

/**
 * Global Settings as a near-full-size dialog (full screen on phones). Mounted
 * once in the app layout and opened through `useSettingsDialog`.
 */
export function SettingsDialog() {
  const { open, section, setSection, close } = useSettingsDialog();
  const isMobile = useMediaQuery("(max-width: 768px)");
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm animate-fade-in" />
        <BaseDialog.Popup
          className={`pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center ${isMobile ? "" : "p-10"}`}
        >
          {isMobile ? (
            <MobileSettings section={section} setSection={setSection} />
          ) : (
            <DesktopSettings section={section ?? "general"} setSection={setSection} />
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
