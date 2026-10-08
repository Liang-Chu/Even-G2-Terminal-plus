#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionDirectory = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[a-f0-9]{12}$/;
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: terminal-plus-setup [install|--help]\nInstalls the bundled Linux release as your normal user. Then run terminal-plus.\nUse terminal-plus uninstall to remove the application before npm uninstall -g terminal-plus.';

export function compareStableVersions(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !stableVersion.test(left) || !stableVersion.test(right))
    throw new Error('Expected stable release versions such as 1.1.11');
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let index = 0; index < a.length; index++) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

export function installationPlan(version, installedVersion) {
  compareStableVersions(version, version);
  if (installedVersion === undefined) return { skip: false, argument: '--no-start' };
  return { skip: compareStableVersions(installedVersion, version) >= 0, argument: '--update' };
}

export function nativeRootFromLink(bin, link) {
  if (typeof link !== 'string') return undefined;
  const target = resolve(dirname(bin), link);
  if (!['terminal-plus', 'even-pilot'].some(name => target.endsWith(sep + join('current', 'bin', name)))) return undefined;
  return dirname(dirname(dirname(target)));
}

export function resolveInstallRoot(home, env, nativeLink) {
  const bin = resolve(env.EVEN_PILOT_BIN_DIR || join(home, '.local/bin'), 'terminal-plus');
  return resolve(env.EVEN_PILOT_INSTALL_DIR || nativeRootFromLink(bin, nativeLink) || join(home, '.local/lib/even-pilot'));
}

