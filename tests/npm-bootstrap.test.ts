import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

type Stat = { uid: number; size: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
type SetupOptions = {
  platform: string; arch: string; uid: number; home: string; env: NodeJS.ProcessEnv; root: string;
  readFile(path: string, encoding?: BufferEncoding): string | Buffer; lstat(path: string): Stat; readlink(path: string): string;
  spawn(command: string, args: string[], options: { shell: boolean; stdio: string; env: NodeJS.ProcessEnv }): { status: number | null; error?: Error };
  log(message: string): void;
};
const { compareStableVersions, installationPlan, nativeRootFromLink, resolveInstallRoot, runSetup } = await import(
  new URL("../apps/npm/bin/terminal-plus-setup.mjs", import.meta.url).href
) as {
  compareStableVersions(a: string, b: string): number;
  installationPlan(version: string, installedVersion?: string): { skip: boolean; argument: string };
  nativeRootFromLink(bin: string, link?: string): string | undefined;
  resolveInstallRoot(home: string, env: NodeJS.ProcessEnv, nativeLink?: string): string;
  runSetup(args?: string[], options?: Partial<SetupOptions>): number;
};

function fixture() {
  const home = resolve(tmpdir(), "npm-pilot-user"), npmRoot = join(home, "npm package with ' quotes");
  const root = join(home, ".local/lib/even-pilot"), bin = join(home, ".local/bin/terminal-plus"), legacyBin = join(home, ".local/bin/even-pilot");
  const installerName = "artifacts/Terminal-plus-1.1.11-Setup-linux-x64.run";
  const installer = resolve(npmRoot, installerName), bytes = Buffer.from("verified installer fixture\n");
  const metadata = { version: "1.1.11", arch: "x64", installer: installerName, sha256: createHash("sha256").update(bytes).digest("hex") };
  type Entry = { type: "file" | "directory" | "link"; contents?: Buffer; link?: string; uid?: number };
  const entries = new Map<string, Entry>();
  const calls: { command: string; args: string[]; options: { shell: boolean; stdio: string; env: NodeJS.ProcessEnv } }[] = [];
  const output: string[] = [];
  const put = (path: string, entry: Entry) => entries.set(resolve(path), entry);
  const file = (path: string, value: unknown) => put(path, { type: "file", contents: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)) });
  put(home, { type: "directory" }); put(npmRoot, { type: "directory" }); put(join(npmRoot, "artifacts"), { type: "directory" });
  file(join(npmRoot, "payload.json"), metadata); file(installer, bytes);
  const missing = () => Object.assign(new Error("Missing fixture path"), { code: "ENOENT" });
  const options: SetupOptions = {
    platform: "linux", arch: "x64", uid: 1000, home, env: {}, root: npmRoot,
    readFile(path, encoding) { const entry = entries.get(resolve(path)); if (!entry?.contents) throw missing(); return encoding ? entry.contents.toString(encoding) : entry.contents; },
    lstat(path) {
      const entry = entries.get(resolve(path)); if (!entry) throw missing();
      return { uid: entry.uid ?? 1000, size: entry.contents?.length ?? 0,
        isFile: () => entry.type === "file", isDirectory: () => entry.type === "directory", isSymbolicLink: () => entry.type === "link" };
    },
    readlink(path) { const entry = entries.get(resolve(path)); if (!entry?.link) throw missing(); return entry.link; },
    spawn(command, args, childOptions) { calls.push({ command, args, options: childOptions }); return { status: 0 }; },
    log(message) { output.push(message); }
  };
  function installed(version: string, installRoot = root, legacy = false) {
    const current = version + "-123456abcdef", selected = join(installRoot, "versions", current);
    put(installRoot, { type: "directory" }); put(join(installRoot, "versions"), { type: "directory" }); put(selected, { type: "directory" });
    put(join(installRoot, "current"), { type: "link", link: "versions/" + current });
    const nativeLauncher = legacy ? "even-pilot" : "terminal-plus";
    put(legacy ? legacyBin : bin, { type: "link", link: join(installRoot, "current/bin", nativeLauncher) });
    file(join(installRoot, "install.json"), { version, current, versions: [current] });
    file(join(selected, "installed.json"), { format: 1 });
    const runtimeFiles = [
      ["runtime/node", "native runtime"], ["bin/" + nativeLauncher, "native launcher"],
      ["apps/linux/src/desktop.ts", "native desktop"], ["node_modules/tsx/dist/loader.mjs", "tsx loader"],
      ["assets/example.txt", "other verified asset"]
    ].map(([path, contents]) => {
      let directory = dirname(join(selected, path));
      while (directory !== selected) { put(directory, { type: "directory" }); directory = dirname(directory); }
      const data = Buffer.from(contents); file(join(selected, path), data);
      return { path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    });
    file(join(selected, "release.json"), { version, platform: "linux", arch: "x64", buildId: "123456abcdef", files: runtimeFiles });
  }
  return { home, npmRoot, root, bin, legacyBin, installer, metadata, entries, put, file, installed, calls, output, options };
}

