import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareRuntime, inventory as runtimeInventory, buildInstaller } from './installer.mjs';
import { packHub } from './package-hub.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32') throw new Error('Build the Windows release on Windows.');
if (!readFileSync(join(root, 'apps/windows/desktop/Tray.cs'), 'utf8').includes(`AssemblyFileVersion("${pkg.version}.0")`))
  throw new Error('EXE file version differs from package version.');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Use npm run release:build.');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Release build command failed.');
}
run(process.execPath, [npm, 'run', 'build']);
run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'apps/windows/desktop/build.ps1'), '-Stage']);

const releases = join(root, 'outputs/releases');
mkdirSync(releases, { recursive: true });
// A fresh staging directory prevents leftover files from a previous build leaking.
const destination = mkdtempSync(join(releases, pkg.version + '-'));
const stage = join(destination, 'Terminal-plus');
mkdirSync(stage);
const allowlist = [
  'README.md', 'README.zh-CN.md', 'RELEASE_NOTES.md', 'Setup.cmd', 'apps/windows/src', 'apps/linux/src/platform.ts',
  'apps/windows/desktop/Terminal-plus.TerminalInterrupt.exe',
  'apps/evenhub/dist', 'apps/evenhub/app.json', 'apps/evenhub/THIRD_PARTY_NOTICES.md', 'packages',
  'scripts/enable-pi-subagents.ps1',
  'docs/architecture.md', 'docs/connectors.md', 'docs/linux.md', 'docs/glance-push.md', 'docs/glance-qr-v1.md', 'docs/hub-release-notes.md',
  'docs/g2-output-contract.md', 'docs/pi-extensions.md', 'docs/voice.md', 'docs/release-status.md', 'docs/README.md', 'docs/api.md', 'docs/development.md', 'docs/notification-routing.md', 'docs/updates.md', 'docs/publishing.md', 'docs/even-hub-description.md',
  'docs/setup.md', 'docs/setup.zh-CN.md', 'docs/agent-runbook.md',
];
const secretValues = [];
const configPath = join(root, '.local/bridge-config.json');
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const key of ['controlToken', 'notificationToken']) if (typeof config[key] === 'string' && config[key].length >= 24) secretValues.push(config[key]);
}
function walk(path) {
  if (relative(root, path).split(/[\\/]/).some(part => ['.local', '.git', 'node_modules', 'outputs'].includes(part)
    || /^\.env(?:\.|$)/.test(part) || /firebase.*\.json$/i.test(part))) throw new Error('Private path in release input: ' + relative(root, path));
  if (lstatSync(path).isSymbolicLink()) throw new Error('Release input contains a symlink: ' + relative(root, path));
  return lstatSync(path).isDirectory() ? readdirSync(path).sort().flatMap(name => walk(join(path, name))) : [path];
}
function copy(source, target, content) {
  const bytes = content === undefined ? readFileSync(source) : Buffer.from(content), text = bytes.toString('utf8');
  if (secretValues.some(secret => text.includes(secret)) || /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(text)
    || /"type"\s*:\s*"service_account"/.test(text)) throw new Error('Private data found in release input: ' + relative(root, source));
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, bytes);
}
for (const entry of allowlist) for (const source of walk(join(root, entry))) copy(source, join(stage, relative(root, source)));
// The installation is a runtime distribution, not a development checkout.
const runtimePackage = { ...pkg, scripts: Object.fromEntries(Object.entries(pkg.scripts).filter(([key]) =>
  ['start', 'terminal:codex', 'terminal:claude', 'pair', 'push'].includes(key))) };
delete runtimePackage.devDependencies;
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
delete lock.packages[''].devDependencies;
for (const [path, entry] of Object.entries(lock.packages)) if (entry.dev === true) delete lock.packages[path];
copy(join(root, 'package.json'), join(stage, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n');
copy(join(root, 'package-lock.json'), join(stage, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
copy(join(root, 'Terminal-plus.updated.exe'), join(stage, 'Terminal-plus.exe'));
// Old portable launchers delegate to this filename after an installed payload switch.
// Keep a byte-identical alias so their existing entry point works without replacing a live EXE.
copy(join(root, 'Terminal-plus.updated.exe'), join(stage, 'Even-Pilot.exe'));
await prepareRuntime(root, stage, npm);
const finalFiles = runtimeInventory(stage, secretValues);
const { installer, buildId } = buildInstaller(root, stage, destination, pkg.version, finalFiles);
writeFileSync(join(destination, 'inventory.json'), JSON.stringify({ version: pkg.version, buildId, files: finalFiles }, null, 2) + '\n');

// Desktop runtime stays in dist; the Hub package excludes desktop-only assets.
run(process.execPath, [npm, "run", "build:hub"]);
for (const source of walk(join(root, "apps/evenhub/dist-hub"))) copy(source, join(destination, "hub", relative(join(root, "apps/evenhub/dist-hub"), source)));
const hub = packHub(destination, join(destination, 'hub'));
const zip = join(destination, `Terminal-plus-${pkg.version}-windows.zip`);
const literal = value => "'" + value.replaceAll("'", "''") + "'";
run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath ${literal(stage)} -DestinationPath ${literal(zip)} -CompressionLevel Optimal`]);
const artifacts = [installer, zip, hub, join(destination, 'inventory.json')];
writeFileSync(join(destination, 'SHA256SUMS.txt'), artifacts.map(path => createHash('sha256').update(readFileSync(path)).digest('hex') + '  ' + relative(destination, path)).join('\n') + '\n');
console.log('Release candidates: ' + destination);
