// Terminal+ Claude monitor hook. Owns no CLI control and never returns a decision.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopHookTrust } from './claude-hook-trust.mjs';

export const monitorHookEvents = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStart',
  'SubagentStop', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = (value, limit) => typeof value === 'string' && !value.includes('\0')
  ? Buffer.from(value).subarray(0, limit).toString('utf8').replace(/\uFFFD$/, '') : undefined;
const metadata = (value, limit = 512) => typeof value === 'string' && value.length <= limit
  && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;

/** Never retain hook inputs such as tool arguments, credentials or shell commands. */
export function sanitizeClaudeHook(input, at = Date.now(), eventId = randomUUID()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !monitorHookEvents.includes(input.hook_event_name)
    || typeof input.session_id !== 'string' || !uuid.test(input.session_id)
    || !metadata(input.transcript_path, 4096) || !metadata(input.cwd, 4096)) return;
  const event = { version: 1, eventId, at, hook_event_name: input.hook_event_name,
    session_id: input.session_id.toLowerCase(), transcript_path: input.transcript_path, cwd: input.cwd };
  for (const [key, limit] of [['model', 256], ['session_title', 512], ['agent_id', 256], ['agent_type', 256], ['tool_name', 256],
    ['tool_use_id', 256], ['source', 128], ['reason', 128], ['error', 128]]) {
    const value = metadata(input[key], limit); if (value !== undefined) event[key] = value;
  }
  if (typeof input.stop_hook_active === 'boolean') event.stop_hook_active = input.stop_hook_active;
  // These are conversation text, intentionally bounded independently of raw input size.
  for (const key of ['prompt', 'last_assistant_message']) {
    const value = text(input[key], 32_000); if (value !== undefined) event[key] = value;
  }
  if (Object.hasOwn(input, 'background_tasks')) {
    event.background_tasks = Array.isArray(input.background_tasks) ? input.background_tasks.slice(0, 128).map(row => {
      const task = {};
      for (const [key, limit] of [['id', 256], ['type', 128], ['status', 128]]) {
        const value = metadata(row?.[key], limit); if (value !== undefined) task[key] = value;
      }
      return task;
    }) : [{ id: 'unknown:registry' }];
    if (input.background_tasks?.length > 128) event.background_tasks.push({ id: 'unknown:overflow' });
  }
  if (Object.hasOwn(input, 'session_crons')) {
    event.session_crons = Array.isArray(input.session_crons) ? input.session_crons.slice(0, 128).map(row => {
      const cron = {}, id = metadata(row?.id, 256); if (id !== undefined) cron.id = id;
      if (typeof row?.recurring === 'boolean') cron.recurring = row.recurring;
      return cron;
    }) : [{ id: 'unknown:registry' }];
    if (input.session_crons?.length > 128) event.session_crons.push({ id: 'unknown:overflow' });
  }
  return event;
}

/** Parse Linux stat after the final ')' because comm itself may contain spaces. */
export function linuxProcessRecord(pid, procRoot = '/proc', uid = process.getuid?.()) {
  try {
    const root = join(procRoot, String(pid));
    if (!Number.isSafeInteger(pid) || pid <= 0 || statSync(root).uid !== uid) return;
    const value = readFileSync(join(root, 'stat'), 'utf8'), end = value.lastIndexOf(') ');
    if (end < 0 || value.slice(0, value.indexOf(' ')) !== String(pid)) return;
    const fields = value.slice(end + 2).trim().split(/\s+/), started = fields[19], parent = Number(fields[1]);
    if (!/^\d+$/.test(started) || !Number.isSafeInteger(parent) || parent < 0) return;
    const comm = value.slice(value.indexOf('(') + 1, end), args = readFileSync(join(root, 'cmdline'));
    if (args.length > 65_536) return;
    const argv = args.toString('utf8').split('\0').filter(Boolean), first = basename(argv[0] || '');
    const native = /^claude(?:\.exe)?$/i.test(comm) && (/^claude(?:\.exe)?$/i.test(first)
      || /[\\/]\.local[\\/]share[\\/]claude[\\/]versions[\\/][\w.+-]+$/.test(argv[0] || ''));
    const node = /^node(?:js|\.exe)?$/i.test(first)
      && argv.slice(1, 5).some(arg => /(?:^|[\\/])@anthropic-ai[\\/]claude-code[\\/](?:cli\.js|cli\.mjs)$/.test(arg));
    return { pid, parent, started, claude: native || node };
  } catch { return; }
}

