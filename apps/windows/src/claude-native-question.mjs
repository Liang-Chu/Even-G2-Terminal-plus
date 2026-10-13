// Native questions and permission prompts may wait for an explicit answer.
// Missing monitoring, cancellation or uncertainty always returns to the CLI.
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { claudeQuestions, claudeQuestionOutput } from '../../../packages/connectors/claude-questions.mjs';

export const CLAUDE_NATIVE_QUESTION_TIMEOUT_MS = 300_000;
export const CLAUDE_QUESTION_HEARTBEAT_MS = 5000;
export const CLAUDE_PERMISSION_PREVIEW_BYTES = 20_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const token = /^[a-f0-9]{64}$/;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = value => object(value) && Number.isSafeInteger(value.pid) && value.pid > 0 && /^\d{1,20}$/.test(value.started || '');
const sameIdentity = (a, b) => identity(a) && identity(b) && a.pid === b.pid && a.started === b.started;
const text = (value, limit) => typeof value === 'string' && !!value.trim() && value.length <= limit && !value.includes('\0');
const at = value => Number.isSafeInteger(value) && value >= 0;
const privateOwner = stat => process.platform !== 'linux' || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);

function permissionValue(value) {
  if (!object(value) || !text(value.toolName, 200) || value.toolName === 'AskUserQuestion' || !object(value.toolInput)
    || Object.keys(value).some(key => !['toolName', 'toolInput'].includes(key))) return;
  try {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > CLAUDE_PERMISSION_PREVIEW_BYTES) return;
    // Keep the full proposed action. A truncated preview must never be approved.
    return JSON.parse(body);
  } catch { return; }
}

/** Only the current tool/action is retained, never suggested persistent policies. */
export function nativeClaudePermission(input) {
  if (input?.hook_event_name !== 'PermissionRequest') return;
  return permissionValue({ toolName: input.tool_name, toolInput: input.tool_input });
}

export function nativeClaudePermissionOutput(permission, decision) {
  if (!permissionValue(permission) || !['allow', 'deny'].includes(decision)) return;
  // Omitting updatedPermissions preserves the existing permission policy.
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision } } };
}

function requestInput(value) {
  if (!object(value) || ![undefined, 'question', 'approval'].includes(value.kind) || !object(value.input)) return;
  if (value.kind === 'approval') {
    if (Object.keys(value.input).length !== 1 || !Object.hasOwn(value.input, 'permission')) return;
    return permissionValue(value.input.permission) ? value.input : undefined;
  }
  if (Object.keys(value.input).length !== 1 || !Object.hasOwn(value.input, 'questions')) return;
  return claudeQuestions(value.input) ? value.input : undefined;
}

/** A question answer can never be used as a tool permission, or vice versa. */
export function nativeClaudeRequestOutput(request, answers) {
  if (!requestInput(request)) return;
  if (request.kind !== 'approval') return claudeQuestionOutput(request.input, answers);
  if (!object(answers) || Object.keys(answers).length !== 1 || !Object.hasOwn(answers, 'decision')) return;
  return nativeClaudePermissionOutput(request.input.permission, answers.decision);
}

export function claudeQuestionDirectory(data, create = false) {
  if (typeof data !== 'string' || !isAbsolute(data)) return;
  try {
    const root = lstatSync(data);
    if (!root.isDirectory() || root.isSymbolicLink() || !privateOwner(root)) return;
    const directory = join(data, 'claude-questions');
    if (create) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat)) return;
    return directory;
  } catch (error) {
    if (create && error?.code === 'EEXIST') return claudeQuestionDirectory(data);
  }
}

