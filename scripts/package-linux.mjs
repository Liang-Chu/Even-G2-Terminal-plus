import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Build on Linux x64 or arm64');
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
const destination = mkdtempSync(join(root, 'outputs/linux-' + pkg.version + '-'));
const stage = join(destination, 'Terminal-plus'); mkdirSync(stage);
const run = (cmd, args, cwd = stage) => { const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' }); if (result.error || result.status) throw new Error('Linux packaging step failed'); };
const sources = ['README.md', 'README.zh-CN.md', 'RELEASE_NOTES.md', 'docs', 'apps/windows/src', 'apps/linux', 'packages', 'apps/evenhub/dist', 'apps/evenhub/THIRD_PARTY_NOTICES.md', 'assets/icon.svg', 'scripts/enable-pi-subagents.mjs'];
for (const entry of sources) {
  if (!existsSync(join(root, entry))) throw new Error('Missing release input: ' + entry);
  cpSync(join(root, entry), join(stage, entry), { recursive: true });
}
const runtimePackage = { ...pkg, scripts: {} }; delete runtimePackage.devDependencies;
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'))); delete lock.packages[''].devDependencies;
for (const [name, value] of Object.entries(lock.packages)) if (value.dev) delete lock.packages[name];
writeFileSync(join(stage, 'package.json'), JSON.stringify(runtimePackage, null, 2)); writeFileSync(join(stage, 'package-lock.json'), JSON.stringify(lock, null, 2));
run(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
const version = process.versions.node;
const cache = join(root, 'outputs/toolchain'); mkdirSync(cache, { recursive: true });
const fetchText = async url => { const response = await fetch(url); if (!response.ok) throw new Error('Official Node metadata unavailable'); return response.text(); };
const archiveName = `node-v${version}-linux-${process.arch}.tar.xz`;
const archive = join(cache, archiveName);
if (!existsSync(archive)) throw new Error('Place the verified official build Node archive at ' + archive);
const sums = await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
const expected = sums.split('\n').find(line => line.endsWith('  ' + archiveName))?.split(' ')[0];
if (!expected || expected !== createHash('sha256').update(readFileSync(archive)).digest('hex')) throw new Error('Node archive checksum mismatch');
// Compare the executing binary to a fresh extraction, not merely to a cached archive.
const verified = join(destination, 'verified-node'); mkdirSync(verified); run('tar', ['-xJf', archive, '-C', verified]);
const original = join(verified, `node-v${version}-linux-${process.arch}`, 'bin/node');
if (!readFileSync(original).equals(readFileSync(process.execPath))) throw new Error('Build Node differs from the official binary');
mkdirSync(join(stage, 'runtime')); copyFileSync(original, join(stage, 'runtime/node'));
copyFileSync(join(verified, `node-v${version}-linux-${process.arch}`, 'LICENSE'), join(stage, 'runtime/LICENSE.txt'));
mkdirSync(join(stage, 'bin'));
for (const name of ['terminal-plus', 'even-pilot']) {
  copyFileSync(join(root, 'apps/linux/bin', name), join(stage, 'bin', name)); chmodSync(join(stage, 'bin', name), 0o755);
}
chmodSync(join(stage, 'runtime/node'), 0o755);
const walk = path => { if (lstatSync(path).isSymbolicLink()) throw new Error('Symlink in payload: ' + path); return lstatSync(path).isDirectory() ? readdirSync(path).sort().flatMap(name => walk(join(path, name))) : [path]; };
// npm creates .bin symlinks; these aren't needed by the runtime's absolute entry points.
// Omit them at package creation instead of dereferencing or shipping external links.
const allFiles = path => readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
  if (entry.name === '.bin') return [];
  const target = join(path, entry.name); return entry.isDirectory() ? allFiles(target) : walk(target);
});
const files = allFiles(stage).map(path => {
  const bytes = readFileSync(path), text = bytes.toString('utf8'), name = relative(stage, path);
  if (name.split('/').some(part => ['.local', '.git', 'outputs', 'tests'].includes(part)) || /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}/.test(text)) throw new Error('Private/unexpected payload input');
  return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const buildId = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
writeFileSync(join(stage, 'release.json'), JSON.stringify({ version: pkg.version, platform: 'linux', arch: process.arch, buildId, files }));
const fileList = join(destination, 'payload-files.txt'); writeFileSync(fileList, files.map(file => file.path).concat('release.json').join('\n') + '\n');
const archiveOut = join(destination, `Terminal-plus-${pkg.version}-linux-${process.arch}.tar.gz`);
run('tar', ['-czf', archiveOut, '--no-recursion', '-T', fileList]);
const bytes = readFileSync(archiveOut), hash = createHash('sha256').update(bytes).digest('hex');
const shell = `#!/bin/sh\nset -eu\numask 077\n[ "$(uname -s)" = Linux ] || { echo 'This installer requires Linux'; exit 1; }\n[ "$(uname -m)" = '${process.arch === 'x64' ? 'x86_64' : 'aarch64'}' ] || { echo 'Wrong CPU architecture'; exit 1; }\ntmp=$(mktemp -d "\${TMPDIR:-/tmp}/even-pilot-setup.XXXXXXXX")\ncleanup() { case "$tmp" in "\${TMPDIR:-/tmp}"/even-pilot-setup.*) rm -rf -- "$tmp" ;; esac; }\ntrap cleanup EXIT HUP INT TERM\ntail -n +PAYLOAD_LINE "$0" > "$tmp/payload.tar.gz"\nprintf '%s  %s\\n' '${hash}' "$tmp/payload.tar.gz" | sha256sum -c - >/dev/null\nmkdir "$tmp/app"\ntar -xzf "$tmp/payload.tar.gz" -C "$tmp/app"\n"$tmp/app/runtime/node" "$tmp/app/apps/linux/install.mjs" "$@"\nexit 0\n`;
const prefix = shell.replace('PAYLOAD_LINE', String(shell.split('\n').length));
const setup = join(destination, `Terminal-plus-${pkg.version}-Setup-linux-${process.arch}.run`);
writeFileSync(setup, Buffer.concat([Buffer.from(prefix), bytes])); chmodSync(setup, 0o755);
writeFileSync(join(destination, 'SHA256SUMS.txt'), [archiveOut, setup].map(path => createHash('sha256').update(readFileSync(path)).digest('hex') + '  ' + relative(destination, path)).join('\n') + '\n');
console.log('Linux release: ' + destination);
