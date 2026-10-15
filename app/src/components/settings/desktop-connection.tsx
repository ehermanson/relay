import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-shared";
import { getDesktop, type DesktopConnection } from "@/lib/desktop";

export function DesktopConnectionSetting() {
  const desktop = getDesktop();
  const { data, error: loadError } = useQuery({
    queryKey: ["desktop-connection"],
    queryFn: () => desktop!.getConnection(),
    enabled: !!desktop,
    staleTime: Infinity,
  });
  const [mode, setMode] = useState<DesktopConnection["mode"]>("local");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (data) {
      setMode(data.mode);
      setUrl(data.url ?? "");
    }
  }, [data]);
  if (!desktop) return null;
  const save = async () => {
    setError(undefined);
    setBusy(true);
    try {
      await desktop.setConnection(mode === "local" ? { mode } : { mode, url: url.trim() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change Relay server");
      setBusy(false);
    }
  };
  return (
    <SettingRow
      label="Relay server"
      description="Run agents on this computer, or connect this window to an existing Relay server. Changing this restarts the desktop app."
      vertical
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="desktop-connection"
            checked={mode === "local"}
            disabled={busy || !data}
            onChange={() => setMode("local")}
          />
          Run locally
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="desktop-connection"
            checked={mode === "existing"}
            disabled={busy || !data}
            onChange={() => setMode("existing")}
          />
          Connect to existing Relay
        </label>
        {mode === "existing" && (
          <>
            <Input
              aria-label="Relay server URL"
              placeholder="https://relay.example.com"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted">
              Use HTTPS, or HTTP on localhost. Sign in using the server’s normal login screen.
            </p>
          </>
        )}
        <Button
          className="self-start"
          disabled={
            busy ||
            !data ||
            (mode === data.mode && (mode === "local" || url.trim() === data.url)) ||
            (mode === "existing" && !url.trim())
          }
          onClick={() => void save()}
        >
          {busy ? "Restarting…" : "Save and Restart"}
        </Button>
        {(error || loadError) && (
          <p role="alert" className="text-xs text-destructive">
            {error || "Could not load server settings"}
          </p>
        )}
      </div>
    </SettingRow>
  );
}
