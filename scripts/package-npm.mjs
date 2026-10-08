import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// npm is an installation channel. The development project stays private and the
// native install remains outside npm so upgrades preserve running CLI sessions.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const input = process.argv[2];
if (!input || process.argv.length !== 3) throw new Error('Usage: npm run release:npm -- /path/to/verified-linux-x64.run');
const installer = resolve(input);
const name = `Terminal-plus-${source.version}-Setup-linux-x64.run`;
if (basename(installer) !== name || !existsSync(installer) || !lstatSync(installer).isFile() || lstatSync(installer).isSymbolicLink()) {
  throw new Error('Expected the regular Linux x64 installer for the current version');
}
const bytes = readFileSync(installer);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sums = readFileSync(join(dirname(installer), 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/);
if (!sums.some(line => line === `${sha256}  ${name}`)) throw new Error('Linux installer does not match SHA256SUMS.txt');
const output = mkdtempSync(join(root, 'outputs/npm-' + source.version + '-'));
const stage = join(output, 'stage');
mkdirSync(join(stage, 'bin'), { recursive: true });
mkdirSync(join(stage, 'artifacts'));
copyFileSync(installer, join(stage, 'artifacts', name));
copyFileSync(join(root, 'apps/npm/bin/terminal-plus-setup.mjs'), join(stage, 'bin/terminal-plus-setup.mjs'));
chmodSync(join(stage, 'bin/terminal-plus-setup.mjs'), 0o755);
copyFileSync(join(root, 'apps/npm/README.md'), join(stage, 'README.md'));
writeFileSync(join(stage, 'payload.json'), JSON.stringify({ version: source.version, arch: 'x64', installer: 'artifacts/' + name, sha256 }, null, 2) + '\n');
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: 'terminal-plus', version: source.version,
  description: 'Linux companion for monitoring Pi, Codex and Claude sessions, with access through Even Hub and G2.',
  type: 'module', license: 'UNLICENSED', engines: { node: '>=22' }, os: ['linux'], cpu: ['x64'],
  bin: { 'terminal-plus-setup': 'bin/terminal-plus-setup.mjs' },
  scripts: { postinstall: 'node bin/terminal-plus-setup.mjs --postinstall' },
  files: ['bin/terminal-plus-setup.mjs', 'payload.json', 'artifacts/' + name, 'README.md'],
  repository: source.repository, homepage: source.homepage,
  bugs: { url: source.homepage + '/issues' },
  keywords: ['even-realities', 'g2', 'pi', 'codex', 'claude', 'session-monitor', 'linux'],
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
}, null, 2) + '\n');
if (!process.env.npm_execpath) throw new Error('Run through npm run release:npm to use the configured npm CLI');
const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', stage, '--ignore-scripts', '--json', '--pack-destination', output], { encoding: 'utf8', windowsHide: true });
if (packed.error || packed.status !== 0) throw new Error('npm pack failed: ' + (packed.stderr || packed.error?.message));
const result = JSON.parse(packed.stdout);
const items = Array.isArray(result) ? result : Object.values(result);
const info = items.length === 1 ? items[0] : undefined;
if (!info?.files) throw new Error('Unexpected npm pack response: ' + packed.stdout);
const expected = ['README.md', 'artifacts/' + name, 'bin/terminal-plus-setup.mjs', 'package.json', 'payload.json'].sort();
if (JSON.stringify(info.files.map(file => file.path).sort()) !== JSON.stringify(expected)) throw new Error('Unexpected npm package files');
console.log(JSON.stringify({ package: join(output, info.filename), size: info.size, unpackedSize: info.unpackedSize, integrity: info.integrity, files: expected }, null, 2));
