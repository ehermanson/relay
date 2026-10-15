import { DesktopConnectionSetting } from "@/components/settings/desktop-connection";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/settings/settings-shared";
import { getDesktop, type DesktopPreferences } from "@/lib/desktop";

export function DesktopSettings() {
  const desktop = getDesktop();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { data, error: loadError } = useQuery({
    queryKey: ["desktop-preferences"],
    queryFn: () => desktop!.getPreferences(),
    enabled: !!desktop,
    staleTime: Infinity,
  });
  if (!desktop) return null;
  const update = async (patch: Partial<DesktopPreferences>) => {
    setBusy(true);
    setError(undefined);
    try {
      client.setQueryData(["desktop-preferences"], await desktop.setPreferences(patch));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update desktop preferences");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingRow
        label="Launch at login"
        description={
          desktop.capabilities?.launchAtLogin
            ? "Start Relay when you sign in to this computer."
            : "Available in an installed macOS or Windows app."
        }
      >
        <Switch
          aria-label="Launch at login"
          checked={data?.launchAtLogin ?? false}
          disabled={busy || !data || !desktop.capabilities?.launchAtLogin}
          onCheckedChange={(launchAtLogin) => void update({ launchAtLogin })}
        />
      </SettingRow>
      <SettingRow
        label="Desktop notifications"
        description="Get a native notification when a background chat needs input or finishes responding."
      >
        <Switch
          aria-label="Desktop notifications"
          checked={data?.notifications ?? false}
          disabled={busy || !data}
          onCheckedChange={(notifications) => void update({ notifications })}
        />
      </SettingRow>
      <SettingRow
        label="Keep running when closed"
        description="Close the window while chats keep running. Reopen Relay from the menu bar or system tray."
      >
        <Switch
          aria-label="Keep running when closed"
          checked={data?.closeToTray ?? false}
          disabled={busy || !data}
          onCheckedChange={(closeToTray) => void update({ closeToTray })}
        />
      </SettingRow>
      <SettingRow
        label="Global shortcut"
        description="Press Command/Control + Shift + Space from any app to show Relay."
      >
        <Switch
          aria-label="Global shortcut"
          checked={data?.globalShortcut ?? false}
          disabled={busy || !data}
          onCheckedChange={(globalShortcut) => void update({ globalShortcut })}
        />
      </SettingRow>
      {desktop.capabilities?.multipleWindows && (
        <SettingRow
          label="Another window"
          description="Open a second Relay window connected to the same server."
        >
          <Button
            onClick={() => {
              void desktop
                .newWindow(window.location.pathname)
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : "Could not open window"),
                );
            }}
          >
            New Window
          </Button>
        </SettingRow>
      )}
      <DesktopConnectionSetting />
      {(error || loadError) && (
        <p role="alert" className="text-xs text-destructive">
          {error || "Could not load desktop preferences"}
        </p>
      )}
    </>
  );
}
