import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const skip = process.platform !== "linux" || process.getuid?.() === 0;
function fixture(t: any, shell = "/bin/bash") {
  const directory = mkdtempSync(join(tmpdir(), "pilot-path-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home"), source = join(directory, "payload"), root = join(directory, "installation"), bin = join(directory, "bin with ' quote");
  mkdirSync(home);
  const files = new Map([
    ["apps/linux/install.mjs", readFileSync(resolve("apps/linux/install.mjs"))],
    ["runtime/node", Buffer.from("#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"${EVEN_PILOT_TEST_FAIL_OPEN:-}\" = 1 ] && [ \"$arg\" = open ]; then exit 1; fi\ndone\nexit 0\n")],
    ["bin/terminal-plus", Buffer.from("#!/bin/sh\nprintf 'isolated launcher\\n'\n")],
    ["bin/even-pilot", Buffer.from("#!/bin/sh\nprintf 'isolated launcher\\n'\n")],
    ["assets/icon.svg", Buffer.from("<svg/>\n")]
  ]);
  for (const [name, bytes] of files) { const path = join(source, name); mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, bytes); }
  const manifest = { version: "1.0.0", platform: "linux", arch: process.arch, buildId: "123456abcdef",
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })) };
  writeFileSync(join(source, "release.json"), JSON.stringify(manifest));
  chmodSync(join(source, "runtime/node"), 0o755);
  const env = { ...process.env, HOME: home, SHELL: shell, ZDOTDIR: "", EVEN_PILOT_BIN_DIR: bin, EVEN_PILOT_TEST_FAIL_OPEN: "", XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), PATH: "/usr/bin:/bin" };
  const invoke = (...args: string[]) => spawnSync(process.execPath, [join(source, "apps/linux/install.mjs"), "--dir", root, ...args], { env, encoding: "utf8", timeout: 15000 });
  return { home, source, root, bin, env, invoke };
}

test("Linux install registers the command in fresh shells and preserves startup text/modes across reinstall/uninstall", { skip }, t => {
  const f = fixture(t), profile = join(f.home, ".bash_profile"), rc = join(f.home, ".bashrc");
  const existingProfile = "# User login preferences\nexport USER_SETTING='untouched'\n", existingRc = "# User shell preferences\ncase $- in *i*) ;; *) return ;; esac\n";
  writeFileSync(profile, existingProfile); writeFileSync(rc, existingRc); chmodSync(rc, 0o640);
  for (let n = 0; n < 2; n++) { const result = f.invoke("--no-start"); assert.equal(result.status, 0, result.stderr); }
  const content = readFileSync(rc, "utf8");
  assert.equal(content.split("# Terminal+ PATH:").length - 1, 1, "Reinstall does not duplicate the registration");
  assert.equal(statSync(rc).mode & 0o777, 0o640, "Existing shell permissions survive atomic write");
  assert.equal(existsSync(join(f.home, ".profile")), false, "An existing .bash_profile is the active login file");
  const shell = spawnSync("bash", ["--noprofile", "--rcfile", rc, "-ic", "command -v terminal-plus; terminal-plus"], { env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(shell.status, 0, shell.stderr); assert.equal(shell.stdout, join(f.bin, "terminal-plus") + "\nisolated launcher\n");
  const sshShell = spawnSync("bash", ["-c", "command -v terminal-plus"], { env: { ...f.env, BASH_ENV: rc }, encoding: "utf8", timeout: 5000 });
  assert.equal(sshShell.status, 0, sshShell.stderr); assert.equal(sshShell.stdout.trim(), join(f.bin, "terminal-plus"), "PATH loads before the standard noninteractive return used by SSH");
  const remove = f.invoke("--uninstall"); assert.equal(remove.status, 0, remove.stderr);
  assert.equal(readFileSync(profile, "utf8"), existingProfile); assert.equal(readFileSync(rc, "utf8"), existingRc);
  assert.equal(existsSync(join(f.bin, "terminal-plus")), false);
});

test("Linux rename upgrades legacy launchers and shell blocks in place and cleans both owned commands", { skip }, t => {
  const f = fixture(t), rc = join(f.home, ".bashrc"), desktop = join(f.env.XDG_DATA_HOME, "applications/even-pilot.desktop");
  const installed = f.invoke("--no-start"); assert.equal(installed.status, 0, installed.stderr);
  const primary = join(f.bin, "terminal-plus"), legacy = join(f.bin, "even-pilot");
  unlinkSync(primary); symlinkSync(join(f.root, "current/bin/even-pilot"), legacy);
  const shell = readFileSync(rc, "utf8").replaceAll("# Terminal+ PATH:", "# Even-Pilot PATH:").replaceAll("# End Terminal+ PATH", "# End Even-Pilot PATH");
  writeFileSync(rc, shell); writeFileSync(desktop, readFileSync(desktop, "utf8").replace("Name=Terminal+", "Name=Even-Pilot"));
  const upgraded = f.invoke("--no-start"); assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(readlinkSync(primary), join(f.root, "current/bin/terminal-plus"));
  assert.equal(readlinkSync(legacy), join(f.root, "current/bin/even-pilot"));
  const registration = readFileSync(rc, "utf8");
  assert.equal(registration.split("# Terminal+ PATH:").length - 1, 1);
  assert.equal(registration.includes("# Even-Pilot PATH:"), false);
  assert.match(readFileSync(desktop, "utf8"), /Name=Terminal\+\n/);
  const removed = f.invoke("--uninstall"); assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(primary), false); assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(desktop), false); assert.equal(readFileSync(rc, "utf8"), "");
});