/** Only an actual ancestor with a matching user and immutable start identity qualifies. */
export async function discoverClaudeOwner(options = {}) {
  const platform = options.platform || process.platform, parentPid = options.parentPid || process.ppid;
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return;
  if (platform === 'linux') {
    const record = options.record || (pid => linuxProcessRecord(pid)), seen = new Set();
    let pid = parentPid, latest;
    for (let depth = 0; depth < 24 && pid > 0 && !seen.has(pid); depth++) {
      seen.add(pid); const row = record(pid); if (!row) return;
      if (!/^\d+$/.test(row.started) || (latest !== undefined && BigInt(row.started) > latest)) return;
      latest = BigInt(row.started);
      if (row.claude && /^\d+$/.test(row.started)) return { pid, started: row.started };
      pid = row.parent;
    }
    return;
  }
  if (platform !== 'win32') return;
  const helper = options.nativeHelper || resolve(dirname(process.execPath), '../apps/windows/desktop/Terminal-plus.TerminalInterrupt.exe');
  try {
    if (lstatSync(helper).isFile()) {
      const value = await new Promise((done, fail) => execFile(helper, ['claude-owner', String(parentPid)],
        { timeout: 750, windowsHide: true, maxBuffer: 100_000 }, (error, stdout) => {
          if (error) fail(error); else { try { done(JSON.parse(stdout)); } catch (error) { fail(error); } }
        }));
      if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || !/^\d{15,20}$/.test(value.started)) return;
      const argv = Array.isArray(value.argv) && value.argv.length <= 256 && value.argv.every(arg => typeof arg === 'string')
        && Buffer.byteLength(JSON.stringify(value.argv)) <= 90_000 ? value.argv : undefined;
      return { pid: value.pid, started: value.started, ...(argv ? { argv } : {}) };
    }
  } catch { /* Old or unavailable helpers use the bounded development fallback. */ }
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $current=${parentPid}; $seen=@{}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $latest=[DateTime]::UtcNow.Ticks; for($i=0;$i -lt 24 -and $current -gt 0;$i++){ if($seen.ContainsKey($current)){break}; $seen[$current]=$true; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$current"; if($null -eq $p){break}; $born=$p.CreationDate.ToUniversalTime().Ticks; if($born -gt $latest){break}; $latest=$born; $native=$p.Name -eq 'claude.exe'; $npm=$p.Name -match '^node(?:js)?\.exe$' -and $p.CommandLine -match '[\\/]@anthropic-ai[\\/]claude-code[\\/](?:cli\.js|cli\.mjs)(?:["\s]|$)'; if($native -or $npm){ $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if($owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid){ $started=(Get-Process -Id $p.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks; if([Math]::Abs($started-$born) -lt 10){ @{pid=[int]$p.ProcessId;started=$started.ToString()} | ConvertTo-Json -Compress } }; break }; $current=[int]$p.ParentProcessId }`;
  const executable = join(process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return await new Promise(done => {
    execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 1500, windowsHide: true, maxBuffer: 1024 }, (error, stdout) => {
        if (error) { done(undefined); return; }
        try {
          const value = JSON.parse(stdout);
          done(Number.isSafeInteger(value.pid) && value.pid > 0 && /^\d{15,20}$/.test(value.started)
            ? { pid: value.pid, started: value.started } : undefined);
        } catch { done(undefined); }
      });
  });
}

export function readClaudeHookGap(data) {
  const path = join(data, 'claude-monitor-gap.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return { gapUnconfirmed: true };
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.version !== 1 || !Number.isSafeInteger(value.through) || value.through < 0) return { gapUnconfirmed: true };
    return { gapThrough: value.through };
  } catch (error) { return error?.code === 'ENOENT' ? {} : { gapUnconfirmed: true }; }
}