/** No symlinks, hard links, shared permissions, oversized files or arbitrary paths. */
export function readClaudeQuestionFile(data, filename, limit = 100_000) {
  if (!/^(?:availability\.json|[a-f0-9-]{36}\.(?:request|response|consumed)\.json)$/.test(filename)) return;
  const directory = claudeQuestionDirectory(data); if (!directory) return;
  let fd;
  try {
    const path = join(directory, filename), before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit || !privateOwner(before)) return;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || !privateOwner(stat)
      || stat.dev !== before.dev || stat.ino !== before.ino) return;
    const body = readFileSync(fd, 'utf8'); if (Buffer.byteLength(body) > limit) return;
    return JSON.parse(body);
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function writeClaudeQuestionFile(data, filename, value, exclusive = false) {
  if (!/^(?:availability\.json|[a-f0-9-]{36}\.(?:request|response)\.json)$/.test(filename)) return false;
  const directory = claudeQuestionDirectory(data, true); if (!directory) return false;
  let temporary;
  try {
    const body = JSON.stringify(value); if (Buffer.byteLength(body) > 100_000) return false;
    const path = join(directory, filename);
    temporary = join(directory, randomUUID() + '.tmp');
    writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
    if (exclusive) { linkSync(temporary, path); unlinkSync(temporary); temporary = undefined; return true; }
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || !privateOwner(existing)) return false;
    } catch (error) { if (error?.code !== 'ENOENT') return false; }
    renameSync(temporary, path); return true;
  } catch { return false; }
  finally { if (temporary) { try { unlinkSync(temporary); } catch {} } }
}

export function validClaudeQuestionAvailability(value, now = Date.now()) {
  return object(value) && value.version === 1 && at(value.at) && value.at <= now + 1000
    && now - value.at <= CLAUDE_QUESTION_HEARTBEAT_MS && identity(value.backend) && uuid.test(value.instance || '')
    && Array.isArray(value.sessions) && value.sessions.length <= 512
    && value.sessions.every(row => object(row) && uuid.test(row.sessionId || '') && identity(row.owner) && typeof row.monitored === 'boolean');
}

export function writeClaudeQuestionAvailability(data, value, now = Date.now()) {
  return validClaudeQuestionAvailability(value, now) && writeClaudeQuestionFile(data, 'availability.json', value);
}

export function readClaudeQuestionAvailability(data, now = Date.now()) {
  // An atomic heartbeat replacement can occur between lstat and open. Retry
  // once while retaining all the inode/private-file checks on both reads.
  const value = readClaudeQuestionFile(data, 'availability.json', 100_000)
    ?? readClaudeQuestionFile(data, 'availability.json', 100_000);
  return validClaudeQuestionAvailability(value, now) ? value : undefined;
}

export function validClaudeQuestionRequest(value, now = Date.now()) {
  return object(value) && value.version === 1 && uuid.test(value.eventId || '') && token.test(value.nonce || '')
    && at(value.at) && value.at <= now + 1000 && at(value.expiresAt) && value.expiresAt > now
    && value.expiresAt > value.at && value.expiresAt - value.at <= CLAUDE_NATIVE_QUESTION_TIMEOUT_MS
    && uuid.test(value.sessionId || '') && /^[\w-]{1,200}$/.test(value.toolUseId || '')
    && text(value.transcriptPath, 4096) && isAbsolute(value.transcriptPath) && text(value.cwd, 4096) && isAbsolute(value.cwd)
    && identity(value.owner) && identity(value.hook) && identity(value.backend) && uuid.test(value.backend.instance || '')
    && (value.lifecycleAt === undefined || at(value.lifecycleAt) && value.lifecycleAt <= value.at + 1000)
    && (value.kind !== 'approval' || value.toolUseId === value.eventId)
    && !!requestInput(value);
}

export function sameClaudeQuestionRequest(response, request) {
  return object(response) && response.version === 1 && response.eventId === request.eventId && response.nonce === request.nonce
    && response.sessionId === request.sessionId && response.toolUseId === request.toolUseId
    && (response.kind ?? 'question') === (request.kind ?? 'question') && response.lifecycleAt === request.lifecycleAt
    && sameIdentity(response.owner, request.owner) && sameIdentity(response.hook, request.hook)
    && sameIdentity(response.backend, request.backend) && response.backend.instance === request.backend.instance
    && response.expiresAt === request.expiresAt && at(response.at) && response.at >= request.at && response.at < request.expiresAt;
}

export function readClaudeQuestionRequest(data, eventId, now = Date.now()) {
  if (!uuid.test(eventId || '')) return;
  const value = readClaudeQuestionFile(data, eventId + '.request.json');
  return validClaudeQuestionRequest(value, now) && value.eventId === eventId ? value : undefined;
}

