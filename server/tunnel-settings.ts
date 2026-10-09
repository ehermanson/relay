import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { relayDir } from "#core/config.js";

export interface NamedTunnelSettings {
  publicUrl: string;
  tokenFile: string;
}

/** A named tunnel serves one HTTPS origin, never a path or a URL with credentials. */
export function normalizeTunnelUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Tunnel URL must be an HTTPS address, for example https://relay.example.com");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(url.hostname)
  ) {
    throw new Error("Tunnel URL must be an HTTPS hostname without a path, port, or credentials");
  }
  return url.origin;
}

export async function readTunnelSettings(home = relayDir): Promise<NamedTunnelSettings | null> {
  let raw: string;
  try {
    raw = await readFile(join(home, "tunnel.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const data = JSON.parse(raw);
  if (
    !data ||
    typeof data.publicUrl !== "string" ||
    typeof data.tokenFile !== "string" ||
    !/^tunnel-token-[a-f0-9-]+$/.test(data.tokenFile)
  ) {
    throw new Error("Invalid tunnel.json. Run relay tunnel configure again.");
  }
  return { publicUrl: normalizeTunnelUrl(data.publicUrl), tokenFile: join(home, data.tokenFile) };
}

async function atomicPrivateWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Import the connector token; never keep it in argv, JSON configuration, or API responses. */
export async function saveTunnelSettings(
  publicUrl: string,
  sourceTokenFile: string,
  home = relayDir,
): Promise<NamedTunnelSettings> {
  const origin = normalizeTunnelUrl(publicUrl);
  // A fresh configure can repair a malformed file; clean up a valid previous credential afterward.
  const previous = await readTunnelSettings(home).catch(() => null);
  const token = (await readFile(sourceTokenFile, "utf8")).trim();
  if (!token || !/^[a-zA-Z0-9_+/=-]+$/.test(token)) {
    throw new Error("Token file must contain only a Cloudflare tunnel connector token");
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const tokenName = `tunnel-token-${randomUUID()}`;
  const tokenFile = join(home, tokenName);
  await atomicPrivateWrite(tokenFile, `${token}\n`);
  try {
    await atomicPrivateWrite(
      join(home, "tunnel.json"),
      `${JSON.stringify({ publicUrl: origin, tokenFile: tokenName }, null, 2)}\n`,
    );
  } catch (error) {
    await unlink(tokenFile);
    throw error;
  }
  if (previous) await unlink(previous.tokenFile).catch(() => {});
  return { publicUrl: origin, tokenFile };
}

export async function disableTunnel(home = relayDir): Promise<void> {
  const settings = await readTunnelSettings(home);
  if (!settings) return;
  // Remove the auto-start configuration first. Existing connectors stop on server shutdown.
  await unlink(join(home, "tunnel.json"));
  await unlink(join(home, basename(settings.tokenFile))).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
