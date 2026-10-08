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
  assert.deepEqual(sessionGroups(rows, [a, b], {scope: "watched", devices: [b.url!]}).flatMap(g => g.sessions.map(s => s.key)), ["b:new"]);
  assert.deepEqual(rows, before, "grouping/filtering must never mutate Watch or session state");
});

test("search and device/scope filters combine without merging paths across computers", () => {
  const source: HostSource = { id: "nuc", name: "NUC", nameSource: "hostname", online: true };
  const rows: SessionSummary[] = [
    { key: "one", id: "one", name: "整理打印流程", cwd: "/notes", source, model: "deepseek-v4", tunnel: "pi", runtimeStatus: "idle", monitored: true },
    { key: "two", id: "two", name: "Fix UI", cwd: "/web", source, tunnel: "codex", runtimeStatus: "running" },
  ];
  assert.equal(sessionGroups(rows, [source], {search: "  打印  ", scope: "watched", devices: ["nuc"]})[0].sessions[0].key, "one");
  assert.equal(sessionGroups(rows, [source], {search: "DEEPSEEK"})[0].sessions[0].key, "one");
  assert.equal(sessionGroups(rows, [source], {search: "missing"}).length, 0);
  assert.equal(sessionGroups(rows, [source], {devices: ["other"]}).length, 0);
});

test("multiple devices combine with search, project and status while preserving host identity", () => {
  const a: HostSource = { id: "a", name: "Workstation", url: "http://host-a:4317", nameSource: "hostname", online: true };
  const b: HostSource = { id: "b", name: "Workstation", url: "http://host-b:4317", nameSource: "hostname", online: false };
  const c: HostSource = { id: "c", name: "Workstation", url: "http://host-c:4317", nameSource: "hostname", online: true };
  const rows: SessionSummary[] = [
    { key: "a:one", id: "one", name: "Fix UI", cwd: "/web", source: a, updatedAt: 1, runtimeStatus: "running", monitored: true },
    { key: "b:one", id: "one", name: "Fix UI", cwd: "/web", source: { ...b, online: true }, updatedAt: 5, runtimeStatus: "running", monitored: true },
    { key: "c:one", id: "one", name: "Fix UI", cwd: "/web", source: c, updatedAt: 6, runtimeStatus: "running", monitored: true },
    { key: "a:two", id: "two", name: "Fix UI", cwd: "/web", source: a, updatedAt: 4, runtimeStatus: "idle", monitored: false },
    { key: "a:three", id: "three", name: "Fix API", cwd: "/web", source: a, updatedAt: 8, runtimeStatus: "running", monitored: true },
    { key: "a:four", id: "four", name: "Fix UI", cwd: "/other", source: a, updatedAt: 9, runtimeStatus: "running", monitored: true },
  ];
  const hosts = [a, b, c];
  const filters = Object.freeze({ devices: Object.freeze([a.url!, b.url!]), search: "  FIX UI  ", project: "/web" });
  const before = structuredClone({ rows, hosts, filters });
  const keys = (scope: "all" | "watched" | "running") => sessionGroups(rows, hosts, { ...filters, scope })
    .flatMap(group => group.sessions.map(session => session.key));

  assert.deepEqual(keys("all"), ["a:two", "a:one", "b:one"]);
  assert.deepEqual(keys("watched"), ["a:one", "b:one"]);
  assert.deepEqual(keys("running"), ["a:one"], "host availability overrides cached row availability");
  assert.deepEqual({ rows, hosts, filters }, before, "filters must not change their inputs or Watch state");
});

test("no selected devices means all computers, including empty offline groups", () => {
  const online: HostSource = { id: "online", name: "A computer", nameSource: "hostname", online: true };
  const offline: HostSource = { id: "offline", name: "B computer", nameSource: "hostname", online: false };
  const rows: SessionSummary[] = [
    { key: "online:one", id: "one", name: "Session", cwd: "/web", source: online, runtimeStatus: "running", monitored: true },
  ];
  const hosts = [online, offline];
  const all = sessionGroups(rows, hosts);

  assert.deepEqual(all.map(group => group.key), ["online", "offline"]);
  assert.equal(all[1].online, false);
  assert.deepEqual(all[1].sessions, []);
  assert.deepEqual(sessionGroups(rows, hosts, { devices: [] }), all);
  assert.deepEqual(sessionGroups(rows, hosts, { devices: [], scope: "all" }), all);
  assert.deepEqual(sessionGroups(rows, hosts, { devices: [], scope: "watched" }).map(group => group.key), ["online"]);
  assert.deepEqual(sessionGroups(rows, hosts, { devices: ["offline"] }).map(group => group.key), ["offline"]);
});
