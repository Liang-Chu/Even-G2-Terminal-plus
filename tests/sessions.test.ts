import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRepository, parseSavedSession } from "../packages/pi-runtime/sessions.js";

import { savedEntries } from "./fixtures/saved-sessions.js";

test("saved sessions discover metadata and read only the persisted leaf branch without modifying source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "even-pilot-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "project");
  await mkdir(directory);
  const path = join(directory, "saved.jsonl");
  const source = savedEntries(root).map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(path, source);
  await writeFile(join(directory, "invalid.jsonl"), '{"type":"session","version":99}\n');
  const repository = new SessionRepository({ root });
  const { sessions, skipped } = await repository.list();
  assert.equal(skipped, 1);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "Saved project");
  assert.equal(sessions[0].model, "test/fixture");
  assert.equal(sessions[0].messageCount, 3);
  assert.equal(sessions[0].runtimeStatus, "offline");
  assert.equal((await repository.list(join(root, "different"))).sessions.length, 0);
  const history = await repository.history(sessions[0].key);
  assert.deepEqual(history.messages.map((message) => message.text), ["Question", "Selected answer", "read · completed"]);
  assert.equal(JSON.stringify(history).includes("private reasoning"), false);
  assert.equal(JSON.stringify(history).includes("raw secret"), false);
  assert.equal(await readFile(path, "utf8"), source);
  await assert.rejects(repository.history(path), /Unknown session key/);
  await assert.rejects(repository.original("a".repeat(32)), /Unknown session key/);
});

test("history honors branch-local context edits, rejects damaged trees and will not open incomplete appends", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "even-pilot-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries: Record<string, unknown>[] = savedEntries(root);
  entries.push({ type: "context_edit", id: "edit", parentId: "name", targetId: "new-branch", replacement: { content: [{ type: "text", text: "Edited answer" }] } });
  entries.push({ type: "context_edit", id: "omit", parentId: "edit", targetId: "user", replacement: null });
  await writeFile(join(root, "edited.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + '\n{"type":"message"');
  const repository = new SessionRepository({ root });
  const { sessions } = await repository.list();
  const history = await repository.history(sessions[0].key);
  assert.deepEqual(history.messages.map((message) => message.text), ["Edited answer", "read · completed"]);
  assert.equal(history.truncated, true);
  await assert.rejects(repository.original(sessions[0].key), /incomplete write/);
  const broken = [...savedEntries(root), { type: "message", id: "orphan", parentId: "missing" }];
  assert.throws(() => parseSavedSession(broken.map((entry) => JSON.stringify(entry)).join("\n")), /broken entry tree/);
  const cycle = [...savedEntries(root), { type: "message", id: "cycle", parentId: "cycle" }];
  assert.throws(() => parseSavedSession(cycle.map((entry) => JSON.stringify(entry)).join("\n")), /cyclic entry tree/);
});

test("history has explicit transcript and text limits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "even-pilot-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries: unknown[] = [savedEntries(root)[0]];
  for (let n = 0; n < 205; n++) entries.push({ type: "message", id: String(n), parentId: n ? String(n - 1) : null, message: { role: "user", content: n === 204 ? "x".repeat(40_000) : String(n) } });
  await writeFile(join(root, "large.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const repository = new SessionRepository({ root });
  const history = await repository.history((await repository.list()).sessions[0].key);
  assert.equal(history.messages.length, 200);
  assert.equal(history.messages[0].text, "5");
  assert.ok(history.messages.at(-1)!.text.length < 32_100);
  assert.equal(history.truncated, true);
});
