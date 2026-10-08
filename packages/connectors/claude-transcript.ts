import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { canonicalPath } from "../pi-runtime/sessions.js";

export const CLAUDE_HEAD_BYTES = 64 * 1024;
export const CLAUDE_TAIL_BYTES = 2 * 1024 * 1024;
// One extra tail byte determines whether its first record starts at a boundary.
export const CLAUDE_MAX_READ_BYTES = CLAUDE_HEAD_BYTES + CLAUDE_TAIL_BYTES + 1;

export interface ClaudeTranscriptMetadata { id: string; cwd: string }
export interface ClaudeTranscript {
  content: string;
  metadata: ClaudeTranscriptMetadata;
  truncated: boolean;
  size: number;
  modified: number;
  bytesRead: number;
}

async function range(file: FileHandle, offset: number, length: number) {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const part = await file.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
    if (!part.bytesRead) throw new Error("Claude transcript changed during reading");
    bytesRead += part.bytesRead;
  }
  return buffer;
}

/** Keep only whole JSONL records; a trailing unfinished append is display truncation. */
function records(bytes: Buffer, startsAtBoundary: boolean, endsAtFile: boolean) {
  let first = 0, last = bytes.length, truncated = !startsAtBoundary;
  if (!startsAtBoundary) {
    const boundary = bytes.indexOf(10);
    if (boundary < 0) return { content: "", truncated: true };
    first = boundary + 1;
  }
  if (bytes.length && bytes[bytes.length - 1] !== 10) {
    const boundary = bytes.lastIndexOf(10);
    const final = bytes.subarray(Math.max(first, boundary + 1)).toString("utf8");
    let complete = false;
    if (endsAtFile) { try { JSON.parse(final); complete = true; } catch {} }
    if (!complete) { last = Math.max(first, boundary + 1); truncated = true; }
  }
  return { content: bytes.subarray(first, last).toString("utf8"), truncated };
}

function metadata(content: string, name: string): ClaudeTranscriptMetadata | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.isSidechain || typeof row.sessionId !== "string" || typeof row.cwd !== "string") continue;
    if (row.sessionId && row.sessionId.length <= 256 && name === row.sessionId + ".jsonl"
      && row.cwd.trim() && row.cwd.length <= 4096 && !row.cwd.includes("\0")) return { id: row.sessionId, cwd: row.cwd };
  }
  return undefined;
}

/** Read a bounded head/tail snapshot without following transcript or project symlinks.
 * Identity/cwd come from an actual transcript record, never from a filename guess.
 * Omitted records affect history display only; they cannot establish lifecycle state.
 */
export async function readClaudeTranscript(path: string, root: string): Promise<ClaudeTranscript> {
  path = resolve(path); root = resolve(root);
  const within = relative(root, path).split(sep);
  if (within.length > 2 || within.some(part => !part || part === ".." || part.toLowerCase() === "subagents")
    || !canonicalPath(path).startsWith(canonicalPath(root) + sep) || !path.endsWith(".jsonl"))
    throw new Error("Claude transcript is outside the main session directories");
  const actualRoot = canonicalPath(await realpath(root));
  const securePath = async () => {
    if (dirname(path) !== root) {
      const parent = await lstat(dirname(path));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Claude project directory must not be linked");
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size)
      || !canonicalPath(await realpath(path)).startsWith(actualRoot + sep))
      throw new Error("Claude transcript must be a regular file inside its project root");
    return info;
  };
  const before = await securePath();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || !Number.isSafeInteger(info.size))
      throw new Error("Claude transcript changed before reading");
    let content: string, truncated: boolean, bytesRead: number;
    if (info.size <= CLAUDE_HEAD_BYTES + CLAUDE_TAIL_BYTES) {
      const snapshot = records(await range(file, 0, info.size), true, true);
      ({ content, truncated } = snapshot); bytesRead = info.size;
    } else {
      const head = records(await range(file, 0, CLAUDE_HEAD_BYTES), true, false);
      const offset = info.size - CLAUDE_TAIL_BYTES;
      const tailBytes = await range(file, offset - 1, CLAUDE_TAIL_BYTES + 1);
      const tail = records(tailBytes.subarray(1), tailBytes[0] === 10, true);
      content = head.content + (head.content && !head.content.endsWith("\n") ? "\n" : "") + tail.content;
      truncated = true; bytesRead = CLAUDE_MAX_READ_BYTES;
    }
    const after = await securePath(), current = await file.stat();
    if (after.ino !== info.ino || after.dev !== info.dev || current.size < info.size)
      throw new Error("Claude transcript changed during reading");
    const identity = metadata(content, basename(path));
    if (!identity) throw new Error("Claude transcript has no matching session metadata");
    return { content, metadata: identity, truncated, size: info.size, modified: info.mtimeMs, bytesRead };
  } finally { await file.close(); }
}
