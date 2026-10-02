// Install the matching official example without adding delegation rules or keys.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { resolvePi } from '../packages/pi-runtime/resolve-pi.js';

const pi = resolvePi();
const output = execFileSync(pi.command, [...pi.args, '--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
const version = /^(?:pi(?: version)?\s+)?(\d+\.\d+\.\d+)$/m.exec(output)?.[1];
if (!version || version.split('.').map(Number).reduce((value, n) => value * 1000 + n, 0) < 87001) throw new Error('Official Pi 0.87.1 or later is required');
const directory = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
const fetchText = async url => { const response = await fetch(url, { headers: { 'User-Agent': 'Even-Pilot-subagent-installer/1' }, signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error('Could not download official Pi source: HTTP ' + response.status); return response.text(); };
const commit = JSON.parse(await fetchText('https://api.github.com/repos/earendil-works/pi/commits/v' + version)).sha;
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid official release commit');
const base = 'https://raw.githubusercontent.com/earendil-works/pi/' + commit + '/packages/coding-agent/';
const pkg = JSON.parse(await fetchText(base + 'package.json'));
if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== version) throw new Error('Official source/version mismatch');
const paths = [['index.ts', 'extensions/subagent/index.ts'], ['agents.ts', 'extensions/subagent/agents.ts'],
  ...['scout','planner','reviewer','worker'].map(name => ['agents/' + name + '.md', 'agents/' + name + '.md']),
  ...['implement','scout-and-plan','implement-and-review'].map(name => ['prompts/' + name + '.md', 'prompts/' + name + '.md'])];
const prepared = [];
for (const [input, output] of paths) {
  let text = await fetchText(base + 'examples/extensions/subagent/' + input);
  if (!text.trim()) throw new Error('Empty official source');
  if (input.startsWith('agents/')) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/.exec(text);
    if (!front) throw new Error('Missing agent frontmatter');
    text = '---\n' + front[1].replace(/^model:[^\r\n]*(?:\r?\n|$)/gm, '').trimEnd() + '\n---' + front[2];
  }
  const path = join(directory, output), exists = existsSync(path);
  if (exists && readFileSync(path, 'utf8').replaceAll('\r\n', '\n') !== text.replaceAll('\r\n', '\n')) throw new Error('Existing file differs; nothing changed: ' + path);
  prepared.push({ path, text, exists });
}
for (const file of prepared) if (!file.exists) { mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.path, file.text, { flag: 'wx' }); }
console.log('Installed the official Pi ' + version + ' subagent example at commit ' + commit + '.\nAgents inherit your current model. Enter /reload in an idle Pi terminal.');
