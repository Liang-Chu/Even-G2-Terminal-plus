import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PiCommand } from "../pi-runtime/resolve-pi.js";

/** JSON-RPC connection only. Closing it never sends an interrupt or thread deletion. */
export class AgentRpc extends EventEmitter {
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;
  constructor(private write: (message: string) => void, private dispose: () => void) { super(); }
  request(method: string, params: unknown = {}, timeout = 20_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Agent connection is closed"));
    const id = "even-pilot-" + ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + " was not confirmed; do not automatically retry a prompt")); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params?: unknown) { this.write(JSON.stringify({ method, ...(params === undefined ? {} : { params }) })); }
  respond(id: string | number, result: unknown) {
    if (this.closed) throw new Error("Agent connection is closed");
    this.write(JSON.stringify({ id, result }));
  }
  receive(raw: string) {
    let value: any;
    try { value = JSON.parse(raw); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.id !== undefined && !value.method) {
      const pending = this.pending.get(String(value.id)); if (!pending) return;
      this.pending.delete(String(value.id)); clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(String(value.error.message || "Agent request failed")));
      else pending.resolve(value.result);
    } else if (typeof value.method === "string") this.emit("event", value);
  }
  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Agent disconnected; delivery is not confirmed")); }
    this.pending.clear(); this.emit("disconnect");
  }
  close() { this.disconnect(); this.dispose(); }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "even_pilot", title: "Even-Pilot", version: "1.1.2" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
  }
}

export function stdioRpc(command: PiCommand, args: string[], env = process.env): { rpc: AgentRpc; child: ChildProcessWithoutNullStreams } {
  const child = spawn(command.command, [...command.args, ...args], { stdio: "pipe", windowsHide: true, shell: false, env });
  const rpc = new AgentRpc(message => child.stdin.write(message + "\n"), () => { child.stdin.end(); });
  child.stdin.on("error", () => rpc.disconnect());
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 32_000_000) { rpc.close(); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); rpc.receive(line); }
  });
  // Logs can contain project information; never forward them to the phone or console.
  child.stderr.resume();
  child.on("error", () => rpc.disconnect()); child.on("exit", () => rpc.disconnect());
  return { rpc, child };
}
