import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConnectorCatalog, claudeHistory } from "../packages/connectors/catalog.js";
import { connectorKey } from "../packages/connectors/identity.js";
import { CLAUDE_MAX_READ_BYTES, CLAUDE_TAIL_BYTES, readClaudeTranscript } from "../packages/connectors/claude-transcript.js";

const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pilot-claude-transcript-")), root = join(directory, "projects"), project = join(root, "project");
  await mkdir(project, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const id = randomUUID(), path = join(project, id + ".jsonl"), cwd = join(directory, "workspace");
  const header = { sessionId: id, cwd, type: "user", message: { role: "user", content: "Original session title" } };
  const catalog = () => new ConnectorCatalog({ data: directory, claudeRoot: root, pi: { root: join(directory, "pi") },
    codex: async () => ({ close() {}, request: async () => ({ data: [] }) }) });
  return { directory, root, project, id, path, cwd, header, catalog };
}

test("oversized Claude sessions retain authoritative metadata and recent visible messages within a fixed read budget", async t => {
  const f = await fixture(t), file = await open(f.path, "w");
  try {
    await file.writeFile(jsonl(f.header, { type: "custom-title", customTitle: "Long-running session" }));
    const padding = jsonl({ type: "progress", padding: "x".repeat(1024 * 1024) });
    for (let index = 0; index < 34; index++) await file.writeFile(padding);
    await file.writeFile(jsonl({ type: "assistant", message: { role: "assistant", model: "claude-test", content: [
      { type: "thinking", thinking: "PRIVATE-REASONING" }, { type: "text", text: "Latest visible answer" }
    ] } }));
  } finally { await file.close(); }
  const before = await stat(f.path), transcript = await readClaudeTranscript(f.path, f.root);
  assert(before.size > 32 * 1024 * 1024);
  assert.equal(transcript.bytesRead, CLAUDE_MAX_READ_BYTES); assert(transcript.content.length <= CLAUDE_MAX_READ_BYTES);
  assert.deepEqual(transcript.metadata, { id: f.id, cwd: f.cwd }); assert.equal(transcript.truncated, true);
  const catalog = f.catalog(); t.after(() => catalog.close());
  const listed = (await catalog.list()).sessions;
  assert.equal(listed.length, 1); assert.equal(listed[0].id, f.id); assert.equal(listed[0].cwd, f.cwd);
  assert.equal(listed[0].name, "Long-running session"); assert.equal(listed[0].updatedAt, before.mtimeMs);
  const history = await catalog.history(connectorKey("claude", f.id));
  assert.equal(history.truncated, true); assert.equal(history.messages.at(-1)?.text, "Latest visible answer");
  assert.equal(history.session.preview, "Original session title"); assert(!JSON.stringify(history).includes("PRIVATE-REASONING"));
  const after = await stat(f.path); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
});

test("small Claude files preserve complete final records and flag a concurrent partial append", async t => {
  const f = await fixture(t), content = jsonl(f.header) + JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Done" } });
  await writeFile(f.path, content);
  const complete = await readClaudeTranscript(f.path, f.root);
  assert.equal(complete.content, content); assert.equal(complete.truncated, false); assert.equal(complete.bytesRead, Buffer.byteLength(content));
  const partial = content + '\n{"type":"assistant","message":'; await writeFile(f.path, partial);
  const snapshot = await readClaudeTranscript(f.path, f.root);
  assert.equal(snapshot.truncated, true); assert.equal(snapshot.content, content + "\n");
  const history = claudeHistory(snapshot.content, f.path, snapshot.modified, snapshot.metadata)!;
  assert.equal(history.messages.at(-1)?.text, "Done"); assert.equal(await readFile(f.path, "utf8"), partial);
});

