import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

/** A local, authenticated link to the native TUI. No turn or approval is ever retried. */
export async function codexTerminalLink(upstreamUrl: string, token: string,
  onSession: (result: any) => void, onEvent: (message: any) => void = () => {},
  onRequest?: (message: any, respond: (result: unknown) => void) => (() => void) | undefined) {
  const upstreams = new Set<WebSocket>();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 32_000_000,
    verifyClient: (info: { origin: string; req: IncomingMessage }) => {
      const actual = Buffer.from(info.req.headers.authorization || ""), expected = Buffer.from("Bearer " + token);
      return !info.origin && actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  });
  await new Promise<void>((done, fail) => { server.once("listening", done); server.once("error", fail); });
  server.on("connection", client => {
    const upstream = new WebSocket(upstreamUrl, { headers: { Authorization: "Bearer " + token }, maxPayload: 32_000_000 });
    upstreams.add(upstream);
    const queue: string[] = [], pending = new Map<string, any>();
    let queuedBytes = 0;
    const requests = new Map<string, { claimed: boolean; remove?: () => void }>();
    client.on("message", raw => {
      const text = raw.toString();
      let request: any; try { request = JSON.parse(text); } catch { client.close(1007); return; }
      if (request?.id !== undefined && !request.method) {
        const remote = requests.get(String(request.id));
        if (remote) {
          if (remote.claimed) return;
          remote.claimed = true; remote.remove?.();
        }
      }
      if (request && request.id !== undefined && ["thread/start", "thread/resume", "thread/fork"].includes(request.method)) {
        pending.set(String(request.id), request);
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else if (queue.length < 100 && queuedBytes + Buffer.byteLength(text) <= 32_000_000) {
        queue.push(text); queuedBytes += Buffer.byteLength(text);
      } else client.close(1009);
    });
    upstream.on("open", () => { for (const text of queue.splice(0)) upstream.send(text); queuedBytes = 0; });
    upstream.on("message", raw => {
      let message: any; try { message = JSON.parse(raw.toString()); } catch { client.close(1007); return; }
      if (message?.method === "serverRequest/resolved") {
        const key = String(message.params?.requestId);
        const request = requests.get(key); if (request) { request.claimed = true; request.remove?.(); }
      }
      if (message?.method && message.id !== undefined && onRequest) {
        const key = String(message.id), request = { claimed: false } as { claimed: boolean; remove?: () => void };
        requests.get(key)?.remove?.(); requests.set(key, request);
        try { request.remove = onRequest(message, result => {
          if (requests.get(key) !== request || request.claimed || upstream.readyState !== WebSocket.OPEN)
            throw new Error("This request was answered or the terminal disconnected");
          request.claimed = true; request.remove?.();
          upstream.send(JSON.stringify({ id: message.id, result }));
        }); } catch { /* Unsupported forms remain fully usable in Terminal. */ }
        if (requests.size > 256) {
          for (const [id, value] of requests) if (value.claimed) { requests.delete(id); if (requests.size <= 128) break; }
        }
      }
      const request = message?.method ? undefined : pending.get(String(message?.id));
      // Observation must never alter or interrupt native terminal traffic, even
      // when a new CLI version emits an event the monitor cannot normalize.
      try { if (message?.method) onEvent(message); } catch {}
      if (request) {
        pending.delete(String(message.id));
        try {
          if (!message.error && !request.params?.ephemeral && !request.params?.serviceName) onSession(message.result);
        } catch {}
      }
      if (client.readyState === WebSocket.OPEN) client.send(raw.toString());
    });
    client.on("error", () => upstream.close());
    client.on("close", () => { pending.clear(); for (const value of requests.values()) value.remove?.(); requests.clear(); upstream.close(); });
    upstream.on("error", () => client.close(1011));
    upstream.on("close", () => { upstreams.delete(upstream); client.close(); });
  });
  return { url: "ws://127.0.0.1:" + (server.address() as { port: number }).port,
    close() { for (const client of server.clients) client.terminate(); for (const upstream of upstreams) upstream.terminate(); server.close(); },
  };
}
