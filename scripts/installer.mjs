import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Installer build command failed.');
}
const literal = text => "'" + text.replaceAll("'", "''") + "'";
export function compile(root, output, resources = []) {
  const desktop = join(root, 'apps/windows/desktop');
  const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const icon = join(desktop, 'assets/Terminal-plus.ico');
  run(compiler, ['/nologo','/target:winexe','/platform:x64','/optimize+', '/out:' + output, '/win32icon:' + icon,
    '/win32manifest:' + join(desktop,'installer.manifest'),
    '/resource:' + icon + ',Terminal-plus.ico', ...resources.map(([path, name]) => '/resource:' + path + ',' + name),
    ...['System.Windows.Forms','System.Drawing','System.Net.Http','System.Web.Extensions','System.IO.Compression','System.Core','Microsoft.CSharp'].map(name => '/reference:' + name + '.dll'),
    ...['Installer.cs','InstallerSupport.cs','DesktopPaths.cs','StartupRegistration.cs'].map(name => join(desktop, name))], root);
}
export async function prepareRuntime(root, stage, npm) {
  if (process.arch !== 'x64') throw new Error('Build this release with Windows x64 Node.js.');
  const version = process.versions.node;
  const cache = join(root, 'outputs/toolchain'); mkdirSync(cache, { recursive: true });
  const acquire = async (url, destination) => {
    if (!existsSync(destination)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error('Could not obtain the official Node.js license/checksum.');
      writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    }
  };
  const sums = join(cache, `node-v${version}-SHASUMS256.txt`), license = join(cache, `node-v${version}-LICENSE.txt`);
  await acquire(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, sums);
  await acquire(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`, license);
  const expected = readFileSync(sums, 'utf8').split(/\r?\n/).find(line => /\swin-x64\/node\.exe$/.test(line))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  if (!expected || actual !== expected) throw new Error('The build Node.js binary does not match its official release checksum.');
  const runtime = join(stage, 'runtime'); mkdirSync(runtime);
  copyFileSync(process.execPath, join(runtime, 'node.exe')); copyFileSync(license, join(runtime, 'LICENSE.txt'));
  writeFileSync(join(runtime, 'version.json'), JSON.stringify({ version, arch: 'x64', sha256: actual }) + '\n');
  // A clean install from the locked production graph: never copy a developer's node_modules.
  run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
  compile(root, join(stage, 'Uninstall.exe'));
}
export function inventory(stage, secrets) {
  const paths = directory => readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Linked file in installer payload.');
    return entry.isDirectory() ? paths(path) : [path];
  });
  return paths(stage).map(path => {
    const bytes = readFileSync(path), text = bytes.toString('utf8');
    if (secrets.some(secret => text.includes(secret)) || /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}/.test(text))
      throw new Error('Private data in installer payload: ' + relative(stage,path));
    return { path: relative(stage,path).replaceAll('\\','/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}
export function buildInstaller(root, stage, destination, version, files) {
  const build = join(destination, '.packaging'); mkdirSync(build);
  const payload = join(build, 'payload.zip');
  run('powershell.exe', ['-NoProfile','-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(' + literal(stage) + ',' + literal(payload) + ')'], root);
  const buildId = createHash('sha256').update(readFileSync(payload)).digest('hex').slice(0,12);
  const metadata = join(build, 'release.json');
  writeFileSync(metadata, JSON.stringify({ version, buildId, files }));
  const installer = join(destination, `Terminal-plus-${version}-Setup-x64.exe`);
  compile(root, installer, [[payload,'payload.zip'],[metadata,'release.json']]);
  if (statSync(installer).size < statSync(payload).size) throw new Error('Installer payload missing.');
  return { installer, buildId };
}
