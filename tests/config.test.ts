import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalConfig } from "../apps/windows/src/config.js";

test("fresh installation generates distinct persistent keys without rotating existing settings", t => {
  const directory = mkdtempSync(join(tmpdir(), "pilot-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = ensureLocalConfig(directory);
  assert.equal(first.controlToken?.length, 32);
  assert.notEqual(first.controlToken, first.notificationToken);
  const path = join(directory, "bridge-config.json");
  const configured = { ...first, customSetting: "preserve" };
  writeFileSync(path, JSON.stringify(configured));
  const before = readFileSync(path, "utf8");
  assert.deepEqual(ensureLocalConfig(directory), configured);
  assert.equal(readFileSync(path, "utf8"), before);
  writeFileSync(path, "broken fixture");
  assert.throws(() => ensureLocalConfig(directory), /Invalid/);
  assert.equal(readFileSync(path, "utf8"), "broken fixture", "Corrupt config must not silently rotate pairings");
});
