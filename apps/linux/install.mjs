import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2), removing = args.includes('--uninstall'), updating = args.includes('--update');
if (updating && args.includes('--no-start')) throw new Error('--update requires starting the monitor for its health check; omit --no-start');
const binDirectory = process.env.EVEN_PILOT_BIN_DIR || join(homedir(), '.local/bin');
const bin = join(binDirectory, 'terminal-plus'), legacyBin = join(binDirectory, 'even-pilot');
const launcherNames = ['terminal-plus', 'even-pilot'];
function fileInfo(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
function launcherRoot(path) {
  const link = resolve(dirname(path), readlinkSync(path));
  return launcherNames.some(name => link.endsWith(sep + join('current', 'bin', name))) ? resolve(link, '../../..') : undefined;
}
let detected;
for (const path of [bin, legacyBin]) { try { detected = launcherRoot(path); if (detected) break; } catch {} }
const option = args.indexOf('--dir');
if (option >= 0 && !args[option + 1]) throw new Error('--dir needs a directory');
const root = resolve(option >= 0 ? args[option + 1] : process.env.EVEN_PILOT_INSTALL_DIR || detected || join(homedir(), '.local/lib/even-pilot'));
const recordPath = join(root, 'install.json');
const safeVersion = value => { if (!/^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(value || '')) throw new Error('Invalid installation version'); return value; };
const inside = (path, parent) => resolve(path).startsWith(resolve(parent) + sep);
function regularTree(path, parent) {
  if (!inside(path, parent)) throw new Error('Installation path escaped its root');
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error('Linked installation files are not supported');
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) regularTree(join(path, name), parent);
}
function guardRoot() {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Run this installer as your normal Linux user, without sudo');
  if (/[\r\n\0]/.test(root)) throw new Error('Installation path must not contain line breaks');
  if ([sep, homedir(), '/usr', '/opt', '/var', '/tmp'].includes(root)) throw new Error('Choose a dedicated Terminal+ directory');
  let path = root;
  while (path !== dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Installation parent must not be a symlink');
    path = dirname(path);
  }
  if (existsSync(root) && lstatSync(root).uid !== process.getuid()) throw new Error('Installation must be owned by the current user');
  for (const name of ['versions', 'install.json']) if (existsSync(join(root, name)) && lstatSync(join(root, name)).isSymbolicLink()) throw new Error('Linked installation records are not supported');
}
function invoke(payload, command) {
  const result = spawnSync(join(payload, 'runtime/node'), ['--import', pathToFileURL(join(payload, 'node_modules/tsx/dist/loader.mjs')).href, join(payload, 'apps/linux/src/desktop.ts'), ...command], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Could not complete ' + command[0] + '; no native terminal was killed');
}
function removeClaudeMonitoring(payload) {
  const monitorData = process.env.EVEN_PILOT_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'even-pilot');
  if (!existsSync(join(monitorData, 'claude-monitor-registration.json'))) return;
  const removeHook = join(payload, 'apps/windows/src/install-claude-monitor.ts');
  if (!existsSync(removeHook)) throw new Error('Claude monitoring cleanup is unavailable; reinstall the current package before uninstalling');
  const cleanup = spawnSync(join(payload, 'runtime/node'), ['--import', pathToFileURL(join(payload, 'node_modules/tsx/dist/loader.mjs')).href,
    removeHook, '--remove', '--data', monitorData], { env: process.env, cwd: payload, stdio: 'inherit', timeout: 20000 });
  if (cleanup.error || cleanup.status !== 0) throw new Error('Claude monitoring cleanup failed; application files and user settings were retained');
}
function verify(directory, manifest) {
  regularTree(directory, dirname(directory));
  for (const file of manifest.files) {
    const path = resolve(directory, file.path);
    if (!inside(path, directory) || !existsSync(path) || lstatSync(path).size !== file.bytes
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) throw new Error('Payload verification failed: ' + file.path);
  }
}
const desktopPath = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'applications/even-pilot.desktop');
const quoteDesktop = text => '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%') + '"';
function writeAtomic(path, value, mode = 0o600) { const temp = path + '.new-' + randomUUID(); writeFileSync(temp, value, { flag: 'wx', mode }); chmodSync(temp, mode); renameSync(temp, path); }

