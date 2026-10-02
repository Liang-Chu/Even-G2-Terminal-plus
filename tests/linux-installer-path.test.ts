import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
    ["runtime/node", Buffer.from("#!/bin/sh\nexit 0\n")],
    ["bin/even-pilot", Buffer.from("#!/bin/sh\nprintf 'isolated launcher\\n'\n")],
    ["assets/icon.svg", Buffer.from("<svg/>\n")]
  ]);
  for (const [name, bytes] of files) { const path = join(source, name); mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, bytes); }
  const manifest = { version: "1.0.0", platform: "linux", arch: process.arch, buildId: "123456abcdef",
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })) };
  writeFileSync(join(source, "release.json"), JSON.stringify(manifest));
  chmodSync(join(source, "runtime/node"), 0o755);
  const env = { ...process.env, HOME: home, SHELL: shell, ZDOTDIR: "", EVEN_PILOT_BIN_DIR: bin, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), PATH: "/usr/bin:/bin" };
  const invoke = (...args: string[]) => spawnSync(process.execPath, [join(source, "apps/linux/install.mjs"), "--dir", root, ...args], { env, encoding: "utf8", timeout: 15000 });
  return { home, root, bin, env, invoke };
}

test("Linux install registers the command in fresh shells and preserves startup text/modes across reinstall/uninstall", { skip }, t => {
  const f = fixture(t), profile = join(f.home, ".bash_profile"), rc = join(f.home, ".bashrc");
  const existingProfile = "# User login preferences\nexport USER_SETTING='untouched'\n", existingRc = "# User shell preferences\ncase $- in *i*) ;; *) return ;; esac\n";
  writeFileSync(profile, existingProfile); writeFileSync(rc, existingRc); chmodSync(rc, 0o640);
  for (let n = 0; n < 2; n++) { const result = f.invoke("--no-start"); assert.equal(result.status, 0, result.stderr); }
  const content = readFileSync(rc, "utf8");
  assert.equal(content.split("# Even-Pilot PATH:").length - 1, 1, "Reinstall does not duplicate the registration");
  assert.equal(statSync(rc).mode & 0o777, 0o640, "Existing shell permissions survive atomic write");
  assert.equal(existsSync(join(f.home, ".profile")), false, "An existing .bash_profile is the active login file");
  const shell = spawnSync("bash", ["--noprofile", "--rcfile", rc, "-ic", "command -v even-pilot; even-pilot"], { env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(shell.status, 0, shell.stderr); assert.equal(shell.stdout, join(f.bin, "even-pilot") + "\nisolated launcher\n");
  const sshShell = spawnSync("bash", ["-c", "command -v even-pilot"], { env: { ...f.env, BASH_ENV: rc }, encoding: "utf8", timeout: 5000 });
  assert.equal(sshShell.status, 0, sshShell.stderr); assert.equal(sshShell.stdout.trim(), join(f.bin, "even-pilot"), "PATH loads before the standard noninteractive return used by SSH");
  const remove = f.invoke("--uninstall"); assert.equal(remove.status, 0, remove.stderr);
  assert.equal(readFileSync(profile, "utf8"), existingProfile); assert.equal(readFileSync(rc, "utf8"), existingRc);
  assert.equal(existsSync(join(f.bin, "even-pilot")), false);
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
