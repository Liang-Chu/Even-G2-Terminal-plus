import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computerOrigin, mergeComputerBooks, nextComputerStamp, parseComputerBook, type ComputerBook,
  type ComputerEntry } from "../packages/cockpit-state/computers.js";
import { ComputerDirectory, type ComputerOwner } from "../apps/windows/src/computers.js";

const token = "fixture-control-key-for-owner-123456789";
const owner: ComputerOwner = { id: "computer-owner", name: "My laptop", url: "http://100.64.0.1:4317", token };
const live = (id = "computer-peer", counter = 1, writer = "browser-a"): Extract<ComputerEntry, { url: string }> => ({
  id, url: "http://100.64.0.2:4317", token: "fixture-control-key-for-peer-123456789", name: "NUC", stamp: { counter, writer },
});
const book = (...entries: ComputerEntry[]): ComputerBook => ({ version: 1, entries });

test("portable origins reject loopback, credentials and non-origin routes", () => {
  assert.equal(computerOrigin("https://gateway.example:443/"), "https://gateway.example");
  assert.equal(computerOrigin("http://100.64.0.2:4317"), "http://100.64.0.2:4317");
  for (const url of ["http://localhost:4317", "http://LOCALHOST.:4317", "http://test.localhost:4317", "http://127.0.0.1:4317",
    "http://127.2.3.4", "http://127.1", "http://2130706433", "http://0.0.0.0", "http://[::1]", "http://[::]",
    "http://[::ffff:127.0.0.1]", "http://user:key@100.64.0.2", "file:///private", "http://100.64.0.2/api/state",
    "http://100.64.0.2?token=private", "http://100.64.0.2#token=private"])
    assert.throws(() => computerOrigin(url), /^Error: Invalid saved computer data$/);
});

test("book parsing validates the entire payload and strips secrets from tombstones", () => {
  const removed = { ...live(), deleted: true };
  assert.deepEqual(parseComputerBook({ version: 1, entries: [removed], owner: { token } }),
    book({ id: "computer-peer", stamp: { counter: 1, writer: "browser-a" }, deleted: true }));
  for (const input of [null, {}, { version: 2, entries: [] }, book(live(), live()),
    book({ ...live(), id: "../../private" }), book({ ...live(), token: "short" }),
    book({ ...live(), token: token + "\r\nsecret" }), book({ ...live(), name: "\nsecret" }),
    book({ ...live(), stamp: { counter: -1, writer: "a" } }), book({ ...live(), stamp: { counter: 0.5, writer: "a" } }),
    book({ ...live(), stamp: { counter: Number.MAX_SAFE_INTEGER, writer: "a" } }),
    book({ ...live(), stamp: { counter: 1, writer: "<unsafe>" } })])
    assert.throws(() => parseComputerBook(input), /^Error: Invalid saved computer data$/);
});

test("LWW merge converges independent of order, preserves removals, and permits explicit newer reconnect", () => {
  const original = live(), renamed = { ...original, name: "Server", stamp: { counter: 2, writer: "browser-b" } };
  const deleted: ComputerEntry = { id: original.id, stamp: renamed.stamp, deleted: true };
  assert.deepEqual(mergeComputerBooks(book(original), book(renamed), book(deleted)), book(deleted));
  assert.deepEqual(mergeComputerBooks(book(deleted), book(renamed), book(original)), book(deleted));
  const restored = { ...original, stamp: nextComputerStamp(book(deleted), "browser-a") };
  assert.deepEqual(mergeComputerBooks(book(deleted), book(restored)), book(restored));
  const sameStamp = { ...original, name: "Other name" };
  assert.deepEqual(mergeComputerBooks(book(original), book(sameStamp)), mergeComputerBooks(book(sameStamp), book(original)));
  assert.deepEqual(mergeComputerBooks(book({ ...original, stamp: { counter: 1, writer: "a" } }),
    book({ ...original, stamp: { counter: 1, writer: "z" } })).entries[0].stamp, { counter: 1, writer: "z" });
});

test("live and tombstone bounds apply to parsing and merged results", () => {
  const sixteen = Array.from({ length: 16 }, (_, index) => live("peer-" + index));
  assert.equal(parseComputerBook(book(...sixteen)).entries.length, 16);
  assert.throws(() => parseComputerBook(book(...sixteen, live("peer-17"))));
  assert.throws(() => mergeComputerBooks(book(...sixteen), book(live("peer-17"))));
  const tombstones = Array.from({ length: 128 }, (_, index): ComputerEntry => ({ id: "removed-" + index,
    stamp: { counter: index, writer: "a" }, deleted: true }));
  assert.equal(parseComputerBook(book(...tombstones)).entries.length, 128);
  assert.throws(() => parseComputerBook(book(...tombstones, live())));
  assert.throws(() => mergeComputerBooks(book(...tombstones), book(live())));
  assert.throws(() => nextComputerStamp(book({ id: "last", deleted: true,
    stamp: { counter: Number.MAX_SAFE_INTEGER - 1, writer: "a" } }), "a"));
});