// Shell registration belongs to this installation only. Preserve all user text
// outside our exact marker, and never replace a symlink or a shared startup file.
const pathMarker = '# Terminal+ PATH: ' + JSON.stringify(root);
const pathEnd = '# End Terminal+ PATH';
const pathMarkers = [[pathMarker, pathEnd], ['# Even-Pilot PATH: ' + JSON.stringify(root), '# End Even-Pilot PATH']];
const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
function shellPathFiles() {
  const shell = basename(process.env.SHELL || userInfo().shell || '');
  if (shell === 'bash') {
    const login = ['.bash_profile', '.bash_login', '.profile'].map(name => join(homedir(), name)).find(existsSync) || join(homedir(), '.profile');
    // Bash reads .bashrc for SSH commands too. Ubuntu's standard noninteractive
    // return must not prevent resolving the installed command in that case.
    return [{ path: login }, { path: join(homedir(), '.bashrc'), prepend: true }];
  }
  if (shell === 'zsh') {
    const directory = process.env.ZDOTDIR || homedir();
    return ['.zprofile', '.zshrc'].map(name => ({ path: join(directory, name) }));
  }
  if (['sh', 'dash', 'ksh', 'ash'].includes(shell)) return [{ path: join(homedir(), '.profile') }];
  if (shell === 'fish') return [{ path: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fish/conf.d/even-pilot-path.fish'), fish: true }];
  return [];
}
function registerShellPath(removing = false) {
  const directory = dirname(bin), files = shellPathFiles();
  let saved = false;
  for (const file of files) {
    try {
      let original = '', mode = 0o600, info;
      try { info = lstatSync(file.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info) {
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('not a regular owned file');
        original = readFileSync(file.path, 'utf8'); mode = info.mode & 0o777;
      } else if (removing) continue;
      let clean = original;
      let managed = false;
      for (const [beginMarker, endMarker] of pathMarkers) {
        for (let begin = clean.indexOf(beginMarker + '\n'); begin >= 0; begin = clean.indexOf(beginMarker + '\n')) {
          const end = clean.indexOf(endMarker + '\n', begin);
          if (end < 0) throw new Error('incomplete managed block');
          clean = clean.slice(0, begin) + clean.slice(end + endMarker.length + 1);
          managed = true;
        }
      }
      if (removing) {
        if (clean !== original) writeAtomic(file.path, clean, mode);
        continue;
      }
      const value = shellQuote(directory);
      const block = file.fish ? `if not contains -- ${value} $PATH\n    set -gx PATH ${value} $PATH\nend\n`
        : `case ":$PATH:" in\n  *:${value}:*) ;;\n  *) export PATH=${value}:"$PATH" ;;\nesac\n`;
      // Avoid appending our block to a fish file owned by another application.
      if (file.fish && original && !managed) throw new Error('unrelated fish startup entry');
      mkdirSync(dirname(file.path), { recursive: true });
      const registration = pathMarker + '\n' + block + pathEnd + '\n';
      writeAtomic(file.path, file.prepend ? registration + clean : clean + (clean && !clean.endsWith('\n') ? '\n' : '') + registration, mode);
      saved = true;
    } catch {
      console.warn('Shell PATH was not changed in ' + file.path + '. Add ' + directory + ' to your PATH manually.');
    }
  }
  if (!removing) console.log(saved ? 'The terminal-plus command is available in new terminal windows. Current shell: add ' + directory + ' to PATH, or use the full launcher path below.'
    : 'Add ' + directory + ' to your shell PATH to use the terminal-plus command.');
}

guardRoot();
mkdirSync(root, { recursive: true, mode: 0o700 });
const lock = join(root, '.installer-lock');
try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('Another installer may be using this folder. Check it before removing .installer-lock'); }
let temporary;
try {
  const previous = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : { versions: [] };
  for (const name of previous.versions) safeVersion(name);
  if (previous.current) safeVersion(previous.current);
  const old = previous.current ? join(root, 'versions', previous.current) : undefined;
  if (removing) {
    if (!old) throw new Error('No installed Terminal+ found');
    invoke(old, ['uninstall-check']);
    // Reject all living consumers of an installed version, including idle PTY
    // wrappers whose MCP channel has not connected yet. Only inspect our uid.
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      if (Number(pid) === process.pid || Number(pid) === process.ppid) continue;
      let cmd = '';
      try { if (lstatSync('/proc/' + pid).uid === process.getuid()) cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8'); } catch {}
      if (cmd.includes(root + '/versions/') && !cmd.includes('/apps/windows/src/cli.ts')) throw new Error('A terminal still uses this installation. Close it before uninstalling');
    }
    invoke(old, ['remove-service']);
    removeClaudeMonitoring(old);
    const pi = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'extensions/even-pilot-monitor.ts');
    if (existsSync(pi)) {
      const text = readFileSync(pi, 'utf8');
      if (['// Terminal+ native terminal monitor\n', '// Even-PIlot native terminal monitor\n'].some(marker => text.startsWith(marker)) && text.includes(root + '/versions/')) unlinkSync(pi);
    }
    for (const path of [bin, legacyBin]) { try { if (launcherRoot(path) === root && lstatSync(path).uid === process.getuid()) unlinkSync(path); } catch {} }
    registerShellPath(true);
    try { if (readFileSync(desktopPath, 'utf8').includes('X-Even-PIlot-Root=' + root + '\n')) unlinkSync(desktopPath); } catch {}
    if (existsSync(join(root, 'current'))) {
      if (!lstatSync(join(root, 'current')).isSymbolicLink() || !inside(resolve(root, readlinkSync(join(root, 'current'))), join(root, 'versions'))) throw new Error('Unexpected current-version link');
      unlinkSync(join(root, 'current'));
    }
    for (const version of previous.versions) {
      const path = join(root, 'versions', version); regularTree(path, root); rmSync(path, { recursive: true, force: true });
    }
    unlinkSync(recordPath);
    console.log('Terminal+ uninstalled. Connection keys and watch settings retained.');
  } else {
    const manifest = JSON.parse(readFileSync(join(source, 'release.json'), 'utf8'));
    if (manifest.platform !== 'linux' || manifest.arch !== process.arch) throw new Error('Use the package for this Linux CPU architecture');
    const version = safeVersion(manifest.version + '-' + manifest.buildId), target = join(root, 'versions', version);
    // Preflight shortcuts before stopping a working monitoring service.
    for (const path of [bin, legacyBin]) {
      const stat = fileInfo(path);
      if (stat && (!stat.isSymbolicLink() || stat.uid !== process.getuid() || launcherRoot(path) !== root)) throw new Error('Another executable occupies ' + path);
    }
    if (existsSync(desktopPath) && !readFileSync(desktopPath, 'utf8').includes('X-Even-PIlot-Root=' + root + '\n')) throw new Error('An unrelated desktop shortcut already exists');
    verify(source, manifest);
    if (existsSync(target)) verify(target, manifest);
    else {
      temporary = join(root, '.install-' + randomUUID());
      cpSync(source, temporary, { recursive: true, dereference: false }); verify(temporary, manifest);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); renameSync(temporary, target); temporary = undefined;
    }
    writeAtomic(join(target, 'installed.json'), '{"format":1}\n');
    chmodSync(join(target, 'runtime/node'), 0o755);
    for (const name of launcherNames) chmodSync(join(target, 'bin', name), 0o755);
    // The monitor handles its own authenticated shutdown; native sessions and
    // the versions they loaded remain present across the upgrade.
    const oldRecord = existsSync(recordPath) ? readFileSync(recordPath) : undefined;
    const hadPrimaryLauncher = Boolean(fileInfo(bin));
    const oldDesktop = existsSync(desktopPath) ? readFileSync(desktopPath) : undefined;
    const autoPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart/even-pilot.desktop');
    const oldAutostart = existsSync(autoPath) ? readFileSync(autoPath) : undefined;
    let switched = false;
    invoke(old || target, ['stop']);
    try {
      invoke(target, ['prepare']);
      const pending = join(root, '.current-' + randomUUID()); symlinkSync('versions/' + version, pending); renameSync(pending, join(root, 'current'));
      switched = true;
      writeAtomic(recordPath, JSON.stringify({ version: manifest.version, current: version, versions: [...new Set([...previous.versions, version])] }) + '\n');
      mkdirSync(dirname(bin), { recursive: true }); if (!fileInfo(bin)) symlinkSync(join(root, 'current/bin/terminal-plus'), bin);
      mkdirSync(dirname(desktopPath), { recursive: true });
      writeAtomic(desktopPath, `[Desktop Entry]\nType=Application\nName=Terminal+\nComment=Monitor Pi, Codex and Claude sessions\nExec=${quoteDesktop(join(root, 'current/bin/terminal-plus'))} open\nIcon=${join(root, 'current/assets/icon.svg')}\nTerminal=false\nCategories=Development;\nX-Even-PIlot-Root=${root}\n`, 0o644);
      if (!args.includes('--no-start')) invoke(target, [updating ? 'start' : 'open']);
      if (updating) {
        const data = process.env.EVEN_PILOT_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'even-pilot');
        const config = JSON.parse(readFileSync(join(data, 'bridge-config.json'), 'utf8'));
        const response = await fetch('http://127.0.0.1:' + (process.env.EVEN_PILOT_PORT || 4317) + '/api/updates', {
          headers: {Authorization: 'Bearer ' + (process.env.EVEN_PILOT_TOKEN || config.controlToken)}, signal: AbortSignal.timeout(5000) });
        if (!response.ok || (await response.json()).currentVersion !== manifest.version) throw new Error('Updated backend health check failed');
      }
      registerShellPath();
      console.log('Installed Terminal+ ' + manifest.version + '\nLauncher: ' + bin + '\nEnable login startup: ' + bin + ' autostart on\nShow phone connection values: ' + bin + ' pair');
    } catch (error) {
      let cleanupError;
      if (old) {
        if (switched) {
          invoke(target, ['stop']);
          const pending = join(root, '.rollback-' + randomUUID()); symlinkSync('versions/' + previous.current, pending); renameSync(pending, join(root, 'current'));
          writeAtomic(recordPath, oldRecord);
          if (!hadPrimaryLauncher && fileInfo(bin) && launcherRoot(bin) === root) unlinkSync(bin);
          if (oldDesktop) writeAtomic(desktopPath, oldDesktop, 0o644);
          else if (existsSync(desktopPath)) unlinkSync(desktopPath);
          if (oldAutostart?.toString('utf8').includes('X-Even-PIlot=true')) writeAtomic(autoPath, oldAutostart);
        }
        if (!existsSync(join(old, 'apps/windows/src/install-claude-monitor.ts'))) {
          try { removeClaudeMonitoring(target); } catch (failure) { cleanupError = failure; }
        }
        invoke(old, ['prepare']);
        if (!args.includes('--no-start')) invoke(old, ['start']);
      } else {
        removeClaudeMonitoring(target);
      }
      if (cleanupError) throw new Error('Previous monitor restored, but Claude monitoring settings need repair before removing the new payload', { cause: cleanupError });
      throw error;
    }
  }
} finally {
  if (temporary) { regularTree(temporary, root); rmSync(temporary, { recursive: true }); }
  rmdirSync(lock);
}
