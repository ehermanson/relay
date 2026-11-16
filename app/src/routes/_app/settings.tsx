import { createFileRoute, redirect } from "@tanstack/react-router";
import { isSettingsSection, openSettings } from "@/stores/settings-dialog-store";

// Settings is a dialog now (`SettingsDialog`), not a page. Old URLs
// (/settings, /settings/providers, …) still work: they open the dialog on
// that section over Home.
export const Route = createFileRoute("/_app/settings")({
  beforeLoad: ({ location }) => {
    const section = location.pathname.split("/")[2];
    openSettings(isSettingsSection(section) ? section : undefined);
    throw redirect({ to: "/" });
  },
});
