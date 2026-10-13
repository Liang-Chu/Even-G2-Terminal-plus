export interface ClaudeProcessIdentity { pid: number; started: string }
export interface ClaudeQuestionAvailability {
  version: 1; at: number; backend: ClaudeProcessIdentity; instance: string;
  sessions: { sessionId: string; owner: ClaudeProcessIdentity; monitored: boolean }[];
}
export interface NativeClaudeQuestionRequest {
  version: 1; eventId: string; nonce: string; at: number; expiresAt: number;
  kind?: "question" | "approval"; lifecycleAt?: number;
  sessionId: string; toolUseId: string; transcriptPath: string; cwd: string;
  owner: ClaudeProcessIdentity; hook: ClaudeProcessIdentity;
  backend: ClaudeProcessIdentity & { instance: string };
  input: { questions?: import("../../../packages/connectors/claude-questions.mjs").ClaudeQuestion[]; permission?: NativeClaudePermission };
}
export interface NativeClaudePermission { toolName: string; toolInput: Record<string, unknown> }
export interface NativeClaudePermissionHookOutput { hookSpecificOutput: { hookEventName: "PermissionRequest"; decision: { behavior: "allow" | "deny" } } }
export type NativeClaudeHookOutput = NonNullable<ReturnType<typeof import("../../../packages/connectors/claude-questions.mjs").claudeQuestionOutput>> | NativeClaudePermissionHookOutput;
export interface NativeClaudeQuestionResponse {
  version: 1; eventId: string; nonce: string; at: number; expiresAt: number;
  kind?: "question" | "approval"; lifecycleAt?: number;
  sessionId: string; toolUseId: string; owner: ClaudeProcessIdentity; hook: ClaudeProcessIdentity;
  backend: ClaudeProcessIdentity & { instance: string }; action: "answer" | "cancel";
  answers?: Record<string, string>;
}
export const CLAUDE_NATIVE_QUESTION_TIMEOUT_MS: number;
export const CLAUDE_QUESTION_HEARTBEAT_MS: number;
export const CLAUDE_PERMISSION_PREVIEW_BYTES: number;
export function nativeClaudePermission(input: unknown): NativeClaudePermission | undefined;
export function nativeClaudePermissionOutput(permission: NativeClaudePermission, decision: "allow" | "deny"): NativeClaudePermissionHookOutput | undefined;
export function nativeClaudeRequestOutput(request: Pick<NativeClaudeQuestionRequest, "kind" | "input">, answers?: Record<string, string>): NativeClaudeHookOutput | undefined;
export function claudeQuestionDirectory(data: string, create?: boolean): string | undefined;
export function readClaudeQuestionFile(data: string, filename: string, limit?: number): any;
export function writeClaudeQuestionFile(data: string, filename: string, value: unknown, exclusive?: boolean): boolean;
export function validClaudeQuestionAvailability(value: unknown, now?: number): value is ClaudeQuestionAvailability;
export function writeClaudeQuestionAvailability(data: string, value: ClaudeQuestionAvailability, now?: number): boolean;
export function readClaudeQuestionAvailability(data: string, now?: number): ClaudeQuestionAvailability | undefined;
export function validClaudeQuestionRequest(value: unknown, now?: number): value is NativeClaudeQuestionRequest;
export function sameClaudeQuestionRequest(response: unknown, request: NativeClaudeQuestionRequest): response is NativeClaudeQuestionResponse;
export function readClaudeQuestionRequest(data: string, eventId: string, now?: number): NativeClaudeQuestionRequest | undefined;
export function writeClaudeQuestionResponse(data: string, request: NativeClaudeQuestionRequest, action: "answer" | "cancel", answers?: Record<string, string>, now?: number): boolean;
export const readNativeQuestionAvailability: typeof readClaudeQuestionAvailability;
export const writeNativeQuestionAvailability: typeof writeClaudeQuestionAvailability;
export const readNativeQuestionRequest: typeof readClaudeQuestionRequest;
export function listNativeQuestionRequests(data: string): string[];
export function readNativeQuestionConsumed(data: string, request: NativeClaudeQuestionRequest): NativeClaudeQuestionResponse | undefined;
export function writeNativeQuestionResponse(data: string, request: NativeClaudeQuestionRequest, response: { action: "answer" | "cancel"; answers?: Record<string, string> }, now?: number): boolean;
export function cleanupNativeQuestion(data: string, request: NativeClaudeQuestionRequest, options?: { includeAck?: boolean }): void;
export function removeNativeQuestionAvailability(data: string, instance: string): boolean;
export function pruneNativeQuestionFiles(data: string, now?: number): number;
export function claudeQuestionProcessIdentity(pid: number, options?: { platform?: string; procRoot?: string; uid?: number; nativeHelper?: string }): Promise<string | undefined>;
export const genericProcessIdentity: typeof claudeQuestionProcessIdentity;
export const processIdentity: typeof claudeQuestionProcessIdentity;
export function matchesProcess(owner: ClaudeProcessIdentity, identify?: (pid: number) => Promise<string | undefined>): Promise<boolean>;
export function claudeQuestionRequestAlive(request: NativeClaudeQuestionRequest, identify?: (pid: number) => Promise<string | undefined>, includeHook?: boolean): Promise<boolean>;
export function waitForNativeClaudeQuestion(data: string, input: any, event: any, owner: ClaudeProcessIdentity | undefined, options?: {
  now?: () => number; identify?: (pid: number) => Promise<string | undefined>; hookPid?: number; timeout?: number;
  discoveryGraceMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<unknown>;
}): Promise<NativeClaudeHookOutput | undefined>;
