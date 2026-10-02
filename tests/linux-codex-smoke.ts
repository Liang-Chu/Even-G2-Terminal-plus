import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexTerminal } from "../apps/windows/src/connectors/codex-terminal.js";

if (process.platform !== "linux" || !process.env.EVEN_PILOT_CODEX) throw new Error("Set EVEN_PILOT_CODEX to the isolated test CLI");
const root = await mkdtemp(join(tmpdir(), "pilot-codex-linux-"));
const previous = process.env.CODEX_HOME;
process.env.CODEX_HOME = join(root, "codex");
await mkdir(process.env.CODEX_HOME);
try {
  await codexTerminal({ data: join(root, "data"), cwd: root, verify: async (rpc, monitor) => {
    assert.equal(monitor.snapshot.state.session.tunnel, "codex");
    const response = await rpc.request("thread/read", { threadId: monitor.snapshot.state.session.id, includeTurns: false });
    assert.equal(response.thread.id, monitor.snapshot.state.session.id);
  } });
  console.log("PASS: real Linux Codex App Server initialization, empty-thread start/read and connector teardown; no model prompt or credentials used.");
} finally {
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  await rm(root, { recursive: true, force: true });
}