test("npm setup compares stable versions numerically and avoids automatic-update downgrades", () => {
  assert.equal(compareStableVersions("1.10.0", "1.9.99"), 1);
  assert.equal(compareStableVersions("1.1.11", "1.1.11"), 0);
  assert.equal(compareStableVersions("1.1.8", "1.1.11"), -1);
  assert.deepEqual(installationPlan("1.1.11"), { skip: false, argument: "--no-start" });
  assert.deepEqual(installationPlan("1.1.11", "1.1.8"), { skip: false, argument: "--update" });
  assert.equal(installationPlan("1.1.11", "1.1.11").skip, true);
  assert.equal(installationPlan("1.1.11", "1.2.0").skip, true);
  for (const invalid of ["v1.1.11", "1.1.11-beta.1", "1.01.8", "1.1", "../1.1.11"]) assert.throws(() => compareStableVersions(invalid, "1.1.11"));
});

test("npm setup discovers native custom roots and respects explicit installation overrides", () => {
  const f = fixture(), custom = join(f.home, "custom root");
  assert.equal(nativeRootFromLink(f.bin, join(custom, "current/bin/terminal-plus")), custom);
  assert.equal(nativeRootFromLink(f.legacyBin, join(custom, "current/bin/even-pilot")), custom);
  assert.equal(nativeRootFromLink(f.bin, join(custom, "unrelated/bin/terminal-plus")), undefined);
  assert.equal(resolveInstallRoot(f.home, {}, join(custom, "current/bin/terminal-plus")), custom);
  assert.equal(resolveInstallRoot(f.home, { EVEN_PILOT_INSTALL_DIR: f.root }, join(custom, "current/bin/terminal-plus")), f.root);
  const customBin = join(f.home, "commands");
  assert.equal(resolveInstallRoot(f.home, { EVEN_PILOT_BIN_DIR: customBin }, "../custom root/current/bin/terminal-plus"), custom);
});

test("renamed npm setup follows a legacy custom installation and refuses conflicting launcher roots", () => {
  const legacy = fixture(), custom = join(legacy.home, "existing native directory");
  legacy.installed("1.1.8", custom, true);
  assert.equal(runSetup([], legacy.options), 0);
  assert.deepEqual(legacy.calls[0].args, [legacy.installer, "--dir", custom, "--update"]);
  assert.equal(legacy.entries.has(legacy.bin), false, "Bootstrap leaves launcher mutation to the verified installer");

  const conflict = fixture(); conflict.installed("1.1.8", conflict.root, true);
  conflict.put(conflict.bin, { type: "link", link: join(custom, "current/bin/terminal-plus") });
  assert.throws(() => runSetup([], conflict.options), /another installation/);
  assert.equal(conflict.calls.length, 0);
});

test("npm setup verifies the embedded installer and passes quoted paths as separate shell-free arguments", () => {
  const f = fixture();
  assert.equal(runSetup([], f.options), 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, [f.installer, "--dir", f.root, "--no-start"]);
  assert.equal(f.calls[0].command, "sh"); assert.equal(f.calls[0].options.shell, false);
  const corrupt = fixture(); corrupt.file(corrupt.installer, Buffer.from("tampered"));
  assert.throws(() => runSetup([], corrupt.options), /checksum mismatch/);
  assert.equal(corrupt.calls.length, 0);
});

test("npm setup preserves native custom roots, restarts upgrades and skips equal or newer releases", () => {
  const f = fixture(), custom = join(f.home, "native custom directory"); f.installed("1.1.8", custom);
  assert.equal(runSetup(["install"], f.options), 0);
  assert.deepEqual(f.calls[0].args, [f.installer, "--dir", custom, "--update"]);
  for (const version of ["1.1.11", "1.2.0"]) {
    const current = fixture(); current.installed(version);
    assert.equal(runSetup([], current.options), 0); assert.equal(current.calls.length, 0);
    assert.match(current.output[0], /already installed/);
  }
});

test("npm postinstall runs only for global installation and manual setup remains available", () => {
  const local = fixture(); local.options.platform = "win32";
  assert.equal(runSetup(["--postinstall"], local.options), 0); assert.equal(local.calls.length, 0);
  assert.match(local.output[0], /local npm dependency/);
  for (const global of ["true", "1"]) {
    const f = fixture(); f.options.env.npm_config_global = global;
    assert.equal(runSetup(["--postinstall"], f.options), 0); assert.equal(f.calls.length, 1);
  }
  const explicit = fixture(); assert.equal(runSetup([], explicit.options), 0); assert.equal(explicit.calls.length, 1);
});