// Keep installation effects in this entry point. Imports only define helpers.
export function runSetup(argv = [], options = {}) {
  const { platform = process.platform, arch = process.arch, uid = process.getuid?.(), home = homedir(),
    env = process.env, root: npmRoot = packageRoot, readFile = readFileSync, lstat = lstatSync,
    readlink = readlinkSync, spawn = spawnSync, log = console.log } = options;
  if (argv.length === 1 && argv[0] === '--help') { log(usage); return 0; }
  const postinstall = argv.length === 1 && argv[0] === '--postinstall';
  if (argv.length && !postinstall && !(argv.length === 1 && argv[0] === 'install')) throw new Error(usage);
  if (postinstall && !['true', '1'].includes(env.npm_config_global)) {
    log('Native setup skipped for a local npm dependency. Run terminal-plus-setup explicitly to install the application.');
    return 0;
  }
  if (platform !== 'linux') throw new Error('Terminal+ setup requires Linux.');
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('Run terminal-plus-setup as your normal Linux user, without sudo.');

  function info(path) {
    try { return lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  function regularFile(path, maxBytes, owned = false) {
    const stat = info(path);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || owned && stat.uid !== uid)
      throw new Error('Expected a regular' + (owned ? ' user-owned' : '') + ' file: ' + path);
    return stat;
  }
  function json(path, maxBytes, owned = false) {
    regularFile(path, maxBytes, owned);
    try { return JSON.parse(readFile(path, 'utf8')); } catch { throw new Error('Invalid installation metadata: ' + path); }
  }
  const metadata = json(join(npmRoot, 'payload.json'), 65536);
  if (!metadata || typeof metadata.version !== 'string' || !stableVersion.test(metadata.version) || !['x64', 'arm64'].includes(metadata.arch)
    || typeof metadata.installer !== 'string' || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256))
    throw new Error('Invalid bundled release metadata.');
  if (metadata.arch !== arch) throw new Error('Use the Terminal+ package for this Linux CPU architecture.');
  const installer = resolve(npmRoot, metadata.installer), installerRelative = relative(resolve(npmRoot), installer);
  if (isAbsolute(metadata.installer) || !installerRelative || installerRelative === '..' || installerRelative.startsWith('..' + sep)
    || metadata.installer.split(/[\\/]/).some(part => part === '..')
    || basename(installer) !== `Terminal-plus-${metadata.version}-Setup-linux-${metadata.arch}.run`)
    throw new Error('Bundled installer must stay inside the npm package.');
  let payloadPath = installer;
  while (payloadPath !== resolve(npmRoot)) {
    const stat = info(payloadPath);
    if (!stat || stat.isSymbolicLink()) throw new Error('Bundled installer contains a missing or linked path.');
    payloadPath = dirname(payloadPath);
  }
  regularFile(installer, 1024 * 1024 * 1024);

  const binDirectory = resolve(env.EVEN_PILOT_BIN_DIR || join(home, '.local/bin'));
  const bin = join(binDirectory, 'terminal-plus'), legacyBin = join(binDirectory, 'even-pilot');
  const nativeLinks = [];
  for (const launcher of [bin, legacyBin]) {
    const stat = info(launcher);
    if (!stat) continue;
    if (!stat.isSymbolicLink() || stat.uid !== uid) throw new Error('Another executable occupies ' + launcher);
    const link = readlink(launcher), linkedRoot = nativeRootFromLink(launcher, link);
    if (!linkedRoot) throw new Error('Another executable occupies ' + launcher);
    nativeLinks.push({ launcher, link, root: linkedRoot });
  }
  // Both names resolve relative to the same bin directory. Keep discovering a
  // previous custom install through its legacy launcher before choosing a root.
  const root = resolveInstallRoot(home, env, nativeLinks[0]?.link);
  if (/[\r\n\0]/.test(root) || [resolve(sep), resolve(home), '/usr', '/opt', '/var', '/tmp'].includes(root))
    throw new Error('Choose a dedicated Terminal+ installation directory.');
  if (nativeLinks.some(link => link.root !== root))
    throw new Error('An existing Terminal+ launcher belongs to another installation.');
  let parent = root;
  while (true) {
    const stat = info(parent);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Installation parents must be regular directories.');
    if (parent === dirname(parent)) break;
    parent = dirname(parent);
  }
  const rootInfo = info(root);
  if (rootInfo && rootInfo.uid !== uid) throw new Error('The existing installation must be owned by the current user.');
  const recordPath = join(root, 'install.json');
  let installedVersion, installedPayload, installedRelease;
  if (info(recordPath)) {
    const record = json(recordPath, 1024 * 1024, true);
    if (!record || typeof record.version !== 'string' || !stableVersion.test(record.version)
      || typeof record.current !== 'string' || !versionDirectory.test(record.current)
      || !record.current.startsWith(record.version + '-') || !Array.isArray(record.versions)
      || !record.versions.includes(record.current) || !record.versions.every(version => typeof version === 'string' && versionDirectory.test(version)))
      throw new Error('Invalid existing Terminal+ installation record.');
    const versions = join(root, 'versions'), versionsInfo = info(versions);
    const current = join(root, 'current'), currentInfo = info(current);
    const selected = join(versions, record.current), selectedInfo = info(selected);
    if (!versionsInfo?.isDirectory() || versionsInfo.isSymbolicLink() || versionsInfo.uid !== uid
      || !currentInfo?.isSymbolicLink() || currentInfo.uid !== uid || resolve(root, readlink(current)) !== selected
      || !selectedInfo?.isDirectory() || selectedInfo.isSymbolicLink() || selectedInfo.uid !== uid)
      throw new Error('The existing installation has an invalid current version.');
    const marker = json(join(selected, 'installed.json'), 65536, true);
    const release = json(join(selected, 'release.json'), 32 * 1024 * 1024, true);
    if (marker?.format !== 1 || release?.version !== record.version || release?.platform !== 'linux' || release?.arch !== arch
      || release?.buildId !== record.current.slice(record.version.length + 1)) throw new Error('The existing version metadata does not match its installation record.');
    for (const name of ['runtime', 'bin']) {
      const directory = info(join(selected, name));
      if (!directory?.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid)
        throw new Error('The existing installation has an invalid launcher/runtime directory.');
    }
    const nativeLauncher = info(join(selected, 'bin/terminal-plus')) ? 'bin/terminal-plus' : 'bin/even-pilot';
    for (const name of ['runtime/node', nativeLauncher]) {
      const executable = regularFile(join(selected, name), 1024 * 1024 * 1024, true);
      if (!executable.size || typeof executable.mode === 'number' && !(executable.mode & 0o111))
        throw new Error('The existing installation has a missing or unusable launcher/runtime.');
    }
    installedVersion = record.version;
    installedPayload = selected;
    installedRelease = release;
  } else if (nativeLinks.length || info(join(root, 'versions')) || info(join(root, 'current'))) {
    throw new Error('The existing installation is incomplete. Repair it with its Linux installer before running npm setup.');
  }
  const plan = installationPlan(metadata.version, installedVersion);
  if (plan.skip) {
    if (!nativeLinks.length) throw new Error('The native terminal-plus launcher is missing. Restore it with this installation\'s Linux installer before running npm setup.');
    if (!Array.isArray(installedRelease.files) || !installedRelease.files.length)
      throw new Error('The current release has no file manifest. Restore a verified Linux release before running npm setup.');
    const checkedDirectories = new Set([installedPayload]), declaredFiles = new Set();
    for (const file of installedRelease.files) {
      if (!file || typeof file.path !== 'string' || !file.path || isAbsolute(file.path)
        || /[\\\r\n\0]/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..')
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
        || declaredFiles.has(file.path)) throw new Error('The current release has an invalid file manifest. Restore a verified Linux release before running npm setup.');
      declaredFiles.add(file.path);
      const path = resolve(installedPayload, file.path);
      if (!path.startsWith(installedPayload + sep)) throw new Error('The current release manifest escapes its installed version.');
      let directoryPath = dirname(path);
      while (!checkedDirectories.has(directoryPath)) {
        const directory = info(directoryPath);
        if (!directory?.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid)
          throw new Error('The current release contains a missing or linked directory: ' + directoryPath);
        checkedDirectories.add(directoryPath);
        directoryPath = dirname(directoryPath);
      }
      const stat = regularFile(path, 1024 * 1024 * 1024, true);
      if (stat.size !== file.bytes || createHash('sha256').update(readFile(path)).digest('hex') !== file.sha256)
        throw new Error('Current installation verification failed: ' + file.path + '. Restore a verified Linux release before running npm setup.');
    }
    const nativeLauncher = info(join(installedPayload, 'bin/terminal-plus')) ? 'bin/terminal-plus' : 'bin/even-pilot';
    for (const required of ['runtime/node', nativeLauncher, 'apps/linux/src/desktop.ts', 'node_modules/tsx/dist/loader.mjs']) {
      if (!declaredFiles.has(required)) throw new Error('The current release manifest is missing a required runtime file: ' + required);
    }
    log(`Terminal+ ${installedVersion} is already installed. Keeping its current release and settings.\nLauncher: ${nativeLinks[0].launcher}`);
    return 0;
  }
  if (createHash('sha256').update(readFile(installer)).digest('hex') !== metadata.sha256)
    throw new Error('Bundled Linux installer checksum mismatch. Reinstall the npm package.');
  const result = spawn('sh', [installer, '--dir', root, plan.argument], { stdio: 'inherit', shell: false, env });
  if (result.error) throw new Error('Could not run the verified Linux installer: ' + result.error.message);
  if (result.status !== 0) return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
  log('Linux setup complete. Run terminal-plus to start the companion. If this shell cannot find it, open a new terminal.');
  return 0;
}

let invokedDirectly = false;
try { invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (invokedDirectly) {
  try { process.exitCode = runSetup(process.argv.slice(2)); }
  catch (error) { console.error('[Terminal+] ' + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
}
