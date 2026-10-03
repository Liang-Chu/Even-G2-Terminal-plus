import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { processAlive, readLocalJson, uuidPattern } from "../../../packages/pi-runtime/native-protocol.js";
import { fetchUpdateResource } from "./update-fetch.js";

export const updateRepository = "Liang-Chu/Even-Pilot";
const day = 24 * 60 * 60_000;
const maxAsset = 200 * 1024 * 1024;
export class UpdateError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export interface UpdateRelease { version: string; page: string; url: string; sha256: string; size: number }
interface Settings { automaticChecks: boolean; checkedAt?: number; latest?: UpdateRelease; error?: string }
interface InstallJob { id: string; version: string; startedAt: number; workerPid?: number; installer: string; root: string; directory: string }
export function versionParts(value: unknown): number[] | undefined {
  if (typeof value !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) return;
  return value.split(".").map(Number);
}
export function newerVersion(candidate: string, current: string) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let n = 0; n < 3; n++) if (a[n] !== b[n]) return a[n] > b[n];
  return false;
}
export function releaseAssetName(version: string, platform: string, arch: string) {
  if (platform === "win32" && arch === "x64") return `Even-Pilot-${version}-Setup-x64.exe`;
  if (platform === "linux" && ["x64", "arm64"].includes(arch)) return `Even-Pilot-${version}-Setup-linux-${arch}.run`;
  return undefined;
}
export function parseUpdateRelease(data: any, current: string, platform: string, arch: string): UpdateRelease | undefined {
  if (data?.draft !== false || data?.prerelease !== false || typeof data.tag_name !== "string") throw new UpdateError("Invalid release metadata");
  const version = data.tag_name.replace(/^v/, "");
  if (!versionParts(version)) throw new UpdateError("Invalid release version");
  if (!newerVersion(version, current)) return;
  const name = releaseAssetName(version, platform, arch);
  if (!name) throw new UpdateError("This platform requires a manual update");
  const matches = Array.isArray(data.assets) ? data.assets.filter((item: any) => item.name === name) : [];
  if (matches.length !== 1) throw new UpdateError("The release has no complete installer for this platform");
  const asset = matches[0], url = `https://github.com/${updateRepository}/releases/download/${data.tag_name}/${name}`;
  if (asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "") ||
      !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxAsset || asset.state !== "uploaded")
    throw new UpdateError("Installer metadata or SHA-256 is unavailable; update manually from Releases");
  return { version, page: `https://github.com/${updateRepository}/releases/tag/${data.tag_name}`, url, sha256: asset.digest.slice(7), size: asset.size };
}
function allowedDownload(value: string) {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname);
}
export class UpdateService {
  private settings: Settings = { automaticChecks: true };
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<unknown>;
  private abort?: AbortController;
  private closed = false;
  private generation = 0;
  private phase: "idle" | "checking" | "downloading" | "installing" = "idle";
  private progress = 0;
  private installJob?: InstallJob;
  private readonly path: string;
  constructor(private options: {
    directory: string; version: string; platform?: string; arch?: string; installRoot: string; payloadRoot: string;
    port: number; supported?: boolean; automatic?: boolean; now?: () => number; fetch?: typeof fetch;
    install?: (path: string, release: UpdateRelease) => Promise<void>;
    workerAlive?: (pid: number) => boolean;
  }) {
    this.path = join(options.directory, "update-settings.json");
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, "utf8"));
        if (typeof saved.automaticChecks !== "boolean") throw new Error();
        this.settings = { automaticChecks: saved.automaticChecks,
          checkedAt: Number.isFinite(saved.checkedAt) && saved.checkedAt <= this.now() ? saved.checkedAt : undefined };
        // Cached release URLs are never executable input. An install always fetches fresh metadata.
        if (saved.latest && versionParts(saved.latest.version) && newerVersion(saved.latest.version, options.version))
          this.settings.latest = saved.latest;
      } catch { this.settings = { automaticChecks: false, error: "Update settings could not be read. Save the preference again." }; }
    }
    try {
      const job = readLocalJson(join(options.directory, "updates/job.json"));
      if (uuidPattern.test(job.id) && versionParts(job.version) && Number.isFinite(job.startedAt) && job.startedAt > 0 &&
          job.startedAt <= this.now() && resolve(job.directory) === resolve(options.directory) && resolve(job.root) === resolve(options.installRoot) &&
          dirname(resolve(job.installer)) === resolve(options.directory, "updates")) {
        this.installJob = job; this.phase = "installing";
      }
    } catch { }
    this.recoverInstallation(); this.schedule();
  }
  private now() { return (this.options.now || Date.now)(); }
  private save() {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    writeFileSync(this.path + ".tmp", JSON.stringify(this.settings), { mode: 0o600 }); renameSync(this.path + ".tmp", this.path);
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.closed || this.options.automatic === false || !this.settings.automaticChecks || this.phase !== "idle") return;
    const wait = Math.max(10_000, (this.settings.checkedAt || 0) + day - this.now());
    this.timer = setTimeout(() => { void this.check().catch(() => {}); }, wait); this.timer.unref();
  }
  private recoverInstallation() {
    if (this.phase !== "installing" || !this.installJob) return;
    const job = this.installJob;
    let result: any, state: any;
    try { result = readLocalJson(join(this.options.directory, "update-result.json")); } catch { }
    if (result?.id === job.id && result?.at >= job.startedAt && ["installed", "failed"].includes(result.status)) {
      this.phase = "idle"; this.installJob = undefined;
      if (result.status === "failed") this.settings.error = "Update failed. The previous version was restored when possible; check the installed version before retrying.";
      try { if (readLocalJson(join(this.options.directory, "updates/job.json"))?.id === job.id) unlinkSync(join(this.options.directory, "updates/job.json")); } catch { }
      this.schedule(); return;
    }
    // A restarting backend is not evidence that installation stopped. Give the
    // detached helper time to start and keep the lock while either process lives.
    if (this.now() - job.startedAt < 15_000) return;
    try { state = readLocalJson(join(this.options.directory, "updates/worker-state.json")); } catch { }
    const alive = (pid: unknown) => Number.isSafeInteger(pid) && Number(pid) > 0 && (this.options.workerAlive || processAlive)(Number(pid));
    const matching = state?.id === job.id && state?.version === job.version;
    if (alive(job.workerPid) || matching && (alive(state.pid) || alive(state.installerPid))) return;
    const interrupted = { id: job.id, status: "failed", version: job.version, at: this.now() };
    this.phase = "idle"; this.installJob = undefined;
    this.settings.error = "The update helper stopped before reporting a result. Check the installed version, then check updates again to retry. Monitoring and native terminals were not stopped by recovery.";
    try {
      const path = join(this.options.directory, "update-result.json"), pending = path + ".recovery-" + job.id;
      writeFileSync(pending, JSON.stringify(interrupted), { mode: 0o600 }); renameSync(pending, path);
      if (readLocalJson(join(this.options.directory, "updates/job.json"))?.id === job.id) unlinkSync(join(this.options.directory, "updates/job.json"));
      this.save();
    } catch { }
    this.schedule();
  }
  status() {
    this.recoverInstallation();
    let result: any;
    try { result = JSON.parse(readFileSync(join(this.options.directory, "update-result.json"), "utf8")); } catch {}
    return { currentVersion: this.options.version, repository: updateRepository, automaticChecks: this.settings.automaticChecks,
      checkedAt: this.settings.checkedAt || null, available: this.settings.latest ? { version: this.settings.latest.version,
        page: `https://github.com/${updateRepository}/releases/tag/v${this.settings.latest.version}` } : null,
      phase: this.phase, progress: this.progress, error: this.settings.error || null,
      installSupported: this.options.supported ?? existsSync(join(this.options.payloadRoot, "installed.json")),
      lastResult: result && ["installed", "failed"].includes(result.status) ? { status: result.status, version: result.version } : null };
  }
  configure(value: unknown) {
    this.recoverInstallation();
    if (typeof value !== "boolean") throw new UpdateError("automaticChecks must be true or false");
    if (["downloading", "installing"].includes(this.phase)) throw new UpdateError("Wait for the current update to finish", 409);
    this.generation++; this.abort?.abort(); this.phase = "idle";
    this.settings.automaticChecks = value; this.settings.error = undefined; this.save(); this.schedule(); return this.status();
  }
  check() {
    this.recoverInstallation();
    if (this.task) return this.task as Promise<ReturnType<UpdateService["status"]>>;
    this.task = this.performCheck().finally(() => { this.task = undefined; this.schedule(); });
    return this.task as Promise<ReturnType<UpdateService["status"]>>;
  }
  private async metadata(signal: AbortSignal) {
    const response = await (this.options.fetch || fetchUpdateResource)(`https://api.github.com/repos/${updateRepository}/releases/latest`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Even-Pilot/" + this.options.version }, credentials: "omit" });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new UpdateError("No public release is available yet", 503);
      throw new UpdateError(`Update check returned HTTP ${response.status}. Try again later.`, 503);
    }
    const text = await response.text(); if (text.length > 1_000_000) throw new UpdateError("Release metadata is too large");
    return parseUpdateRelease(JSON.parse(text), this.options.version, this.options.platform || process.platform, this.options.arch || process.arch);
  }
  private async performCheck() {
    if (this.phase !== "idle") throw new UpdateError("An update is already in progress", 409);
    const generation = this.generation; this.abort = new AbortController(); this.phase = "checking"; clearTimeout(this.timer);
    try {
      const latest = await this.metadata(this.abort.signal);
      if (this.closed || generation !== this.generation) return this.status();
      this.settings.latest = latest; this.settings.error = undefined;
    } catch (error) {
      if (this.closed || generation !== this.generation) return this.status();
      this.settings.error = error instanceof UpdateError ? error.message : "Cannot reach GitHub. Monitoring is unaffected; try again later.";
    } finally {
      if (!this.closed && generation === this.generation) { this.phase = "idle"; this.settings.checkedAt = this.now(); this.save(); }
    }
    return this.status();
  }
  install(version: unknown) {
    this.recoverInstallation();
    if (this.phase !== "idle" || this.task) throw new UpdateError("An update is already in progress", 409);
    if (!this.status().installSupported) throw new UpdateError("Install the desktop package first; source checkouts are not replaced automatically", 409);
    if (!versionParts(version) || version !== this.settings.latest?.version) throw new UpdateError("Check updates and select the displayed version first", 409);
    this.phase = "downloading"; this.progress = 0; this.settings.error = undefined; clearTimeout(this.timer);
    this.task = this.downloadAndInstall(version as string).finally(() => { this.task = undefined; this.schedule(); });
    void this.task.catch(() => {}); return this.status();
  }
  private async downloadAndInstall(version: string) {
    const abort = new AbortController(); this.abort = abort;
    const directory = join(this.options.directory, "updates");
    const path = join(directory, "installer-" + version + ((this.options.platform || process.platform) === "win32" ? ".exe" : ".run"));
    let response: Response | undefined;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const release = await this.metadata(abort.signal);
      if (!release || release.version !== version) throw new UpdateError("The latest release changed. Check updates again before installing.");
      let url = release.url;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10 * 60_000)]);
      for (let redirects = 0; redirects < 5; redirects++) {
        if (!allowedDownload(url)) throw new UpdateError("Unexpected installer download host");
        response = await (this.options.fetch || fetchUpdateResource)(url, { redirect: "manual", signal, credentials: "omit" });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const next = response.headers.get("location"); await response.body?.cancel();
        if (!next) throw new UpdateError("Invalid installer redirect"); url = new URL(next, url).href; response = undefined;
      }
      if (!response?.ok || !response.body) {
        await response?.body?.cancel();
        throw new UpdateError("Installer download failed. Try again later.", 503);
      }
      const file = await open(path + ".part", "w", 0o600), hash = createHash("sha256"); let bytes = 0;
      try {
        for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          bytes += chunk.length; if (bytes > release.size) throw new UpdateError("Installer exceeds its published size");
          hash.update(chunk); await file.writeFile(chunk); this.progress = Math.floor(bytes * 100 / release.size);
        }
      } finally { await file.close(); }
      if (bytes !== release.size || hash.digest("hex") !== release.sha256) throw new UpdateError("Installer checksum mismatch. Nothing was installed.");
      if (this.closed) return;
      renameSync(path + ".part", path); this.phase = "installing";
      if (this.options.install) { await this.options.install(path, release); this.phase = "idle"; }
      else await this.launch(path, release);
    } catch (error) {
      this.phase = "idle"; this.settings.error = error instanceof UpdateError ? error.message : "Update failed. The current installation was retained.";
      if (this.installJob && !this.installJob.workerPid) {
        try { if (readLocalJson(join(directory, "job.json"))?.id === this.installJob.id) unlinkSync(join(directory, "job.json")); } catch { }
        this.installJob = undefined;
      }
      // A staging permission failure can also prevent saving the status. Keep
      // the runtime idle/error result available so it can be repaired and retried.
      try { this.save(); } catch { }
    } finally {
      // Release responses even when opening the staging file failed before its
      // stream was consumed. This controller belongs only to the download; the
      // detached installer worker never receives it.
      abort.abort();
      await response?.body?.cancel().catch(() => {});
      await rm(path + ".part", { force: true }).catch(() => {});
    }
  }
  private async launch(path: string, release: UpdateRelease) {
    const worker = fileURLToPath(new URL("./update-worker.mjs", import.meta.url));
    const job = join(this.options.directory, "updates", "job.json");
    const value = { id: randomUUID(), startedAt: this.now(), installer: path, sha256: release.sha256, version: release.version,
      root: this.options.installRoot, directory: this.options.directory, port: this.options.port, workerPid: undefined as number | undefined };
    this.installJob = value;
    writeFileSync(job, JSON.stringify(value), { mode: 0o600 });
    const child = spawn(process.execPath, [worker, job], { cwd: this.options.payloadRoot, detached: true, stdio: "ignore", windowsHide: true, shell: false });
    await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); }); child.unref();
    value.workerPid = child.pid;
    const pending = job + ".pending-" + value.id;
    // The worker also persists its identity. Once spawned, an optional PID
    // bookkeeping failure must not unlock a still-running installation.
    try { writeFileSync(pending, JSON.stringify(value), { mode: 0o600 }); renameSync(pending, job); } catch { }
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.abort?.abort(); await this.task?.catch(() => {}); }
}
