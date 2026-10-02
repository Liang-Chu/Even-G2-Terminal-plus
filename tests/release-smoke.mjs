import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Use only the supplied release ZIP and an empty disposable installation. Never
// read real agent histories, send a model prompt, register push or touch port 4317.
const release = resolve(process.argv[2]);
const inventory = JSON.parse(readFileSync(join(release, 'inventory.json'), 'utf8'));
const directory = mkdtempSync(join(release, 'smoke-'));
const install = join(directory, 'Even-Pilot');
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const unzip = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  `Expand-Archive -LiteralPath ${literal(join(release, `Even-Pilot-${inventory.version}-windows.zip`))} -DestinationPath ${literal(directory)}`], { windowsHide: true });
assert.equal(unzip.status, 0, 'ZIP extracts');
for (const file of inventory.files) {
  assert.equal(createHash('sha256').update(readFileSync(join(install, file.path))).digest('hex'), file.sha256, file.path);
}
assert.equal(existsSync(join(install, '.local')), false, 'No private data directory in ZIP');
assert.equal(existsSync(join(install, 'node_modules/tsx/package.json')), true, 'Production dependencies bundled');
assert.equal(existsSync(join(install, 'runtime/node.exe')), true, 'Node runtime bundled');
assert.equal(existsSync(join(install, 'even-glance-firebase.json')), false, 'No service account in ZIP');
for (const path of ['tests', 'outputs', 'apps/evenhub/src', 'apps/windows/desktop/Tray.cs', 'scripts/package-release.mjs'])
  assert.equal(existsSync(join(install, path)), false, 'No development artifacts: ' + path);
const runtimePackage = JSON.parse(readFileSync(join(install, 'package.json'), 'utf8'));
assert.equal(runtimePackage.devDependencies, undefined);
assert.equal(runtimePackage.scripts.proof, undefined);
const env = { ...process.env, EVEN_PILOT_DATA_DIR: join(install, '.local'),
  PATH: join(process.env.WINDIR, 'System32') + ';' + process.env.WINDIR,
  CODEX_HOME: join(directory, 'fixture-codex'),
  EVEN_PILOT_TOKEN: '', EVEN_PILOT_NOTIFICATION_TOKEN: '', EVEN_PILOT_FCM_PROJECT_ID: '', GOOGLE_APPLICATION_CREDENTIALS: '',
  PI_CODING_AGENT_DIR: join(directory, 'fixture-pi'), PI_CODING_AGENT_SESSION_DIR: '', CLAUDE_CONFIG_DIR: join(directory, 'fixture-claude'),
  EVEN_PILOT_CODEX: join(directory, 'not-installed-codex.exe') };
const setup = spawnSync('cmd.exe', ['/d', '/c', 'Setup.cmd'], { cwd: install, env, windowsHide: true,
  input: '\r\n', encoding: 'utf8', timeout: 120_000 });
assert.equal(setup.status, 0, 'Bundled Setup.cmd works without a system Node/npm: ' + setup.stdout + setup.stderr);
assert.equal(existsSync(join(install, 'node_modules/tsx/package.json')), true);
assert.equal(existsSync(join(install, 'node_modules/typescript/package.json')), false, 'Production-only installation');
assert.equal(existsSync(join(install, 'node_modules/@evenrealities/even_hub_sdk/package.json')), false, 'Frontend SDK stays in the built Hub assets');
const interruptHelper = spawnSync(join(install, 'apps/windows/desktop/Even-Pilot.TerminalInterrupt.exe'), ['identity', String(process.pid)],
  { windowsHide: true, encoding: 'utf8', timeout: 5000 });
assert.equal(interruptHelper.status, 0, 'Bundled terminal helper runs without a compiler at install time');
assert.match(interruptHelper.stdout.trim(), /^\d{15,20}$/);
const configPath = join(install, '.local/bridge-config.json');
// Exercise the EXE's own first-run path, without opening a UI or real backend.
unlinkSync(configPath);
for (let run = 0; run < 2; run++) {
  const prepared = spawnSync(join(install, 'Even-Pilot.exe'), ['--prepare'], { cwd: directory, env, windowsHide: true, timeout: 20_000 });
  assert.equal(prepared.status, 0, 'EXE prepares from a different working directory');
  if (run === 0) writeFileSync(join(directory, 'initial-config.json'), readFileSync(configPath));
  else assert.equal(readFileSync(configPath, 'utf8'), readFileSync(join(directory, 'initial-config.json'), 'utf8'), 'Keys persist');
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
assert.notEqual(config.controlToken, config.notificationToken);
assert.equal(config.firebaseCredentialsPath, undefined);
assert.equal(existsSync(join(install, '.local/desktop-runtime.json')), false, 'No developer Node path required');
const reserved = createServer();
await new Promise(done => reserved.listen(0, '127.0.0.1', done));
const port = reserved.address().port;
await new Promise(done => reserved.close(done));
const backend = spawn(join(install, 'runtime/node.exe'), ['--import', 'tsx', 'apps/windows/src/cli.ts', '--host', '127.0.0.1', '--port', String(port)],
  { cwd: install, env, windowsHide: true, stdio: 'ignore' });
const origin = 'http://127.0.0.1:' + port;
const request = (path, init = {}) => fetch(origin + path, { ...init, headers: { Authorization: 'Bearer ' + config.controlToken, ...init.headers }, signal: AbortSignal.timeout(2000) });
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (backend.exitCode !== null) throw new Error('Fresh backend exited before ready');
    try { ready = (await request('/api/monitoring')).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert(ready, 'Fresh backend starts');
  assert.equal((await fetch(origin + '/api/state')).status, 401, 'Unauthenticated state blocked');
  const state = await (await request('/api/monitoring')).json();
  assert.equal(state.nativeTerminals, true);
  assert.equal(state.running, 0);
  const hostInfo = await (await request('/api/host')).json();
  assert.equal(typeof hostInfo.name, 'string'); assert.ok(['tailscale', 'hostname'].includes(hostInfo.nameSource));
  assert.equal((await request('/')).status, 200, 'Packaged frontend served');
  assert.equal((await request('/licenses/Even-Hub-SDK-MIT.txt')).status, 200);
  const sessions = await (await request('/api/sessions')).json();
  assert.equal(sessions.sessions.length, 0, 'No real user histories consulted');
  assert.equal((await request('/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  for (let i = 0; i < 100 && backend.exitCode === null; i++) await delay(50);
  assert.equal(backend.exitCode, 0, 'Isolated backend exits normally');
  console.log('PASS: ZIP inventory, bundled runtime without system Node/npm, fresh EXE keys, persistence, isolated native backend, auth, assets and shutdown.');
} finally {
  if (backend.exitCode === null) backend.kill(); // Only this test's isolated child.
}
