import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

export function packHub(destination = root, project = join(root, 'apps/evenhub/dist-hub')) {
  const manifestPath = join(root, 'apps/evenhub/app.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (/even/i.test(manifest.name) || /even/i.test(manifest.package_id))
    throw new Error('Hub name and package ID must not contain the reserved word even.');
  const output = join(destination, `terminal-plus-${manifest.version}.ehpk`);
  const result = spawnSync(process.execPath, [
    join(root, 'node_modules/@evenrealities/evenhub-cli/main.js'), 'pack', manifestPath,
    project, '-o', output, '--sdk-ver', manifest.min_sdk_version,
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Hub packaging failed.');
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packHub();
