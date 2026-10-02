import type { RuntimeState } from "../../../../packages/cockpit-state/types.js";
import { G2PresenceReporter } from "./presence.js";

export interface Connection {
  url: string;
  token: string;
}
export interface BridgeApi {
  request(path: string, data?: unknown, timeout?: number): Promise<any>;
  hosts?(): import("../../../../packages/cockpit-state/types.js").HostSource[];
  activeUrl?(): string | undefined;
}
export function connectionFailure(connection: Connection, error: unknown): Error {
  if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) {
    const page = typeof location === "undefined" ? undefined : location;
    if (page?.protocol === "https:" && new URL(connection.url).protocol === "http:")
      return new Error("This HTTPS page cannot reach an HTTP bridge. Configure an HTTPS bridge URL.");
    return new Error(`Cannot reach ${connection.url}. Check that this address is included in the installed Hub package’s network whitelist and the bridge is reachable. App origin: ${page?.origin || "unknown"}`);
  }
  return error instanceof Error ? error : new Error("Could not connect to the bridge");
}
export class BridgeClient {
  private controller?: AbortController;
  private stopped = true;
  private cursor = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private presence?: G2PresenceReporter;
  constructor(
    private connection: Connection,
    private onState: (state: RuntimeState) => void,
    private onConnection: (connected: boolean, message?: string) => void,
    private onCompletion: (value: {
      id: number;
      outcome: string;
      session: string;
    }) => void,
  ) {}
  async request(path: string, data?: unknown, timeout = 35_000) {
    let response: Response;
    try { response = await fetch(this.connection.url + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.connection.token}`,
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(timeout), credentials: "omit", redirect: "error",
    }); } catch (error) { throw connectionFailure(this.connection, error); }
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || `Bridge returned ${response.status}`);
    return result;
  }
  async verify(): Promise<RuntimeState> {
    const state = await this.request("/api/state", undefined, 12_000);
    if (!state || typeof state.connected !== "boolean" || !state.session || !state.main || !Array.isArray(state.transcript))
      throw new Error("This address did not return an Even-Pilot backend");
    return state;
  }
  setViewedSession(key?: string) {
    if (!this.presence && key) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
      this.presence = new G2PresenceReporter(data => this.request("/api/g2/view", data, 4000), id);
    }
    this.presence?.set(key);
  }
  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    this.presence?.resume();
    void this.stream();
  }
  disconnect() {
    this.presence?.suspend();
    this.stopped = true;
    this.generation++;
    clearTimeout(this.retry);
    this.controller?.abort();
  }
  reconnect() { this.disconnect(); this.connect(); }
  private async stream() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.generation;
    const current = () => !this.stopped && this.generation === generation && this.controller === controller;
    let watchdog: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), 40_000);
    };
    touch();
    try {
      const response = await fetch(this.connection.url + "/api/events", {
        headers: {
          Authorization: `Bearer ${this.connection.token}`,
          "Last-Event-ID": String(this.cursor),
        },
        signal: controller.signal,
        credentials: "omit", redirect: "error",
      });
      if (!response.ok || !response.body)
        throw new Error(
          response.status === 401
            ? "Check your control token"
            : `Bridge returned ${response.status}`,
        );
      if (!current()) return;
      this.onConnection(true);
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (!current()) return;
        if (done) throw new Error("Bridge connection closed");
        touch();
        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        if (buffer.length > 2_000_000) throw new Error("Bridge event exceeds its size limit");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const lines = buffer.slice(0, end).split("\n");
          buffer = buffer.slice(end + 2);
          const event = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          const raw = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (event === "state") this.onState(data);
          if (event === "completion" && data.id > this.cursor) {
            this.cursor = data.id;
            this.onCompletion(data);
          }
        }
      }
    } catch (error) {
      if (current())
        this.onConnection(
          false,
          connectionFailure(this.connection, error).message,
        );
    } finally {
      clearTimeout(watchdog!);
      // A malformed event or a throwing observer must also release its stream
      // before reconnecting; otherwise old requests remain alive on the bridge.
      controller.abort();
    }
    if (current()) this.retry = setTimeout(() => void this.stream(), 2_000);
  }
}
