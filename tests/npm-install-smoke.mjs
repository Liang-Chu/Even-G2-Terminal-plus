import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Real npm/global and native installers, entirely inside synthetic HOME/data.
// This does not open a real CLI session, request a model turn or register FCM.
if (process.platform !== 'linux' || process.getuid?.() === 0) {
  throw new Error('Run this smoke as a normal Linux user, without sudo');
}
const args = process.argv.slice(2);
const previousAt = args.indexOf('--previous');
if (!args[0] || (args.length !== 1 && (previousAt !== 1 || args.length !== 3))) {
  throw new Error('Usage: node tests/npm-install-smoke.mjs package.tgz|even-pilot@VERSION [--previous previous-linux.run]');
}
const registryPackage = /^even-pilot@\d+\.\d+\.\d+$/.test(args[0]);
const archive = registryPackage ? args[0] : realpathSync(resolve(args[0]));
const previous = previousAt >= 0 ? realpathSync(resolve(args[previousAt + 1])) : undefined;
assert.ok(registryPackage || archive.endsWith('.tgz'), 'Use a packed .tgz or exact public release version');
if (previous) assert.ok(previous.endsWith('.run'), 'The previous native installer must be a .run');
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label);
    await delay(100);
  }
}
async function fixture(upgrade) {
  const directory = mkdtempSync(join(tmpdir(), 'pilot-npm-smoke-'));
  const home = join(directory, 'home'), prefix = join(home, '.local');
  const data = join(directory, 'data'), defaultRoot = join(prefix, 'lib/even-pilot');
  const root = upgrade ? join(directory, "App with spaces and ' quote") : defaultRoot;
  const launcher = join(prefix, 'bin/even-pilot'), helper = join(prefix, 'bin/even-pilot-setup');
  mkdirSync(home); mkdirSync(data);
  writeFileSync(join(data, 'update-settings.json'), '{"automaticChecks":false}');
  const npmrc = join(directory, 'npmrc'); writeFileSync(npmrc, '');
  const reservation = createServer();
  await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  check(port !== 4317, 'Fixture never uses the live monitor port');
  const env = {
    ...process.env, HOME: home, SHELL: '/bin/bash',
    PATH: [join(prefix, 'bin'), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    XDG_DATA_HOME: join(directory, 'share'), XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'),
    EVEN_PILOT_DATA_DIR: data, EVEN_PILOT_PORT: String(port), EVEN_PILOT_NO_SYSTEMD: '1',
    EVEN_PILOT_SERVICE_NAME: 'pilot-npm-smoke-' + randomUUID() + '.service',
    EVEN_PILOT_INSTALL_DIR: '', EVEN_PILOT_BIN_DIR: '', EVEN_PILOT_TOKEN: '', EVEN_PILOT_NOTIFICATION_TOKEN: '',
    PI_CODING_AGENT_DIR: join(directory, 'pi'), PI_CODING_AGENT_SESSION_DIR: '',
    CODEX_HOME: join(directory, 'codex'), CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    EVEN_PILOT_PI: join(directory, 'no-pi'), EVEN_PILOT_CODEX: join(directory, 'no-codex'), EVEN_PILOT_CLAUDE: join(directory, 'no-claude'),
    GOOGLE_APPLICATION_CREDENTIALS: '', EVEN_PILOT_FCM_PROJECT_ID: '',
    DISPLAY: '', WAYLAND_DISPLAY: '', XAUTHORITY: '', DBUS_SESSION_BUS_ADDRESS: '',
    NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_CACHE: join(directory, 'npm-cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  // Do not inherit an authenticated npm userconfig or project prefix from the
  // host. Package lifecycle execution is set explicitly; registry installs use
  // only an exact public release and no authentication.
  for (const name of ['npm_config_userconfig', 'npm_config_prefix', 'npm_config_cache', 'npm_config_ignore_scripts', 'NPM_CONFIG_IGNORE_SCRIPTS', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_ALLOW_SCRIPTS', 'npm_config_allow_scripts']) delete env[name];
  const run = (exe, command) => spawnSync(exe, command, { env, cwd: directory, encoding: 'utf8', timeout: 150000 });
  const successful = (exe, command, label) => {
    const result = run(exe, command);
    check(result.status === 0 && !result.error, label + ': ' + (result.stderr || result.error?.message || result.stdout));
    return result.stdout;
  };
  const npm = (...command) => successful('npm', ['--prefix', prefix, ...command, '--no-audit', '--no-fund', '--loglevel', 'warn'], 'npm ' + command[0]);
  const configPath = join(data, 'bridge-config.json');
  let token, worker, finished = false;
  const request = async path => fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: 'Bearer ' + token, Connection: 'close' }, signal: AbortSignal.timeout(1500),
  });
  const healthy = async () => { try { return (await request('/api/monitoring')).ok; } catch { return false; } };
  const alive = () => { try { process.kill(worker.pid, 0); return true; } catch { return false; } };
  const installed = () => JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
  try {
    let oldRecord, original;
    if (upgrade) {
      successful('sh', [previous, '--dir', root, '--no-start'], 'Install previous native release in a spaced/quoted path');
      oldRecord = installed(); original = readFileSync(configPath, 'utf8');
      token = JSON.parse(original).controlToken;
      successful(launcher, ['start'], 'Start only the previous fixture backend');
      await until(healthy, 'previous fixture backend becomes healthy');
      const payload = join(root, 'versions', oldRecord.current);
      worker = spawn(join(payload, 'runtime/node'), ['-e', 'setInterval(()=>{},1000)'], { env, cwd: payload, stdio: 'ignore' });
      await new Promise((done, fail) => { worker.once('spawn', done); worker.once('error', fail); });
      mkdirSync(join(data, 'native'), { recursive: true });
      writeFileSync(join(data, 'native', worker.pid + '.json'), JSON.stringify({ version: 1, pid: worker.pid, instance: randomUUID(), at: Date.now(), state: { connected: true } }));
      check(alive(), 'Synthetic native worker is running before npm upgrade');
    }
    npm('install', '--global', '--ignore-scripts', archive);
    check(existsSync(helper), 'npm installs the setup helper in HOME/.local/bin');
    check(!existsSync(join(prefix, 'lib/node_modules/even-pilot/runtime')), 'npm package does not own the native payload/runtime');
    if (upgrade) {
      check(installed().current === oldRecord.current, 'Scripts-disabled npm installation does not update the existing native app');
      check(readFileSync(configPath, 'utf8') === original, 'Scripts-disabled npm installation preserves existing keys');
    } else {
      check(!existsSync(launcher) && !existsSync(join(root, 'install.json')), 'Scripts-disabled npm installation does not create a native launcher/install');
      check(!existsSync(configPath), 'Scripts-disabled npm installation does not initialize connection keys');
    }
    const packageManifest = JSON.parse(readFileSync(join(prefix, 'lib/node_modules/even-pilot/package.json'), 'utf8'));
    check(packageManifest.name === 'even-pilot' && typeof packageManifest.version === 'string', 'Installed package has the expected public name/version');
    successful(helper, [], 'Explicit setup installs or upgrades the bundled verified native app');
    const record = installed();
    check(record.version === packageManifest.version, 'Native version equals the installed npm package version');
    check(realpathSync(launcher) === join(root, 'versions', record.current, 'bin/even-pilot'), 'Native global launcher belongs to the detected installation root');
    check(readlinkSync(launcher).endsWith('/current/bin/even-pilot'), 'npm helper leaves the native global launcher as its own symlink');
    check(existsSync(configPath), 'Native setup initializes connection configuration');
    original ||= readFileSync(configPath, 'utf8'); token = JSON.parse(original).controlToken;
    check(typeof token === 'string' && token.length >= 20, 'Native setup creates a usable connection key');
    if (!upgrade) {
      check(!await healthy(), 'Fresh npm setup installs without automatically starting the monitor');
      successful(launcher, ['start'], 'Start only the new fixture backend');
    }
    await until(healthy, 'npm-installed fixture backend becomes healthy');
    check((await (await request('/api/updates')).json()).currentVersion === packageManifest.version, 'Backend reports the npm package version after setup');
    successful(helper, [], 'Second explicit setup is harmless');
    check(readFileSync(configPath, 'utf8') === original, 'Repeated setup preserves exact saved connection settings');
    check(installed().current === record.current, 'Repeated setup preserves the active version directory');
    if (upgrade) {
      check(!existsSync(join(defaultRoot, 'install.json')), 'Setup follows the existing custom root rather than installing a second app');
      check(record.versions.includes(oldRecord.current), 'Upgrade retains the old native payload for its consumers');
      check(alive(), 'Native fake worker survives the monitor upgrade');
    }
    npm('uninstall', '--global', 'even-pilot', '--ignore-scripts');
    check(!existsSync(helper), 'npm uninstall removes only the npm setup helper');
    check(existsSync(launcher) && existsSync(join(root, 'install.json')), 'Native monitor/launcher remains installed after npm uninstall');
    check(readFileSync(configPath, 'utf8') === original, 'npm uninstall preserves native connection/watch configuration');
    check(await healthy(), 'npm uninstall does not stop the native monitor');
    successful(launcher, ['--help'], 'Native global launcher still works without the npm package');
    const npmVersion = successful('npm', ['--version'], 'Read fixture npm version').trim();
    const lifecycleFlags = Number(npmVersion.split('.')[0]) >= 12 ? ['--allow-scripts=even-pilot'] : [];
    const lifecycleOutput = npm('install', '--global', '--ignore-scripts=false', '--foreground-scripts', ...lifecycleFlags, archive);
    check(existsSync(helper), 'Scripts-enabled npm reinstall restores the helper');
    check(/already installed\. Keeping its current release and settings/.test(lifecycleOutput), 'Global postinstall actually runs and skips the equal native version');
    check(installed().current === record.current && readFileSync(configPath, 'utf8') === original, 'Postinstall skips the equal native version and keeps saved keys');
    check(await healthy(), 'Equal-version postinstall preserves the running fixture monitor');
    if (worker) check(alive(), 'Synthetic native worker survives npm uninstall and reinstall');
    const push = await (await request('/api/glance/push')).json();
    check(push.configured === false && push.subscriptions.length === 0 && push.jobs.length === 0, 'Fixture has no Firebase sender, subscribers or outbound pushes');
    successful(launcher, ['stop'], 'Stop only the isolated fixture backend');
    if (worker) {
      check(alive(), 'Monitor stop leaves the synthetic native worker alive');
      worker.kill(); await until(() => worker.exitCode !== null || worker.signalCode !== null, 'fixture worker exits');
      rmSync(join(data, 'native', worker.pid + '.json'), { force: true });
    }
    successful(launcher, ['uninstall'], 'Uninstall only the fixture native app');
    check(!existsSync(launcher) && !existsSync(join(root, 'install.json')), 'Native uninstall removes its own launcher/install record');
    check(readFileSync(configPath, 'utf8') === original, 'Native uninstall retains saved connection/watch settings');
    npm('uninstall', '--global', 'even-pilot', '--ignore-scripts');
    check(!existsSync(helper), 'Remove the fixture npm helper after native uninstall');
    finished = true;
    console.log('PASS: npm ' + npmVersion + ' ' + (upgrade ? 'custom-root native upgrade' : 'fresh install') + ', shared ~/.local global prefix, scripts disabled/enabled, repeated setup, npm removal/native retention, key retention, healthy backend' + (upgrade ? ', old-payload and native-worker survival' : '') + '.');
  } finally {
    if (worker?.exitCode === null && worker?.signalCode === null) {
      worker.kill(); await until(() => worker.exitCode !== null || worker.signalCode !== null, 'cleanup fixture worker exits').catch(() => {});
    }
    if (existsSync(launcher)) {
      const stopped = run(launcher, ['stop']);
      if (stopped.status !== 0) console.error('Could not stop fixture monitor; retained at ' + directory);
    }
    await delay(150);
    // Recursive removal is confined to a real mkdtemp child and only occurs
    // after successful owned uninstall. Failed fixtures are kept for inspection.
    const cleanupTarget = resolve(directory), temporaryRoot = realpathSync(tmpdir());
    if (finished && !existsSync(join(root, 'install.json')) && cleanupTarget.startsWith(temporaryRoot + sep)
      && dirname(cleanupTarget) === temporaryRoot && realpathSync(directory) === cleanupTarget) {
      rmSync(cleanupTarget, { recursive: true, force: true });
    } else console.error('Retained npm smoke fixture: ' + directory);
  }
}
await fixture(false);
if (previous) await fixture(true);
console.log('PASS: ' + checks + ' npm/native installation assertions; no real sessions, credentials or default monitor were used.');
