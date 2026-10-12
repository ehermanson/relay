import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
const root = join(import.meta.dirname, "..");
const stage = join(root, ".desktop-stage");
function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
const release = process.argv.includes("--publish") || process.argv.includes("--signed");
if (release && process.platform === "darwin") {
  const notarize =
    (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
    (process.env.APPLE_ID &&
      process.env.APPLE_APP_SPECIFIC_PASSWORD &&
      process.env.APPLE_TEAM_ID) ||
    process.env.APPLE_KEYCHAIN_PROFILE;
  if (!notarize)
    throw new Error("Release builds require macOS notarization credentials or a keychain profile");
}
if (release && process.platform === "win32" && !process.env.CSC_LINK)
  throw new Error("Release builds require a Windows signing certificate");
await run("pnpm", ["build"]);
await rm(stage, { recursive: true, force: true });
await run("pnpm", ["--filter", "relay", "deploy", "--prod", "--legacy", stage]);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "relay-desktop",
      version: process.env.RELAY_DESKTOP_VERSION || manifest.version,
      desktopRelease: process.argv.includes("--publish") || process.argv.includes("--signed"),
      desktopSourceCommit: process.env.RELAY_DESKTOP_COMMIT || null,
      description: manifest.description,
      author: "Relay",
      type: "module",
      main: "desktop/main.mjs",
      imports: manifest.imports,
      dependencies: manifest.dependencies,
    },
    null,
    2,
  ),
);
await Promise.all(
  ["desktop", "dist", "app/dist", "app/public"].map(async (path) => {
    await mkdir(join(stage, path, ".."), { recursive: true });
    await cp(join(root, path), join(stage, path), { recursive: true });
  }),
);
await run("pnpm", [
  "exec",
  "electron-builder",
  "--config",
  "desktop/builder.json",
  ...(process.argv.includes("--dir")
    ? ["--dir", ...(!process.argv.includes("--signed") ? ["--config.mac.identity=null"] : [])]
    : []),
  "--publish",
  process.argv.includes("--publish") ? "always" : "never",
]);