function fixture(t: { after(fn: () => void): void }, getOwner = () => ({ ...owner })) {
  const directory = mkdtempSync(join(tmpdir(), "terminal-plus-computers-")), path = join(directory, "computers.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path, store: new ComputerDirectory(path, getOwner) };
}

test("own identity seeds once and records survive restart without sharing owner metadata tokens", async t => {
  const { path, store } = fixture(t);
  const initial = await store.snapshot();
  assert.deepEqual(initial.owner, { id: owner.id, name: owner.name, url: owner.url });
  assert.equal(initial.entries[0].stamp.counter, 0);
  assert.deepEqual(await store.snapshot(), initial);
  await store.merge(book(live()));
  assert.deepEqual(await new ComputerDirectory(path, () => owner).snapshot(), await store.snapshot());
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("local-only owners are never seeded as portable computers", async t => {
  for (const url of [undefined, "http://127.0.0.1:4317", "http://localhost:4317"]) {
    const { path, store } = fixture(t, () => ({ ...owner, url }));
    assert.deepEqual(await store.snapshot(), { version: 1, entries: [], owner: { id: owner.id, name: owner.name } });
    assert.equal(existsSync(path), false);
  }
});

test("owner token/name refresh increments once and protects against wrong-key replicas", async t => {
  let current = { ...owner };
  const { store } = fixture(t, () => current);
  await store.snapshot();
  current = { ...current, token: "fixture-new-control-key-123456789", name: "Renamed" };
  const rotated = await store.snapshot();
  assert.equal(rotated.entries[0].stamp.counter, 1);
  assert.deepEqual(await store.snapshot(), rotated);
  const forged = { ...live(owner.id, 100), url: "https://untrusted.example", token: "fixture-wrong-control-key-123456789" };
  const normalized = await store.merge(book(forged)), actual = normalized.entries.find(entry => entry.id === owner.id)!;
  assert.ok(!actual.deleted);
  assert.equal(actual.url, owner.url); assert.equal(actual.token, current.token); assert.equal(actual.name, current.name);
  assert.equal(actual.stamp.counter, 101);
  assert.deepEqual(await store.snapshot(), normalized);
});

test("an explicit valid own gateway with the current key survives snapshots and key rotation", async t => {
  let current = { ...owner };
  const { store } = fixture(t, () => current);
  await store.snapshot();
  const gateway = { ...live(owner.id, 1), token: owner.token, name: owner.name, url: "https://my.gateway.example" };
  await store.merge(book(gateway));
  let own = (await store.snapshot()).entries.find(entry => entry.id === owner.id)!;
  assert.ok(!own.deleted); assert.equal(own.url, gateway.url);
  current = { ...current, token: "fixture-new-owner-control-key-123456789" };
  own = (await store.snapshot()).entries.find(entry => entry.id === owner.id)!;
  assert.ok(!own.deleted); assert.equal(own.url, gateway.url); assert.equal(own.token, current.token);
});

test("removing even the owning computer persists the tombstone and old clients cannot revive it", async t => {
  const { path, store } = fixture(t);
  const stale = await store.snapshot();
  await store.merge(book({ id: owner.id, stamp: { counter: 1, writer: "browser-a" }, deleted: true }));
  const removed = await store.merge(stale);
  assert.equal(removed.entries[0].deleted, true);
  assert.ok(!readFileSync(path, "utf8").includes(token));
  assert.deepEqual(await new ComputerDirectory(path, () => owner).snapshot(), removed);
});

test("invalid data and failed atomic writes leave all in-memory and durable records unchanged", async t => {
  const { directory, path, store } = fixture(t);
  const saved = await store.snapshot(), bytes = readFileSync(path, "utf8");
  await assert.rejects(store.merge(book(live(), { ...live("bad"), token: "short" })), /^Error: Invalid saved computer data$/);
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.deepEqual(await store.snapshot(), saved);
  rmSync(path); mkdirSync(path);
  await assert.rejects(store.merge(book(live())), /Saved computer storage is unavailable; changes were not saved/);
  assert.deepEqual(await store.snapshot(), saved, "a failed save does not partially commit in memory");
  assert.deepEqual(readdirSync(directory), ["computers.json"], "no key-bearing temporary file remains");
  rmSync(path, { recursive: true }); writeFileSync(path, bytes);
  assert.deepEqual(await new ComputerDirectory(path, () => owner).snapshot(), saved);
  await store.merge(book(live()));
  assert.equal((await store.snapshot()).entries.length, 2);
});

test("corrupt private storage fails closed without echoing its keys or resetting it", t => {
  const { path } = fixture(t);
  const bad = '{"version":1,"entries":[{"token":"' + token + '"}]}';
  writeFileSync(path, bad); chmodSync(path, 0o600);
  assert.throws(() => new ComputerDirectory(path, () => owner), /^Error: Saved computer storage is unavailable; restore it before reconnecting$/);
  assert.equal(readFileSync(path, "utf8"), bad);
});

test("concurrent replica updates are serialized without losing unrelated devices", async t => {
  const { store } = fixture(t);
  await Promise.all([store.merge(book(live("first"))), store.merge(book(live("second"))), store.snapshot()]);
  assert.deepEqual((await store.snapshot()).entries.map(entry => entry.id), [owner.id, "first", "second"]);
});