test("npm setup rejects malformed records, conflicting launchers, linked roots and escaped payloads before installation", () => {
  const record = fixture(); record.installed("1.1.8"); record.file(join(record.root, "install.json"), { version: "1.1.8", current: "../escape", versions: ["../escape"] });
  assert.throws(() => runSetup([], record.options), /Invalid existing/); assert.equal(record.calls.length, 0);
  const conflict = fixture(); conflict.put(conflict.bin, { type: "file", contents: Buffer.from("another application") });
  assert.throws(() => runSetup([], conflict.options), /Another executable/); assert.equal(conflict.calls.length, 0);
  const linked = fixture(); linked.put(join(linked.home, ".local"), { type: "link", link: "/elsewhere" });
  assert.throws(() => runSetup([], linked.options), /regular directories/); assert.equal(linked.calls.length, 0);
  const escaped = fixture(); escaped.file(join(escaped.npmRoot, "payload.json"), { ...escaped.metadata, installer: "../" + escaped.metadata.installer });
  assert.throws(() => runSetup([], escaped.options), /inside the npm package/); assert.equal(escaped.calls.length, 0);
  const mismatch = fixture(); mismatch.installed("1.1.11"); mismatch.file(join(mismatch.root, "versions/1.1.11-123456abcdef/release.json"), { version: "1.1.8", platform: "linux", arch: "x64", buildId: "123456abcdef" });
  assert.throws(() => runSetup([], mismatch.options), /does not match/); assert.equal(mismatch.calls.length, 0);
  const broken = fixture(); broken.installed("1.1.11"); broken.entries.delete(join(broken.root, "versions/1.1.11-123456abcdef/runtime/node"));
  assert.throws(() => runSetup([], broken.options), /regular user-owned file/); assert.equal(broken.calls.length, 0);
  const linkedRuntime = fixture(); linkedRuntime.installed("1.1.11"); linkedRuntime.put(join(linkedRuntime.root, "versions/1.1.11-123456abcdef/runtime"), { type: "link", link: "/elsewhere" });
  assert.throws(() => runSetup([], linkedRuntime.options), /invalid launcher\/runtime directory/); assert.equal(linkedRuntime.calls.length, 0);
});

test("npm setup rejects sudo and other platforms, offers help, and propagates installer failures", () => {
  const rootUser = fixture(); rootUser.options.uid = 0; assert.throws(() => runSetup([], rootUser.options), /without sudo/);
  const otherPlatform = fixture(); otherPlatform.options.platform = "darwin"; assert.throws(() => runSetup([], otherPlatform.options), /requires Linux/);
  const wrongArch = fixture(); wrongArch.options.arch = "arm64"; assert.throws(() => runSetup([], wrongArch.options), /CPU architecture/);
  const help = fixture(); help.options.platform = "win32"; assert.equal(runSetup(["--help"], help.options), 0); assert.match(help.output[0], /Usage:/); assert.equal(help.calls.length, 0);
  assert.throws(() => runSetup(["--uninstall"], help.options), /Usage:/);
  const failed = fixture(); failed.options.spawn = () => ({ status: 7 }); assert.equal(runSetup([], failed.options), 7);
  const unavailable = fixture(); unavailable.options.spawn = () => ({ status: null, error: new Error("sh unavailable") });
  assert.throws(() => runSetup([], unavailable.options), /sh unavailable/);
});

test("npm setup verifies installed contents before retaining equal or newer releases", () => {
  for (const version of ["1.1.11", "1.2.0"]) {
    const f = fixture(); f.installed(version);
    f.file(join(f.root, "versions", version + "-123456abcdef/runtime/node"), Buffer.from("broken runtime"));
    assert.throws(() => runSetup([], f.options), /Current installation verification failed: runtime\/node/);
    assert.equal(f.calls.length, 0); assert.equal(f.output.length, 0);
  }
  const asset = fixture(); asset.installed("1.1.11");
  asset.file(join(asset.root, "versions/1.1.11-123456abcdef/assets/example.txt"), Buffer.from("other corrupted data"));
  assert.throws(() => runSetup([], asset.options), /Current installation verification failed: assets\/example.txt/);
  const absentLauncher = fixture(); absentLauncher.installed("1.1.11"); absentLauncher.entries.delete(absentLauncher.bin);
  assert.throws(() => runSetup([], absentLauncher.options), /launcher is missing/);
  const linkedSource = fixture(); linkedSource.installed("1.1.11");
  linkedSource.put(join(linkedSource.root, "versions/1.1.11-123456abcdef/apps/linux"), { type: "link", link: "/unrelated" });
  assert.throws(() => runSetup([], linkedSource.options), /missing or linked directory/);
  const manifest = fixture(); manifest.installed("1.1.11");
  const manifestPath = join(manifest.root, "versions/1.1.11-123456abcdef/release.json");
  const release = JSON.parse(String(manifest.options.readFile(manifestPath, "utf8")));
  release.files = release.files.filter((entry: { path: string }) => entry.path !== "node_modules/tsx/dist/loader.mjs");
  manifest.file(manifestPath, release);
  assert.throws(() => runSetup([], manifest.options), /missing a required runtime file/);
  release.files.push({ path: "../escape", bytes: 0, sha256: "0".repeat(64) }); manifest.file(manifestPath, release);
  assert.throws(() => runSetup([], manifest.options), /invalid file manifest/);
});
