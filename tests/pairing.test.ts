import test from "node:test";
import assert from "node:assert/strict";
import { pairingUrl, pairingDetails, printPairingQr } from "../apps/windows/src/pairing.js";
import { parsePairingUrl } from "../apps/evenhub/src/bridge/pairing.js";
import jsQR from "jsqr";
import { createRequire } from "node:module";
import { CockpitStore } from "../packages/cockpit-state/store.js";
import { NotificationJournal } from "../apps/windows/src/notifications.js";
import { GlancePush } from "../apps/windows/src/push.js";
import { createBridgeServer } from "../apps/windows/src/server.js";

test("pairing QR round-trips a control token without sending it in a query", () => {
  const token = "test-token-1234567890123456789";
  const url = pairingUrl("http://100.64.0.2:4317", token);
  assert.equal(new URL(url).search, "");
  assert.deepEqual(parsePairingUrl(url), { url: "http://100.64.0.2:4317", token });
});

test("the same versioned QR decodes to the backend key and a complete Glance registration URL", () => {
  const token = "same-backend-key-1234567890123456789";
  const details = pairingDetails("http://192.168.1.25:4317", token);
  const fragment = new URLSearchParams(new URL(details.url).hash.slice(1));
  assert.equal(fragment.get("pilot-pair"), "1"); assert.equal(fragment.get("pilot-token"), token);
  assert.equal(details.registrationUrl, "http://192.168.1.25:4317/api/glance");
  assert.match(details.image, /^data:image\/png;base64,/);
  const qr = createRequire(import.meta.url)("qr-image");
  const matrix = qr.matrix(details.url), quiet = 4, scale = 6, size = (matrix.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) if (matrix[y][x]) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const index = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
      pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
    }
  }
  const decoded = jsQR(pixels, size, size);
  assert.ok(decoded, "Desktop QR remains readable by a standard decoder");
  assert.deepEqual(parsePairingUrl(decoded.data), { url: "http://192.168.1.25:4317", token });
  assert.deepEqual(parsePairingUrl(`http://127.0.0.1:4317/?desktop=1#pilot-token=${token}`), { url: "http://127.0.0.1:4317", token });
  assert.throws(() => parsePairingUrl(`http://127.0.0.1:4317/#pilot-pair=9&pilot-token=${token}`));
  assert.throws(() => parsePairingUrl(`http://127.0.0.1:4317/#pilot-token=${token}&pilot-token=${token}`));
  assert.throws(() => parsePairingUrl(`http://127.0.0.1:4317/#pilot-pair=1&pilot-pair=9&pilot-token=${token}`));
  assert.equal(parsePairingUrl("http://192.168.1.25:4317/#pilot-pair=1&pilot-token=sample-key-12345678901234567890%2B%25")?.token,
    "sample-key-12345678901234567890+%");
});
test("pairing rejects unsafe protocols, user info, paths and short credentials", () => {
  const token = "test-token-1234567890123456789";
  for (const url of ["file:///", "javascript:alert(1)", "http://user:pass@localhost:4317", "http://localhost:4317/api/state", "http://localhost:4317/?token=x"]) {
    assert.throws(() => pairingUrl(url, token));
  }
  assert.throws(() => pairingUrl("http://localhost:4317", "short"));
  assert.equal(parsePairingUrl("http://localhost:4317"), undefined);
});

test("terminal QR decodes to the same phone URL and key with dark or light terminal colors", () => {
  const origin = "http://100.64.0.2:4317", token = "terminal-test-key-1234567890123456789";
  let output = "";
  const log = console.log;
  try { console.log = value => { output += String(value); }; printPairingQr(origin, token); }
  finally { console.log = log; }
  const rows = output.trimEnd().split("\n"), modules = rows[0].length, scale = 6, quiet = 4;
  const width = (modules + quiet * 2) * scale, height = (rows.length * 2 + quiet * 2) * scale;
  for (const inverted of [false, true]) {
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet;
      const char = mx >= 0 && mx < modules && my >= 0 && my < rows.length * 2 ? rows[Math.floor(my / 2)][mx] : "█";
      const white = char === "█" || char === "▀" && my % 2 === 0 || char === "▄" && my % 2 === 1;
      const value = white !== inverted ? 255 : 0, at = (y * width + x) * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = value;
    }
    const decoded = jsQR(pixels, width, height, { inversionAttempts: "attemptBoth" });
    assert.ok(decoded, "Terminal half-block QR remains scannable");
    assert.deepEqual(parsePairingUrl(decoded.data), { url: origin, token });
  }
});

test("pairing is control-only and its single key authenticates both the monitor and Glance push registration", async t => {
  const store = new CockpitStore("test"), journal = new NotificationJournal(store);
  const push = new GlancePush(journal, { projectId: "even-glance" });
  const key = "shared-pair-key-1234567890123456789";
  const bridge = createBridgeServer({ store } as any, journal, { token: key, notificationToken: "legacy-notification-only-key",
    push, pairOrigin: "http://192.168.1.25:4317" });
  await new Promise<void>(done => bridge.server.listen(0, "127.0.0.1", done));
  t.after(async () => { await bridge.close(); await push.close(); journal.close(); });
  const base = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  assert.equal((await fetch(base + "/api/pairing")).status, 401);
  assert.equal((await fetch(base + "/api/pairing", { headers: { Authorization: "Bearer legacy-notification-only-key" } })).status, 403);
  const pairing = await (await fetch(base + "/api/pairing", { headers })).json() as any;
  assert.equal(parsePairingUrl(pairing.url)?.token, key);
  assert.equal((await fetch(base + "/api/state", { headers })).status, 200);
  const registration = await fetch(base + "/api/glance", { method: "POST", headers,
    body: JSON.stringify({ operation: "register_push", subscription_id: "qr-watcher", installation_id: "test-fid", firebase_project_id: "even-glance",
      watcher: "Even-Pilot", max_length: 80, title_max_length: 32, expires_after_seconds: 30, client: "Glance" }) });
  assert.equal(registration.status, 204); assert.equal(await registration.text(), "");
});