test("giant records spanning the head and tail are omitted without losing identity or fabricating a message", async t => {
  const f = await fixture(t);
  await writeFile(f.path, jsonl(f.header) + JSON.stringify({ type: "assistant", message: { role: "assistant", content: "g".repeat(CLAUDE_TAIL_BYTES * 2) } }) + "\n");
  const snapshot = await readClaudeTranscript(f.path, f.root);
  assert(snapshot.bytesRead <= CLAUDE_MAX_READ_BYTES); assert.equal(snapshot.truncated, true);
  const history = claudeHistory(snapshot.content, f.path, snapshot.modified, snapshot.metadata)!;
  assert.deepEqual(history.messages.map(row => row.text), ["Original session title"]);
  const file = await open(f.path, "a");
  try { await file.writeFile(jsonl({ type: "assistant", message: { role: "assistant", content: "New complete answer" } })); }
  finally { await file.close(); }
  const next = await readClaudeTranscript(f.path, f.root);
  assert.equal(claudeHistory(next.content, f.path, next.modified, next.metadata)?.messages.at(-1)?.text, "New complete answer");
});

test("bounded metadata cannot be replaced by a foreign tail identity or a later cwd", async t => {
  const f = await fixture(t);
  await writeFile(f.path, jsonl(f.header,
    { sessionId: randomUUID(), cwd: "/foreign", type: "assistant", message: { role: "assistant", content: "Foreign session" } },
    { sessionId: f.id, cwd: "/later-cwd", type: "assistant", message: { role: "assistant", content: "Same session" } }, null));
  const snapshot = await readClaudeTranscript(f.path, f.root), history = claudeHistory(snapshot.content, f.path, snapshot.modified, snapshot.metadata)!;
  assert.equal(history.session.id, f.id); assert.equal(history.session.cwd, f.cwd);
  assert.deepEqual(history.messages.map(row => row.text), ["Original session title", "Same session"]);
  assert.equal(history.truncated, true);
});

test("Claude reader rejects escaped, mismatched and subagent files before exposing their content", async t => {
  const f = await fixture(t), outside = join(f.directory, f.id + ".jsonl");
  await writeFile(outside, jsonl(f.header));
  await assert.rejects(readClaudeTranscript(outside, f.root), /outside the main session directories/);
  await writeFile(f.path, jsonl({ ...f.header, sessionId: randomUUID() }));
  await assert.rejects(readClaudeTranscript(f.path, f.root), /no matching session metadata/);
  await writeFile(f.path, jsonl({ ...f.header, isSidechain: true }));
  await assert.rejects(readClaudeTranscript(f.path, f.root), /no matching session metadata/);
  const subagent = join(f.project, "subagents", f.id + ".jsonl"); await mkdir(join(f.project, "subagents"));
  await writeFile(subagent, jsonl(f.header));
  await assert.rejects(readClaudeTranscript(subagent, f.root), /outside the main session directories/);
  assert.equal(await readFile(outside, "utf8"), jsonl(f.header));
});

test("Claude reader refuses transcript and project symlinks", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), outside = join(f.directory, f.id + ".jsonl"); await writeFile(outside, jsonl(f.header));
  await symlink(outside, f.path); await assert.rejects(readClaudeTranscript(f.path, f.root), /regular file/);
  const linkedProject = join(f.root, "linked-project"); await symlink(f.directory, linkedProject);
  await assert.rejects(readClaudeTranscript(join(linkedProject, f.id + ".jsonl"), f.root), /must not be linked/);
});

test("catalog refreshes a replaced transcript even when its byte count and timestamp are unchanged", async t => {
  const f = await fixture(t), date = new Date(1_700_000_000_000);
  const content = (text: string) => jsonl(f.header, { type: "assistant", message: { role: "assistant", content: text } });
  await writeFile(f.path, content("Older")); await utimes(f.path, date, date);
  const catalog = f.catalog(); t.after(() => catalog.close());
  assert.equal((await catalog.history(connectorKey("claude", f.id))).messages.at(-1)?.text, "Older");
  const replacement = join(f.project, "replacement.jsonl"); await writeFile(replacement, content("Newer")); await utimes(replacement, date, date);
  await rename(replacement, f.path);
  assert.equal((await catalog.history(connectorKey("claude", f.id))).messages.at(-1)?.text, "Newer");
});