export const readNativeQuestionAvailability = readClaudeQuestionAvailability;
export const writeNativeQuestionAvailability = writeClaudeQuestionAvailability;
export const readNativeQuestionRequest = readClaudeQuestionRequest;
export function listNativeQuestionRequests(data) {
  const directory = claudeQuestionDirectory(data); if (!directory) return [];
  try {
    return readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name)).slice(0, 128)
      .map(name => name.slice(0, -'.request.json'.length));
  } catch { return []; }
}
export function readNativeQuestionConsumed(data, request) {
  const value = readClaudeQuestionFile(data, request.eventId + '.consumed.json');
  return sameClaudeQuestionRequest(value, request) && ['answer', 'cancel'].includes(value.action)
    && (value.action !== 'answer' || nativeClaudeRequestOutput(request, value.answers)) ? value : undefined;
}
export function cleanupNativeQuestion(data, request, options = {}) {
  if (!uuid.test(request?.eventId || '') || !token.test(request?.nonce || '')) return;
  const directory = claudeQuestionDirectory(data); if (!directory) return;
  for (const suffix of ['request', 'response', ...(options.includeAck ? ['consumed'] : [])]) {
    const value = readClaudeQuestionFile(data, request.eventId + '.' + suffix + '.json');
    const matches = suffix === 'request' ? value?.nonce === request.nonce && value?.eventId === request.eventId
      : sameClaudeQuestionRequest(value, request);
    if (matches) { try { unlinkSync(join(directory, request.eventId + '.' + suffix + '.json')); } catch {} }
  }
}
export function removeNativeQuestionAvailability(data, instance) {
  if (!uuid.test(instance || '')) return false;
  const value = readClaudeQuestionFile(data, 'availability.json');
  if (value?.instance !== instance) return false;
  const directory = claudeQuestionDirectory(data); if (!directory) return false;
  try { unlinkSync(join(directory, 'availability.json')); return true; } catch { return false; }
}

/** Backends can disappear after an acknowledgement. Reap only our expired,
 * bounded, identity-shaped artifacts; unrelated files and unsafe links remain. */
export function pruneNativeQuestionFiles(data, now = Date.now()) {
  const directory = claudeQuestionDirectory(data); if (!directory || !at(now)) return 0;
  let removed = 0;
  try {
    for (const filename of readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.(?:request|response|consumed)\.json$/.test(name))) {
      const value = readClaudeQuestionFile(data, filename);
      if (!object(value) || value.version !== 1 || !uuid.test(value.eventId || '') || !filename.startsWith(value.eventId + '.')
        || !token.test(value.nonce || '') || !uuid.test(value.sessionId || '') || !/^[\w-]{1,200}$/.test(value.toolUseId || '')
        || !identity(value.owner) || !identity(value.hook) || !identity(value.backend) || !uuid.test(value.backend.instance || '')
        || ![undefined, 'question', 'approval'].includes(value.kind)
        || (value.lifecycleAt !== undefined && (!at(value.lifecycleAt) || value.lifecycleAt > value.at + 1000))
        || (value.kind === 'approval' && value.toolUseId !== value.eventId)
        || !at(value.at) || !at(value.expiresAt) || value.expiresAt <= value.at
        || value.expiresAt - value.at > CLAUDE_NATIVE_QUESTION_TIMEOUT_MS || value.expiresAt > now) continue;
      if (filename.endsWith('.request.json')) {
        if (!validClaudeQuestionRequest(value, value.at)) continue;
      } else {
        if (!['answer', 'cancel'].includes(value.action)) continue;
        if (value.action === 'answer') {
          if (!object(value.answers)) continue;
          const entries = Object.entries(value.answers);
          if (value.kind === 'approval'
            ? entries.length !== 1 || !Object.hasOwn(value.answers, 'decision') || !['allow', 'deny'].includes(value.answers.decision)
            : entries.length < 1 || entries.length > 4
              || entries.some(([question, answer]) => !text(question, 2000) || !text(answer, 8000))) continue;
        }
      }
      const path = join(directory, filename), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 100_000 || !privateOwner(stat)) continue;
      unlinkSync(path); removed++;
    }
  } catch { /* A concurrently consumed artifact is retried at the next scan. */ }
  return removed;
}

