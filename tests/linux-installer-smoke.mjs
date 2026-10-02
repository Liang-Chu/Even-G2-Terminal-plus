import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const setup = resolve(process.argv[2]), systemd = process.argv.includes('--systemd');
const previousIndex = process.argv.indexOf('--previous');
const previousSetup = previousIndex >= 0 ? resolve(process.argv[previousIndex + 1]) : setup;
const fixture = mkdtempSync(join(tmpdir(), 'pilot-linux-install-'));
const root = join(fixture, "App with spaces and ' quote"), data = join(fixture, 'data');
const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port; await new Promise(done => reservation.close(done));
const env = { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', EVEN_PILOT_INSTALL_DIR: root, EVEN_PILOT_DATA_DIR: data,
  EVEN_PILOT_BIN_DIR: join(fixture, 'bin'), XDG_DATA_HOME: join(fixture, 'share'), XDG_CONFIG_HOME: join(fixture, 'config'),
  EVEN_PILOT_SERVICE_NAME: 'even-pilot-test-' + randomUUID() + '.service', EVEN_PILOT_NO_SYSTEMD: systemd ? '' : '1',
  EVEN_PILOT_PORT: String(port), PI_CODING_AGENT_DIR: join(fixture, 'pi'), PI_CODING_AGENT_SESSION_DIR: '',
  CODEX_HOME: join(fixture, 'codex'), CLAUDE_CONFIG_DIR: join(fixture, 'claude'), GOOGLE_APPLICATION_CREDENTIALS: '',
  EVEN_PILOT_TOKEN: '', EVEN_PILOT_NOTIFICATION_TOKEN: '', EVEN_PILOT_FCM_PROJECT_ID: '', DISPLAY: '', WAYLAND_DISPLAY: '' };
