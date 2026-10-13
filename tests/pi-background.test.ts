import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PiBackgroundScanner } from "../packages/pi-runtime/pi-background.js";

const session = { pid: 100, sessionId: "watched-session", sessionFile: "/home/user/session.jsonl" };
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "terminal-plus-pi-background-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const scanner = new PiBackgroundScanner({ directory, uid: 1000, selfPid: 999, now: () => now });
  const process = (pid: number, options: { uid?: number; state?: string; started?: string; id?: string; file?: string; extra?: string } = {}) => {
    const path = join(directory, String(pid)); mkdirSync(path, { recursive: true });
    // stat fields 3..22: state, followed by 18 fields, then starttime.
    writeFileSync(join(path, "stat"), `${pid} (a name ) with spaces) ${options.state || "S"} ${Array(18).fill("0").join(" ")} ${options.started || "42"}\n`);
    const uid = options.uid ?? 1000;
    writeFileSync(join(path, "status"), `Name:\tfixture\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    writeFileSync(join(path, "environ"), `PI_SESSION_ID=${options.id ?? session.sessionId}\0PI_SESSION_FILE=${options.file ?? session.sessionFile}\0${options.extra || ""}`);
    return path;
  };
  return { directory, scanner, process, advance: () => { now += 1000; } };
}

test("Linux Pi jobs require both exact session identities and same-user non-zombie ownership", t => {
  const f = fixture(t);
  f.process(100); f.process(999); f.process(101);
  f.process(102, { file: "/home/user/other.jsonl" });
  f.process(103, { id: "other-session" });
  f.process(104, { uid: 2000 });
  f.process(105, { state: "Z" }); f.process(106, { state: "X" }); f.process(107, { state: "x" });
  f.process(108, { file: "/home/user/./session.jsonl" });
  assert.deepEqual(f.scanner.scan(session), { active: 2 });
  assert.deepEqual(f.scanner.scan({ ...session, excludePids: [108] }), { active: 1 }, "Another known native window is excluded");
  assert.deepEqual(f.scanner.scan({ ...session, sessionId: "absent" }), { active: 0 });
  assert.deepEqual(f.scanner.scan({ ...session, sessionFile: "relative.jsonl" }), { active: 0 });
});

test("Pi job observation is shared and cached for one second, then drops exited and reused PIDs", t => {
  const f = fixture(t), path = f.process(101);
  assert.deepEqual(f.scanner.scan(session), { active: 1 });
  f.process(101, { started: "43", id: "other-session" });
  assert.deepEqual(f.scanner.scan(session), { active: 1 }, "No repeated /proc scan inside the cache window");
  f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0 }, "A reused PID cannot retain the prior session");
  f.process(101); f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 1 });
  rmSync(path, { recursive: true }); f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0 });
});

test("completion checks can refresh a cached empty scan to catch a just-started background job", t => {
  const f = fixture(t);
  assert.deepEqual(f.scanner.scan(session), { active: 0 });
  f.process(101); f.process(102, { id: "unrelated-session" });
  assert.deepEqual(f.scanner.scan(session), { active: 0 }, "Normal status reads reuse the bounded cache");
  assert.deepEqual(f.scanner.scan(session, true), { active: 1 }, "Completion eligibility requires a fresh scan");
});

test("only previously bound unreadable live processes make their own session uncertain", t => {
  const f = fixture(t), path = f.process(101), unrelated = f.process(102, { id: "other-session" });
  assert.deepEqual(f.scanner.scan(session), { active: 1 });
  unlinkSync(join(path, "environ")); mkdirSync(join(path, "environ"));
  unlinkSync(join(unrelated, "environ")); mkdirSync(join(unrelated, "environ"));
  f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0, uncertain: true });
  assert.deepEqual(f.scanner.scan({ ...session, sessionId: "unrelated-unwatched" }), { active: 0 });
  rmSync(path, { recursive: true }); f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0 });
});

test("unbound unreadable processes and jobs lacking both official variables are not guessed", t => {
  const f = fixture(t), path = f.process(101), old = f.process(102), partial = f.process(103);
  unlinkSync(join(path, "environ")); mkdirSync(join(path, "environ"));
  writeFileSync(join(old, "environ"), "OTHER=ordinary-process\0");
  writeFileSync(join(partial, "environ"), `PI_SESSION_ID=${session.sessionId}\0`);
  assert.deepEqual(f.scanner.scan(session), { active: 0 });
});

test("temporary identity read failures retain uncertainty without counting or rebinding a reused PID", t => {
  const f = fixture(t), path = f.process(101);
  assert.deepEqual(f.scanner.scan(session), { active: 1 });
  unlinkSync(join(path, "stat")); mkdirSync(join(path, "stat"));
  f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0, uncertain: true });
  rmSync(join(path, "stat"), { recursive: true });
  f.process(101, { started: "43", id: "other-session" });
  f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0 });
  f.process(101); f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 1 });
  unlinkSync(join(path, "status")); mkdirSync(join(path, "status"));
  f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0, uncertain: true });
  rmSync(path, { recursive: true }); f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0 });
});

test("environment reads are bounded and never accept oversized, partial or duplicate identity data", t => {
  const f = fixture(t), long = f.process(101), partial = f.process(102), duplicate = f.process(103);
  writeFileSync(join(long, "environ"), Buffer.alloc(64 * 1024 + 1, 65));
  writeFileSync(join(partial, "environ"), `PI_SESSION_ID=${session.sessionId}\0PI_SESSION_FILE=${session.sessionFile}`);
  writeFileSync(join(duplicate, "environ"), `PI_SESSION_ID=${session.sessionId}\0PI_SESSION_FILE=${session.sessionFile}\0PI_SESSION_ID=other\0`);
  assert.deepEqual(f.scanner.scan(session), { active: 0 });
  f.process(101); f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 1 });
  writeFileSync(join(long, "environ"), Buffer.alloc(64 * 1024 + 1, 65));
  f.advance(); assert.deepEqual(f.scanner.scan(session), { active: 0, uncertain: true }, "An oversized tracked environment retains uncertainty");
});

test("bounded process discovery reports an incomplete scan without inventing extra jobs", t => {
  const f = fixture(t); f.process(101); f.process(102); f.process(103);
  const scanner = new PiBackgroundScanner({ directory: f.directory, uid: 1000, selfPid: 999, maxProcesses: 2 });
  assert.deepEqual(scanner.scan(session), { active: 2, uncertain: true });
});

test("real Linux detached work is associated only with its inherited Pi session", { skip: process.platform !== "linux", timeout: 10_000 }, async t => {
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit"); child.kill(); await exited;
    }));
  });
  const actual = { pid: process.pid, sessionId: "synthetic-pi-" + process.pid, sessionFile: "/tmp/synthetic-pi-" + process.pid + ".jsonl" };
  const scanner = new PiBackgroundScanner();
  assert.deepEqual(scanner.scan(actual), { active: 0 });
  for (const id of [actual.sessionId, actual.sessionId + "-other"]) {
    const child = spawn("sleep", ["30"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_SESSION_ID: id, PI_SESSION_FILE: actual.sessionFile },
    });
    children.push(child); await once(child, "spawn", { signal: AbortSignal.timeout(5000) });
  }
  assert.deepEqual(scanner.scan(actual, true), { active: 1 });
  assert.deepEqual(scanner.scan({ ...actual, sessionFile: actual.sessionFile + "-other" }), { active: 0 });
  assert.deepEqual(scanner.scan({ ...actual, excludePids: [children[0].pid!] }), { active: 0 });
  const exited = once(children[0], "exit"); children[0].kill(); await exited;
  assert.deepEqual(scanner.scan(actual, true), { active: 0 }, "The matching detached process has exited; unrelated work cannot keep this session active");
});