/** Answers are bound to exactly one question or current tool permission. */
export function writeClaudeQuestionResponse(data, request, action, answers, now = Date.now()) {
  if (!validClaudeQuestionRequest(request, now) || !['answer', 'cancel'].includes(action)
    || action === 'answer' && !nativeClaudeRequestOutput(request, answers)) return false;
  const current = readClaudeQuestionRequest(data, request.eventId, now);
  if (!current || !sameClaudeQuestionRequest({ ...current, at: now }, request)
    || current.cwd !== request.cwd || current.transcriptPath !== request.transcriptPath
    || JSON.stringify(current.input) !== JSON.stringify(request.input)
    || readNativeQuestionConsumed(data, request)) return false;
  const value = { version: 1, eventId: request.eventId, nonce: request.nonce, sessionId: request.sessionId, toolUseId: request.toolUseId,
    ...(request.kind !== undefined ? { kind: request.kind } : {}), ...(request.lifecycleAt !== undefined ? { lifecycleAt: request.lifecycleAt } : {}),
    owner: request.owner, hook: request.hook, backend: request.backend, at: now, expiresAt: request.expiresAt,
    action, ...(action === 'answer' ? { answers } : {}) };
  return writeClaudeQuestionFile(data, request.eventId + '.response.json', value, true);
}

export function writeNativeQuestionResponse(data, request, response, now = Date.now()) {
  return writeClaudeQuestionResponse(data, request, response?.action, response?.answers, now);
}

