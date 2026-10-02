import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { terminalArguments, shellQuote, linuxUnregistered } from "../apps/linux/src/platform.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Linux GUI terminal arguments retain literal paths and prompts without shell parsing", () => {
  const command = ["/path with spaces/node", "--import", "/a/'$(touch nope)/loader", "hello; exit"];
  for (const terminal of ["gnome-terminal", "konsole", "kitty", "xfce4-terminal", "xterm", "x-terminal-emulator"])
    assert.deepEqual(terminalArguments(terminal, command, "/path with spaces", "Pi").slice(-command.length), command);
});
test("headless tmux quoting round-trips metacharacters as one literal argument", { skip: process.platform !== "linux" }, async () => {
  const value = "a ' quote; $(false) `false` $HOME \" double\nnext";
  const result = await promisify(execFile)("sh", ["-c", "printf '%s' " + shellQuote(value)]);
  assert.equal(result.stdout, value);
});
test("Linux existing-terminal detection excludes monitored children and noninteractive commands", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pilot-proc-")); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = async (id: number, ppid: number, args: string[]) => { await mkdir(join(root, String(id)), { recursive: true });
    await writeFile(join(root, String(id), "cmdline"), args.join("\0") + "\0");
    await writeFile(join(root, String(id), "status"), "PPid:\t" + ppid + "\n"); };
  await fixture(10001, 10000, ["/usr/bin/codex", "app-server"]);
  await fixture(10002, 10000, ["/usr/bin/claude", "--version"]);
  await fixture(10003, 10000, ["/usr/bin/node", "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"]);
  assert.equal(await linuxUnregistered([], "codex", root), false);
  assert.equal(await linuxUnregistered([], "claude", root), false);
  assert.equal(await linuxUnregistered([], "pi", root), true);
  assert.equal(await linuxUnregistered([10003], "pi", root), false);
  await fixture(10004, 10005, ["/usr/bin/claude"]);
  assert.equal(await linuxUnregistered([10005], "claude", root), false);
  assert.equal(await linuxUnregistered([], "claude", root), true);
});