const invoke = (exe, args) => spawnSync(exe, args, { env, encoding: 'utf8', timeout: 90000, cwd: fixture });
const launcher = join(env.EVEN_PILOT_BIN_DIR, 'even-pilot');
const command = (...args) => { const result = invoke(launcher, args); assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout; };
let worker, token, native;
const request = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Connection: 'close' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
try {
  const install = invoke('sh', [previousSetup, '--dir', root, '--no-start']); assert.equal(install.status, 0, install.stderr + install.stdout);
  const record = JSON.parse(readFileSync(join(root, 'install.json'))), payload = join(root, 'versions', record.current);
  const original = readFileSync(join(data, 'bridge-config.json'), 'utf8'); token = JSON.parse(original).controlToken;
  writeFileSync(join(data, 'update-settings.json'), '{"automaticChecks":false}');
  assert.match(command('start'), /running/);
  assert.equal((await request('/api/monitoring')).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  const html = await (await request('/')).text(); assert.match(html, /Even-Pilot/);
  command('autostart', 'on'); command('autostart', 'off');
  if (process.env.EVEN_PILOT_PI) {
    if (previousSetup === setup) command('new', 'pi', '--cwd', fixture, '--name', 'Linux release check');
    else {
      const response = await request('/api/session/new', { tunnel: 'pi', cwd: fixture, name: 'Linux release check' });
      const state = await response.json(); assert.equal(response.status, 200, JSON.stringify(state));
    }
    for (let n = 0; n < 100 && !native; n++) {
      for (const name of existsSync(join(data, 'native')) ? readdirSync(join(data, 'native')) : []) {
        if (!/^\d+\.json$/.test(name)) continue;
        const snapshot = JSON.parse(readFileSync(join(data, 'native', name)));
        if (snapshot.state?.connected && snapshot.state.session?.tunnel === 'pi') native = snapshot;
      }
      if (!native) await delay(100);
    }
    assert.ok(native, 'Real Pi TUI connected through its installed extension');
    const tmuxName = 'pilot-pi-' + createHash('sha256').update(native.sessionFile).digest('hex').slice(0, 12);
    const keep = invoke('tmux', ['set-option', '-w', '-t', '=' + tmuxName + ':', 'remain-on-exit', 'on']);
    assert.equal(keep.status, 0, keep.stderr + ' target=' + tmuxName + ' sessions=' + invoke('tmux', ['list-sessions']).stdout);
    const unwatch = await request('/api/runtime/' + native.state.session.key + '/monitor', { monitored: false });
    assert.equal(unwatch.status, 200); process.kill(native.pid, 0);
  }
  worker = spawn(join(payload, 'runtime/node'), ['-e', 'setInterval(()=>{},1000)'], { env, cwd: payload, stdio: 'ignore' });
  await new Promise((done, fail) => { worker.once('spawn', done); worker.once('error', fail); });
  mkdirSync(join(data, 'native'), { recursive: true });
  writeFileSync(join(data, 'native', worker.pid + '.json'), JSON.stringify({ state: { connected: true } }));
  const refused = invoke(launcher, ['uninstall']); assert.notEqual(refused.status, 0, 'Do not uninstall a working native terminal');
  assert.equal((await request('/api/monitoring')).status, 200);
  const upgrade = invoke('sh', [setup, '--dir', root, '--update']); assert.equal(upgrade.status, 0, upgrade.stderr + upgrade.stdout);
  const updated = JSON.parse(readFileSync(join(root, 'install.json')));
  assert.equal(updated.versions.length, updated.current === record.current ? 1 : 2, 'Prior payload remains available to existing terminals');
  assert.equal(readFileSync(join(data, 'bridge-config.json'), 'utf8'), original);
  assert.equal(worker.exitCode, null, 'Upgrade preserves the native runtime');
  if (native) process.kill(native.pid, 0);
  assert.equal((await request('/api/monitoring')).status, 200);
  assert.equal((await (await request('/api/updates')).json()).automaticChecks, false);
  assert.match(command('update', 'status'), /automatic checks off/);
  assert.match(command('--help'), /no browser required/);
  const pairing = command('pair');
  assert.ok(pairing.includes('Connection key: ' + token), 'Pair uses the saved connection key');
  assert.match(pairing, /Glance URL: http:\/\/.+:\d+\/api\/glance/);
  assert.match(pairing, /Scan in Glance/);
  assert.match(pairing, /[▀▄█]{20,}/, 'Installed CLI prints the terminal QR');
  const hostInfo = await (await request('/api/host')).json();
  assert.equal(typeof hostInfo.name, 'string'); assert.ok(['tailscale', 'hostname'].includes(hostInfo.nameSource));
  if (process.env.EVEN_PILOT_TEST_HOSTNAME) assert.equal(hostInfo.name, process.env.EVEN_PILOT_TEST_HOSTNAME);
  const catalog = JSON.parse(command('sessions', '--json')); assert.ok(Array.isArray(catalog.sessions));
  if (native) {
    const key = native.state.session.key;
    command('watch', key);
    assert.equal(JSON.parse(command('sessions', '--watched', '--json')).sessions.some(session => session.key === key), true);
    command('select', key);
    command('unwatch', key);
    assert.equal(JSON.parse(command('sessions', '--watched', '--json')).sessions.some(session => session.key === key), false);
    process.kill(native.pid, 0);
  }
  command('stop'); assert.equal(worker.exitCode, null, 'Service stop preserves a native process');
  if (native) {
    // A foreground CLI launch must bring up its monitor, even after an explicit
    // stop. --help exercises the real Pi executable without a paid model turn.
    command('terminal', 'pi', '--help');
    assert.equal((await request('/api/monitoring')).status, 200, 'Foreground terminal starts its monitor');
    command('stop');
    process.kill(native.pid, 0);
    const before = JSON.parse(readFileSync(join(data, 'native', native.pid + '.json'))).at;
    await delay(2300);
    assert.ok(JSON.parse(readFileSync(join(data, 'native', native.pid + '.json'))).at > before, 'Real Pi heartbeat survives systemd stop');
    const session = 'pilot-pi-' + createHash('sha256').update(native.sessionFile).digest('hex').slice(0, 12);
    assert.equal(invoke('tmux', ['kill-session', '-t', '=' + session]).status, 0, 'Close only this empty test terminal');
    for (let n = 0; n < 100; n++) { try { process.kill(native.pid, 0); } catch { break; } await delay(50); }
    native = undefined;
  }
  worker.kill(); await new Promise(done => worker.once('exit', done));
  command('uninstall');
  assert.equal(existsSync(join(root, 'install.json')), false);
  assert.equal(existsSync(payload), false);
  assert.equal(existsSync(launcher), false);
  assert.equal(readFileSync(join(data, 'bridge-config.json'), 'utf8'), original);
  assert.equal(existsSync(join(env.PI_CODING_AGENT_DIR, 'extensions/even-pilot-monitor.ts')), false);
  console.log('PASS: Linux ' + (systemd ? 'systemd user service' : 'non-systemd daemon') + '; offline self-extracting installer; no global Node; spaced/quoted paths; auth/assets; autostart; reinstall/key retention; native-process survival; safe uninstall.' + (process.env.EVEN_PILOT_PI ? ' Real Pi TUI/extension, tmux, Unwatch and service-stop survival also verified.' : ''));
} finally {
  if (native?.sessionFile) {
    const session = '=pilot-pi-' + createHash('sha256').update(native.sessionFile).digest('hex').slice(0, 12);
    console.error(invoke('tmux', ['capture-pane', '-p', '-t', session + ':']).stdout);
    invoke('tmux', ['kill-session', '-t', session]);
  }
  if (worker?.exitCode === null && worker?.signalCode === null) worker.kill();
  if (existsSync(launcher)) { invoke(launcher, ['stop']); }
  await delay(100);
  if (!existsSync(join(root, 'install.json'))) rmSync(fixture, { recursive: true, force: true });
  else console.error('Retained failed Linux fixture: ' + fixture);
}
