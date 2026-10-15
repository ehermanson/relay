import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, stat, realpath } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");

export async function extractSignedTestPayload(asar, archive, destination) {
  asar.extractAll(archive, destination);
  // ASAR headers do not retain executable flags for unpacked files. Preserve
  // their actual filesystem modes, notably node-pty's native spawn helper.
  await cp(`${archive}.unpacked`, destination, { recursive: true, force: true });
}

export function selectDeveloperIdentity(output) {
  const matches = [
    ...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"(Developer ID Application: [^"]+)"/g),
  ];
  if (!matches.length)
    throw new Error("A valid Developer ID Application identity in the local keychain is required");
  return { hash: matches[0][1], name: matches[0][2] };
}

export function updateMetadata(version, filename, bytes) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[A-Za-z0-9._-]+\.zip$/.test(filename))
    throw new Error("Invalid local update metadata");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  return `version: ${version}\nfiles:\n  - url: ${filename}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${filename}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;
}

export function feedHandler(files) {
  return async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const file = files.get(pathname);
    if (!file || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const info = await stat(file);
      response.writeHead(200, {
        "Content-Length": info.size,
        "Content-Type": pathname.endsWith(".zip") ? "application/zip" : "text/yaml",
        "Cache-Control": "no-store",
      });
      if (request.method === "HEAD") response.end();
      else
        createReadStream(file)
          .on("error", () => response.destroy())
          .pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function run() {
  if (process.platform !== "darwin")
    throw new Error("The signed update integration test requires macOS");
  const sourceApp = resolve(
    argument(
      "--app",
      join(
        projectRoot,
        "desktop-release",
        `mac${process.arch === "arm64" ? "-arm64" : ""}`,
        "Relay.app",
      ),
    ),
  );
  const output = resolve(
    argument("--output", join(projectRoot, "desktop-release", "signed-update-test.json")),
  );
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const asar = builderRequire("@electron/asar");
  const { signAsync } = builderRequire("@electron/osx-sign");
  const plist = builderRequire("plist");
  const { stdout } = await execute("security", ["find-identity", "-v", "-p", "codesigning"]);
  const identity = selectDeveloperIdentity(stdout);
  await stat(join(sourceApp, "Contents", "Resources", "app.asar"));
  const root = await mkdtemp(join(await realpath(tmpdir()), "relay-signed-update-"));
  const runId = randomBytes(12).toString("hex");
  const files = new Map();
  const feed = createServer(feedHandler(files));
  await new Promise((resolve, reject) => {
    feed.once("error", reject);
    feed.listen(0, "127.0.0.1", resolve);
  });
  const config = {
    runId,
    root,
    url: `http://127.0.0.1:${feed.address().port}/`,
    home: join(root, "home"),
    resultPath: join(root, "result.json"),
    fromVersion: "3.0.0",
    toVersion: "3.0.1",
  };
  let child;
  let succeeded = false;
  console.info(`SIGNED_UPDATE_TEST_ROOT ${root}`);
  try {
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    const extracted = join(root, "extracted");
    await extractSignedTestPayload(
      asar,
      join(sourceApp, "Contents", "Resources", "app.asar"),
      extracted,
    );
    // Test the current native lifecycle using the already-built production payload.
    await cp(join(projectRoot, "desktop"), join(extracted, "desktop"), { recursive: true });
    const manifestPath = join(extracted, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const bundleId = `com.relay.desktop.signedtest.${runId}`;
    const current = join(root, "current", "Relay.app");
    const next = join(root, "next", "Relay.app");
    for (const [target, version] of [
      [current, config.fromVersion],
      [next, config.toVersion],
    ]) {
      console.info(`Preparing and signing ${version}`);
      await mkdir(resolve(target, ".."), { recursive: true });
      await execute("ditto", [sourceApp, target]);
      const resources = join(target, "Contents", "Resources");
      const archive = join(resources, "app.asar");
      await rm(archive, { force: true });
      await rm(`${archive}.unpacked`, { recursive: true, force: true });
      await writeFile(
        manifestPath,
        JSON.stringify(
          { ...manifest, version, desktopRelease: true, desktopSignedUpdateTest: config },
          null,
          2,
        ),
      );
      await asar.createPackageWithOptions(extracted, archive, {
        unpack: "**/*.node",
        unpackDir:
          "node_modules/{node-pty,@anthropic-ai/claude-agent-sdk,@anthropic-ai/claude-agent-sdk-*}",
      });
      const infoPath = join(target, "Contents", "Info.plist");
      const info = plist.parse(await readFile(infoPath, "utf8"));
      info.CFBundleIdentifier = bundleId;
      info.CFBundleShortVersionString = version;
      info.CFBundleVersion = version;
      delete info.CFBundleURLTypes;
      info.ElectronAsarIntegrity = {
        "Resources/app.asar": {
          algorithm: "SHA256",
          hash: createHash("sha256").update(asar.getRawHeader(archive).headerString).digest("hex"),
        },
      };
      await writeFile(infoPath, plist.build(info));
      await writeFile(
        join(resources, "app-update.yml"),
        `provider: generic\nurl: ${config.url}\nupdaterCacheDirName: relay-signed-test-${runId}\n`,
      );
      // Use identical official Electron entitlements for each version; preserve
      // hardened runtime and ordinary signing verification. No Gatekeeper bypass.
      await signAsync({
        app: target,
        identity: identity.hash,
        platform: "darwin",
        type: "distribution",
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: () => ({ timestamp: "none", hardenedRuntime: true }),
      });
      await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", target]);
    }
    const filename = "Relay-3.0.1-mac.zip";
    const archive = join(root, filename);
    console.info("Creating signed update ZIP");
    await execute("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", next, archive], {
      timeout: 180000,
    });
    const metadata = join(root, "latest-mac.yml");
    await writeFile(metadata, updateMetadata(config.toVersion, filename, await readFile(archive)));
    files.set(`/${filename}`, archive);
    files.set("/latest-mac.yml", metadata);
    const env = {
      ...process.env,
      RELAY_DESKTOP_HOME: config.home,
      RELAY_DESKTOP_SMOKE: "1",
      RELAY_DESKTOP_BENCHMARK: "1",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.RELAY_DESKTOP_SERVER_URL;
    delete env.RELAY_DESKTOP_UPDATE_SMOKE;
    const logs = [];
    child = spawn(join(current, "Contents", "MacOS", "Relay"), [], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => logs.push(String(error)));
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        const text = data.toString();
        logs.push(text);
        process.stdout.write(text);
      });
    const deadline = Date.now() + 180000;
    let result;
    while (Date.now() < deadline) {
      try {
        result = JSON.parse(await readFile(config.resultPath, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await writeFile(join(root, "launch.log"), logs.join(""));
    if (
      !result?.ok ||
      result.version !== config.toVersion ||
      result.oldVersion !== config.fromVersion
    )
      throw new Error(
        `Real signed update did not complete: ${JSON.stringify(result ?? null)}; inspect ${root}`,
      );
    const before = JSON.parse(await readFile(join(root, "before.json"), "utf8"));
    if (
      result.origin !== before.origin ||
      result.identity !== before.identity ||
      result.prior !== "persisted" ||
      !Number.isInteger(result.pid) ||
      result.pid === before.pid
    )
      throw new Error("Signed update failed to preserve state across a real process relaunch");
    const installed = plist.parse(await readFile(join(current, "Contents", "Info.plist"), "utf8"));
    if (installed.CFBundleShortVersionString !== config.toVersion)
      throw new Error("Relaunch report did not match the replaced app bundle");
    await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", current]);
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          ...result,
          signatureVerified: true,
          notarizationVerified: false,
          provider: "local-loopback",
          artifacts: root,
        },
        null,
        2,
      ),
    );
    succeeded = true;
    console.info(`SIGNED_UPDATE_TEST_PASSED ${output}`);
  } finally {
    feed.closeAllConnections();
    await new Promise((resolve) => feed.close(resolve));
    // Keep signed bundles/logs for review. Only this explicitly launched child is
    // stopped on failure; never touch an installed Relay or unrelated process.
    if (!succeeded && child && child.exitCode === null) child.kill("SIGTERM");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await run();
