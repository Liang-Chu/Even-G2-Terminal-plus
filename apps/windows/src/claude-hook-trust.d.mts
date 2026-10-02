export interface StopHookTrustOptions {
  eventName: string; cwd: string; data: string; runDirectory?: string;
  owner?: { pid: number; started?: string }; configRoot?: string; argv?: string[]; managedPaths?: string[]; projectPaths?: string[];
}
export function stopHookTrust(options: StopHookTrustOptions): Promise<{
  trusted: boolean; reason?: "additional_hooks" | "unreadable_settings" | "unverified_sources";
}>;
