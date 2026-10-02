import test from "node:test";
import assert from "node:assert/strict";
import { sessionGroups } from "../apps/evenhub/src/sessions/groups.js";
import type { SessionSummary } from "../apps/evenhub/src/sessions/panel.js";
import type { HostSource } from "../packages/cockpit-state/types.js";

test("device groups keep duplicate names separate, sort recent sessions and retain offline watched rows", () => {
  const a: HostSource = { id: "a", name: "Workstation", url: "http://host-a:4317", nameSource: "hostname", online: true };
  const b: HostSource = { id: "b", name: "Workstation", url: "http://host-b:4317", nameSource: "hostname", online: false };
  const empty: HostSource = { id: "empty", name: "NUC", url: "http://host-c:4317", nameSource: "hostname", online: false };
  const rows: SessionSummary[] = [
    { key: "a:old", id: "old", name: "Same title", cwd: "/one", source: a, updatedAt: 2, runtimeStatus: "idle", monitored: false },
    { key: "b:new", id: "new", name: "Same title", cwd: "/two", source: { ...b, online: true }, updatedAt: 8, runtimeStatus: "running", monitored: true },
    { key: "a:new", id: "new", name: "Same title", cwd: "/one", source: a, updatedAt: 5, runtimeStatus: "running", monitored: true },
  ];
  const before = structuredClone(rows), groups = sessionGroups(rows, [a, b, empty]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.find(g => g.key === a.url)!.sessions.map(s => s.key), ["a:new", "a:old"]);
  assert.equal(groups.find(g => g.key === b.url)!.online, false);
  assert.deepEqual(sessionGroups(rows, [a, b, empty], {scope: "running"}).flatMap(g => g.sessions.map(s => s.key)), ["a:new"]);
  assert.deepEqual(sessionGroups(rows, [a, b], {scope: "watched", device: b.url}).flatMap(g => g.sessions.map(s => s.key)), ["b:new"]);
  assert.deepEqual(rows, before, "grouping/filtering must never mutate Watch or session state");
});

test("search and device/scope filters combine without merging paths across computers", () => {
  const source: HostSource = { id: "nuc", name: "NUC", nameSource: "hostname", online: true };
  const rows: SessionSummary[] = [
    { key: "one", id: "one", name: "整理打印流程", cwd: "/notes", source, model: "deepseek-v4", tunnel: "pi", runtimeStatus: "idle", monitored: true },
    { key: "two", id: "two", name: "Fix UI", cwd: "/web", source, tunnel: "codex", runtimeStatus: "running" },
  ];
  assert.equal(sessionGroups(rows, [source], {search: "  打印  ", scope: "watched", device: "nuc"})[0].sessions[0].key, "one");
  assert.equal(sessionGroups(rows, [source], {search: "DEEPSEEK"})[0].sessions[0].key, "one");
  assert.equal(sessionGroups(rows, [source], {search: "missing"}).length, 0);
  assert.equal(sessionGroups(rows, [source], {device: "other"}).length, 0);
});