test("Linux failed rename upgrade restores legacy launcher and desktop registrations", { skip }, t => {
  const f = fixture(t), primary = join(f.bin, "terminal-plus"), legacy = join(f.bin, "even-pilot");
  const first = f.invoke("--no-start"); assert.equal(first.status, 0, first.stderr);
  const recordPath = join(f.root, "install.json"), record = readFileSync(recordPath, "utf8");
  const previous = JSON.parse(record);
  unlinkSync(primary); symlinkSync(join(f.root, "current/bin/even-pilot"), legacy);
  unlinkSync(join(f.root, "versions", previous.current, "bin/terminal-plus"));
  const desktop = join(f.env.XDG_DATA_HOME, "applications/even-pilot.desktop");
  const desktopText = readFileSync(desktop, "utf8").replace("Name=Terminal+", "Name=Even-Pilot").replace("bin/terminal-plus", "bin/even-pilot");
  writeFileSync(desktop, desktopText);
  const autostart = join(f.env.XDG_CONFIG_HOME, "autostart/even-pilot.desktop");
  mkdirSync(resolve(autostart, ".."), { recursive: true });
  const autoText = "[Desktop Entry]\nName=Even-Pilot\nX-Even-PIlot=true\n"; writeFileSync(autostart, autoText);
  const manifestPath = join(f.source, "release.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "1.0.1"; writeFileSync(manifestPath, JSON.stringify(manifest));
  f.env.EVEN_PILOT_TEST_FAIL_OPEN = "1";
  const failed = f.invoke(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /Could not complete open/);
  assert.equal(readFileSync(recordPath, "utf8"), record);
  assert.equal(existsSync(primary), false, "Rollback does not leave a broken renamed command");
  assert.equal(existsSync(legacy), true); assert.equal(readlinkSync(join(f.root, "current")), "versions/" + previous.current);
  assert.equal(readFileSync(desktop, "utf8"), desktopText); assert.equal(readFileSync(autostart, "utf8"), autoText);
});

test("Linux shell registration respects linked files and unsupported shells", { skip }, t => {
  const f = fixture(t), original = join(f.home, "managed-rc"), rc = join(f.home, ".bashrc");
  writeFileSync(original, "# Dotfile manager owns this file\n"); symlinkSync(original, rc);
  const result = f.invoke("--no-start"); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Shell PATH was not changed/);
  assert.equal(readFileSync(original, "utf8"), "# Dotfile manager owns this file\n");
  const unsupported = fixture(t, "/bin/unknown-shell");
  const other = unsupported.invoke("--no-start"); assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /Add .+ to your shell PATH/); assert.equal(existsSync(join(unsupported.home, ".profile")), false);
});

test("Linux update rejects a disabled startup health check before touching installation or shell files", { skip }, t => {
  const f = fixture(t), result = f.invoke("--update", "--no-start");
  assert.notEqual(result.status, 0); assert.match(result.stderr, /omit --no-start/);
  assert.equal(existsSync(f.root), false); assert.equal(existsSync(join(f.home, ".bashrc")), false);
});
