import { resolve } from "node:path";
import { disableTunnel, readTunnelSettings, saveTunnelSettings } from "#server/tunnel-settings.js";

const usage = `Usage:
  relay tunnel configure --url https://relay.example.com --token-file /path/to/token
  relay tunnel status
  relay tunnel disable

First create a named tunnel in Cloudflare and route the hostname to http://localhost:7777
(or your Relay port). Save its connector token in a file, then import it with configure.
Configured tunnels start automatically with relay start. Use --no-tunnel to skip one run.
Restart Relay after changing tunnel settings.`;

export async function runTunnelCommand(
  args: string[],
  options: { home?: string; stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): Promise<number> {
  const out = options.stdout ?? console.log;
  const err = options.stderr ?? console.error;
  try {
    if (!args.length || args[0] === "--help" || args[0] === "-h") {
      out(usage);
      return 0;
    }
    if (args[0] === "configure") {
      const flags = new Map<string, string>();
      for (let i = 1; i < args.length; i += 2) {
        if (
          !["--url", "--token-file"].includes(args[i]) ||
          !args[i + 1] ||
          args[i + 1].startsWith("--") ||
          flags.has(args[i])
        ) {
          throw new Error(usage);
        }
        flags.set(args[i], args[i + 1]);
      }
      const url = flags.get("--url");
      const tokenFile = flags.get("--token-file");
      if (!url || !tokenFile) throw new Error(usage);
      const settings = await saveTunnelSettings(url, resolve(tokenFile), options.home);
      out(
        `Saved permanent URL: ${settings.publicUrl}\nStart or restart Relay to connect. Set RELAY_PASSWORD or use --password for login.`,
      );
      return 0;
    }
    if (args.length !== 1) throw new Error(usage);
    if (args[0] === "status") {
      const settings = await readTunnelSettings(options.home);
      out(
        settings
          ? `Permanent URL: ${settings.publicUrl}\nStarts automatically with relay start; this does not check connectivity.`
          : "No named tunnel configured.",
      );
      return 0;
    }
    if (args[0] === "disable") {
      await disableTunnel(options.home);
      out(
        "Named tunnel disabled. Restart Relay to stop an existing connector. The tunnel and hostname remain in Cloudflare.",
      );
      return 0;
    }
    throw new Error(usage);
  } catch (error) {
    err(error instanceof Error ? error.message : "Tunnel configuration failed");
    return 1;
  }
}
