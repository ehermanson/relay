import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  const [shared, setShared] = useState(false);
  const [share, setShare] = useState(false);
  const [port, setPort] = useState("7777");
  // Empty means "leave the password as it is".
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (data) {
      setMode(data.mode);
      setUrl(data.url ?? "");
      if (data.local) {
        setShared(data.local.data === "shared");
        setShare(data.local.share);
        setPort(String(data.local.port));
      }
    }
  }, [data]);
  if (!desktop) return null;
  // Older app shells have no local-server options; they keep the two radios.
  const local = data?.local;
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;
  const localChanged =
    !!local &&
    (shared !== (local.data === "shared") ||
      share !== local.share ||
      (share && (portNumber !== local.port || password !== "" || removePassword)));
  const willHavePassword = password !== "" || (!!local?.hasPassword && !removePassword);
  const save = async () => {
    setError(undefined);
    setBusy(true);
    try {
      if (mode === "existing") await desktop.setConnection({ mode, url: url.trim() });
      else if (!local) await desktop.setConnection({ mode });
      else
        await desktop.setConnection({
          mode,
          local: {
            data: shared ? "shared" : "private",
            share,
            port: share ? portNumber : local.port,
            ...(removePassword ? { password: null } : password ? { password } : {}),
          },
        });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change Relay server");
      setBusy(false);
    }
  };
  const runImport = async () => {
    setError(undefined);
    setBusy(true);
    try {
      await desktop.importPrivateData?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the import");
      setBusy(false);
    }
  };
  const unchanged =
    !data || (mode === data.mode && (mode === "local" ? !localChanged : url.trim() === data.url));
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
        {mode === "local" && local && (
          <div className="ml-6 flex flex-col gap-3 border-l border-border pl-4">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm text-text">Use my existing Relay data</span>
                <span className="block text-xs text-muted">
                  The same Projects, chats and settings as <code>relay start</code>
                  {data?.sharedHome ? ` (${data.sharedHome})` : ""}. Only one of the two can run at
                  a time. Off: this app keeps its own separate data.
                </span>
              </span>
              <Switch
                aria-label="Use my existing Relay data"
                checked={shared}
                disabled={busy}
                onCheckedChange={setShared}
              />
            </label>
            {data?.lastImport && (
              <p className={`text-xs ${data.lastImport.ok ? "text-muted" : "text-destructive"}`}>
                {data.lastImport.ok
                  ? `Imported ${data.lastImport.chats ?? 0} chats and ${data.lastImport.projects ?? 0} Projects from this app's separate data.`
                  : `Import did not run: ${data.lastImport.error ?? "unknown error"}`}
              </p>
            )}
            {data?.privateData && desktop.importPrivateData && (
              <div className="flex flex-col items-start gap-1.5">
                <p className="text-xs text-muted">
                  This app still has the separate data it used before. Importing adds its Projects
                  and chats to your existing Relay data. Nothing already there is changed, a backup
                  is taken first, and the separate data is left in place.
                </p>
                {confirmImport ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void runImport()}
                    >
                      {busy ? "Restarting…" : "Import and Restart"}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => setConfirmImport(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" disabled={busy} onClick={() => setConfirmImport(true)}>
                    Import chats from this app's separate data…
                  </Button>
                )}
              </div>
            )}
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm text-text">Allow browser and phone access</span>
                <span className="block text-xs text-muted">
                  Serve Relay to other devices the way <code>relay start</code> does, including a
                  saved tunnel. It stops when you quit this app, so turning this on also keeps Relay
                  running when its window is closed.
                </span>
              </span>
              <Switch
                aria-label="Allow browser and phone access"
                checked={share}
                disabled={busy}
                onCheckedChange={setShare}
              />
            </label>
            {share && (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Port
                    <Input
                      aria-label="Port"
                      className="w-24"
                      inputMode="numeric"
                      value={port}
                      onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))}
                      disabled={busy}
                    />
                  </label>
                  <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted">
                    Password
                    <Input
                      aria-label="Password"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        local.hasPassword && !removePassword ? "Unchanged" : "None (open access)"
                      }
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setRemovePassword(false);
                      }}
                      disabled={busy}
                    />
                  </label>
                </div>
                {local.hasPassword && (
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={removePassword}
                      disabled={busy || password !== ""}
                      onChange={(event) => setRemovePassword(event.target.checked)}
                    />
                    Remove the password
                  </label>
                )}
                {!portValid && (
                  <p className="text-xs text-destructive">
                    Port must be a number from 1024 to 65535.
                  </p>
                )}
                {!willHavePassword && (
                  <p className="text-xs text-warning">
                    Without a password, anyone who can reach this computer on your network can use
                    Relay. Set one unless something else (a tunnel with its own sign-in) protects
                    it.
                  </p>
                )}
              </>
            )}
          </div>
        )}
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
            unchanged ||
            (mode === "existing" && !url.trim()) ||
            (mode === "local" && share && !portValid)
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
