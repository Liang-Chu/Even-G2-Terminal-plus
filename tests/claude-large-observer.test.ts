import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, writeFile, appendFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ClaudeObserver, type ClaudeObservation } from "../packages/connectors/claude-observer.js";

test("large Claude history stays live, refreshes recent messages and completes only on a trusted Stop", async t => {
  const root = await mkdtemp(join(tmpdir(), "pilot-large-claude-"));
  const projects = join(root, "projects"), queue = join(root, "claude-events");
  await mkdir(projects); await mkdir(queue);
  const id = randomUUID(), path = join(projects, id + ".jsonl");
  let now = Date.now();
  const message = (role: string, text: string) => JSON.stringify({ type: role, sessionId: id, cwd: root,
    timestamp: new Date(++now).toISOString(), message: { role, content: text } }) + "\n";
  await writeFile(path, message("user", "Initial task"));
  const file = await open(path, "r+");
  try {
    // A sparse oversized record exercises fixed-size reads without allocating
    // or parsing tens of megabytes just to reach the newest conversation.
    await file.truncate(42 * 1024 * 1024);
    await file.write("\n" + message("assistant", "Newest visible reply"), 42 * 1024 * 1024);
  } finally { await file.close(); }
  const events: ClaudeObservation[] = [];
  const observer = new ClaudeObserver(event => events.push(structuredClone(event)), {
    directory: queue, root: projects, now: () => now, alive: async () => true,
  });
  t.after(async () => { await observer.stop(); await rm(root, { recursive: true, force: true }); });
  const emit = async (hook_event_name: string, extra = {}) => {
    const at = ++now, eventId = randomUUID();
    await writeFile(join(queue, `${at}-${eventId}.json`), JSON.stringify({ version: 1, eventId, at, hook_event_name,
      session_id: id, transcript_path: path, cwd: root, owner: { pid: 1234, started: "5678" }, ...extra }));
  };
  await emit("UserPromptSubmit", { prompt: "Current task" });
  await observer.poll();
  assert.equal(events.at(-1)?.state.connected, true);
  assert.equal(events.at(-1)?.state.main.status, "running");
  assert.ok(events.at(-1)?.state.transcript.some(row => row.text === "Newest visible reply"));
  assert.equal(events.filter(event => event.completion).length, 0);
  assert.equal((await readdir(queue)).length, 0);
  await appendFile(path, message("assistant", "Next visible reply"));
  await observer.poll();
  assert.ok(events.at(-1)?.state.transcript.some(row => row.text === "Next visible reply"));
  assert.equal(events.at(-1)?.state.main.status, "running", "Display updates cannot fabricate completion");
  assert.equal(events.filter(event => event.completion).length, 0);
  await emit("Stop", { stopTrusted: true, background_tasks: [] });
  await observer.poll();
  assert.equal(events.filter(event => event.completion).length, 1);
});