/** PID plus immutable start time prevents a recycled process accepting a reply. */
export async function claudeQuestionProcessIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const platform = options.platform || process.platform;
  if (platform === 'linux') {
    try {
      const root = join(options.procRoot || '/proc', String(pid)), stat = lstatSync(root);
      if (stat.uid !== (options.uid ?? process.getuid())) return;
      const source = readFileSync(join(root, 'stat'), 'utf8'), end = source.lastIndexOf(') ');
      if (end < 0 || source.slice(0, source.indexOf(' ')) !== String(pid)) return;
      const fields = source.slice(end + 2).trim().split(/\s+/);
      if (['Z', 'X', 'x'].includes(fields[0])) return;
      const started = fields[19];
      return /^\d+$/.test(started || '') ? started : undefined;
    } catch { return; }
  }
  if (platform !== 'win32') return;
  const helper = options.nativeHelper || resolve(dirname(process.execPath), '../apps/windows/desktop/Terminal-plus.TerminalInterrupt.exe');
  try {
    const stat = lstatSync(helper);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      return await new Promise(done => execFile(helper, ['identity', String(pid)],
        { timeout: 1000, windowsHide: true, maxBuffer: 1024 }, (error, stdout) => {
          const started = stdout?.trim(); done(!error && /^\d{15,20}$/.test(started || '') ? started : undefined);
        }));
    }
  } catch {}
  // Source/dev execution has no bundled helper. This does not enumerate processes.
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($null -ne $p){ $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if($owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid){ $started=(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks; if([Math]::Abs($started-$p.CreationDate.ToUniversalTime().Ticks) -lt 10){[Console]::Write($started.ToString())} } }`;
  const powershell = join(process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return await new Promise(done => execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 1500, windowsHide: true, maxBuffer: 1024 }, (error, stdout) => {
      const started = stdout?.trim(); done(!error && /^\d{15,20}$/.test(started || '') ? started : undefined);
    }));
}

export async function claudeQuestionRequestAlive(request, identify = claudeQuestionProcessIdentity, includeHook = true) {
  const rows = [request.owner, request.backend, ...(includeHook ? [request.hook] : [])];
  const started = await Promise.all(rows.map(row => identify(row.pid)));
  return started.every((value, index) => value === rows[index].started);
}

export const genericProcessIdentity = claudeQuestionProcessIdentity;
export const processIdentity = claudeQuestionProcessIdentity;
export async function matchesProcess(owner, identify = claudeQuestionProcessIdentity) {
  return identity(owner) && await identify(owner.pid) === owner.started;
}

function available(data, sessionId, owner, backend, now) {
  const value = readClaudeQuestionAvailability(data, now);
  return value && value.sessions.some(row => row.sessionId === sessionId && sameIdentity(row.owner, owner) && row.monitored)
    && (!backend || sameIdentity(value.backend, backend) && value.instance === backend.instance) ? value : undefined;
}

/** Queue private prompt fields only while a verified watched session can answer. */
export async function waitForNativeClaudeQuestion(data, input, event, owner, options = {}) {
  const now = options.now || Date.now, identify = options.identify || claudeQuestionProcessIdentity;
  const permission = nativeClaudePermission(input), questions = input?.hook_event_name === 'PreToolUse'
    && input.tool_name === 'AskUserQuestion' && /^[\w-]{1,200}$/.test(input.tool_use_id || '') ? claudeQuestions(input.tool_input) : undefined;
  if ((!permission && !questions) || input.agent_id || !identity(owner) || !uuid.test(event?.eventId || '')) return;
  const started = now(), sleep = options.sleep || (ms => new Promise(done => setTimeout(done, ms)));
  let heartbeat = available(data, event.session_id, owner, undefined, started);
  // The first queued lifecycle hooks can beat discovery. A known unwatch or a
  // stopped companion never waits; only an unknown session gets a brief grace.
  while (!heartbeat && now() - started < Math.min(options.discoveryGraceMs ?? 2000, 2000)) {
    const current = readClaudeQuestionAvailability(data, now());
    if (!current || current.sessions.some(row => row.sessionId === event.session_id)) return;
    await sleep(Math.min(options.pollMs || 150, 2000 - (now() - started)));
    heartbeat = available(data, event.session_id, owner, undefined, now());
  }
  if (!heartbeat) return;
  const hook = { pid: options.hookPid || process.pid, started: await identify(options.hookPid || process.pid) };
  if (!identity(hook)) return;
  const request = { version: 1, eventId: event.eventId, nonce: randomBytes(32).toString('hex'), at: started,
    kind: permission ? 'approval' : 'question', lifecycleAt: at(event.at) ? event.at : started,
    expiresAt: started + Math.min(options.timeout ?? CLAUDE_NATIVE_QUESTION_TIMEOUT_MS, CLAUDE_NATIVE_QUESTION_TIMEOUT_MS),
    sessionId: event.session_id, toolUseId: permission ? event.eventId : input.tool_use_id, transcriptPath: event.transcript_path, cwd: event.cwd,
    owner: { pid: owner.pid, started: owner.started }, hook,
    backend: { ...heartbeat.backend, instance: heartbeat.instance }, input: permission ? { permission } : { questions } };
  if (!validClaudeQuestionRequest(request, now()) || !await claudeQuestionRequestAlive(request, identify, false)) return;
  const directory = claudeQuestionDirectory(data); if (!directory) return;
  if (readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.request\.json$/.test(name)).length >= 128
    || !writeClaudeQuestionFile(data, event.eventId + '.request.json', request, true)) return;
  let checkedAt = started;
  try {
    while (now() < request.expiresAt) {
      // A failed/cancelled delivery retires this private request. Do not keep
      // waiting invisibly just because the session remains watched and healthy.
      const current = readClaudeQuestionRequest(data, request.eventId, now());
      if (!current || current.at !== request.at || !sameClaudeQuestionRequest(current, request)
        || current.cwd !== request.cwd || current.transcriptPath !== request.transcriptPath
        || JSON.stringify(current.input) !== JSON.stringify(request.input)) return;
      if (!available(data, request.sessionId, owner, request.backend, now())) return;
      if (now() - checkedAt >= 1000) {
        if (!await claudeQuestionRequestAlive(request, identify, false)) return;
        checkedAt = now();
      }
      const response = readClaudeQuestionFile(data, request.eventId + '.response.json');
      if (response !== undefined) {
        if (!sameClaudeQuestionRequest(response, request) || now() >= request.expiresAt || response.at > now() + 1000
          || !['answer', 'cancel'].includes(response.action)) return;
        const output = response.action === 'answer' ? nativeClaudeRequestOutput(request, response.answers) : undefined;
        if (response.action === 'answer' && !output || !await claudeQuestionRequestAlive(request, identify)
          || now() >= request.expiresAt || !available(data, request.sessionId, owner, request.backend, now())) return;
        // A consumed receipt lets the backend confirm delivery before removing it.
        renameSync(join(directory, request.eventId + '.response.json'), join(directory, request.eventId + '.consumed.json'));
        return output;
      }
      await sleep(Math.min(options.pollMs || 150, request.expiresAt - now()));
    }
  } catch { return; }
  finally {
    for (const suffix of ['request', 'response']) { try { unlinkSync(join(directory, request.eventId + '.' + suffix + '.json')); } catch {} }
  }
}