/** A missing lifecycle event cannot later be mistaken for all agents finishing. */
export function noteClaudeHookGap(data, at = Date.now()) {
  const path = join(data, 'claude-monitor-gap.json');
  try {
    const root = lstatSync(data); if (!root.isDirectory() || root.isSymbolicLink()) return;
    try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') return; }
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return;
    let through = Math.max(Number.isSafeInteger(at) && at >= 0 ? at : 0, Date.now());
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = readClaudeHookGap(data); through = Math.max(through, previous.gapThrough || 0, Date.now());
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, through }), { flag: 'wx', mode: 0o600 });
        // Re-read just before commit: a concurrent gap may have a wider watermark.
        const current = readClaudeHookGap(data), widened = Math.max(through, current.gapThrough || 0, Date.now());
        if (widened !== through) { through = widened; writeFileSync(temporary, JSON.stringify({ version: 1, through }), { mode: 0o600 }); }
        renameSync(temporary, path);
        const committed = readClaudeHookGap(data);
        if (!committed.gapUnconfirmed && committed.gapThrough >= through) return;
      } finally { try { unlinkSync(temporary); } catch {} }
    }
  } catch { /* The unreadable placeholder remains when body persistence failed. */ }
}

export function writeClaudeHookEvent(data, event, owner) {
  if (!isAbsolute(data) || !event || !uuid.test(event.eventId) || !Number.isSafeInteger(event.at) || event.at < 0) return false;
  try {
    const root = lstatSync(data); if (!root.isDirectory() || root.isSymbolicLink()) { noteClaudeHookGap(data, event.at); return false; }
    const queue = join(data, 'claude-events');
    mkdirSync(queue, { recursive: true, mode: 0o700 });
    const directory = lstatSync(queue); if (!directory.isDirectory() || directory.isSymbolicLink()) { noteClaudeHookGap(data, event.at); return false; }
    // Stopped companions cannot accumulate an unbounded queue. The observer owns draining/pruning.
    if (readdirSync(queue).filter(name => /^\d+-[a-f0-9-]{36}\.json(?:\.tmp)?$/.test(name)).length >= 1024) { noteClaudeHookGap(data, event.at); return false; }
    const validOwner = owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && /^\d{1,20}$/.test(owner.started);
    const value = { ...event, ...readClaudeHookGap(data), ...(validOwner ? { owner: { pid: owner.pid, started: owner.started } } : {}) }, body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 100_000) { noteClaudeHookGap(data, event.at); return false; }
    const path = join(queue, `${event.at}-${event.eventId}.json`), temporary = path + '.tmp';
    try { writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); return true; }
    finally { try { unlinkSync(temporary); } catch {} }
  } catch { noteClaudeHookGap(data, event.at); return false; }
}

async function boundedStdin() {
  const chunks = []; let length = 0;
  const timeout = setTimeout(() => process.stdin.destroy(), 1000);
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length; if (length > 256_000) return;
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return; }
  finally { clearTimeout(timeout); process.stdin.destroy(); }
}

export async function runClaudeMonitorHook(data, options = {}) {
  if ((options.env || process.env).EVEN_PILOT_CLAUDE_CONNECTOR === '1') return false;
  if (typeof data !== 'string' || !data || !isAbsolute(data)) return false;
  try {
    const input = options.input === undefined ? await boundedStdin() : options.input;
    const event = sanitizeClaudeHook(input); if (!event) { noteClaudeHookGap(data); return false; }
    const owner = await (options.discoverOwner || discoverClaudeOwner)();
    if (event.hook_event_name === 'Stop' || event.hook_event_name === 'SubagentStop') {
      const trust = await (options.stopTrust || stopHookTrust)({ eventName: event.hook_event_name, cwd: event.cwd, data, owner, argv: owner?.argv });
      event.stopTrusted = trust?.trusted === true;
      const reason = metadata(trust?.reason, 128); if (reason) event.stopTrustReason = reason;
    }
    return writeClaudeHookEvent(resolve(data || ''), event, owner);
  } catch { noteClaudeHookGap(data); return false; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runClaudeMonitorHook(process.argv[2]); } catch {}
  process.stdout.write('{}\n'); process.exitCode = 0;
}
