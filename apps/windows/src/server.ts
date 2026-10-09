import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { RuntimeController } from "../../../packages/pi-runtime/controller.js";
import { record } from "../../../packages/pi-runtime/event-normalizer.js";
import { SessionError, canonicalPath } from "../../../packages/pi-runtime/sessions.js";
import type { NotificationJournal } from "./notifications.js";
import { PushError, type GlancePush } from "./push.js";
import type { NativeHost } from "../../../packages/pi-runtime/native-host.js";
import { pairingDetails } from "./pairing.js";
import { g2Prompt } from "../../../packages/cockpit-state/g2-reply.js";
import { isTunnel } from "../../../packages/connectors/identity.js";
import type { InteractionAnswer } from "../../../packages/cockpit-state/interactions.js";
import type { HostSource } from "../../../packages/cockpit-state/types.js";
import type { NotificationRelay } from "./notification-relay.js";
import { UpdateError, type UpdateService } from "./updates.js";
import { ComputerDirectoryError, type ComputerDirectory } from "./computers.js";

export interface ServerOptions {
  token: string;
  notificationToken: string;
  allowedOrigins?: string[];
  staticDir?: string;
  push?: GlancePush;
  relay?: NotificationRelay;
  updates?: UpdateService;
  host?: NativeHost;
  shutdown?: () => Promise<void>;
  isReady?: () => boolean;
  pairOrigin?: string;
  hostInfo?: () => Promise<HostSource>;
  computers?: ComputerDirectory;
}
function matches(value: string, expected: string) {
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function json(res: ServerResponse, code: number, value?: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new Error("Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128_000) throw new Error("Request body exceeds 128 KB");
    chunks.push(chunk);
  }
  const value = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!value) throw new Error("Expected a JSON object");
  return value;
}
export function createBridgeServer(
  runtime: RuntimeController,
  notifications: NotificationJournal,
  options: ServerOptions,
) {
  const streams = new Set<ServerResponse>();
  const pinnedStreams = new Set<ServerResponse>();
  const send = (
    res: ServerResponse,
    event: string,
    data: unknown,
    id?: number,
  ) => {
    if (res.destroyed || res.writableLength > 2_000_000) {
      res.destroy();
      return;
    }
    res.write(
      `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  };
  let broadcastTimer: NodeJS.Timeout | undefined;
  const unsubscribe = runtime.store.subscribe(() => {
    if (!broadcastTimer)
      broadcastTimer = setTimeout(() => {
        broadcastTimer = undefined;
        for (const res of streams) send(res, "state", runtime.store.state);
      }, 50);
  });
  const unnotify = notifications.subscribe((event) => {
    if (event.kind === "attention" || event.kind === "attention-resolved") return;
    for (const res of streams) send(res, "completion", event, event.id);
  });
  const heartbeat = setInterval(() => {
    for (const res of streams) send(res, "heartbeat", { at: Date.now() });
  }, 15_000);
  heartbeat.unref();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const api = url.pathname.startsWith("/api/");
      const credential = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7) : "";
      const control = matches(credential, options.token);
      const authenticated = control || matches(credential, options.notificationToken);
      const origin = req.headers.origin;
      const ownOrigin = `http://${req.headers.host}`;
      // Installed Hub builds have a host-owned WebView origin, not the PC's origin.
      // A paired client proves access with its bearer key, never cookies. Preflight
      // only permits sending that header; it grants no access to an API response.
      const requestedHeaders = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(value => value.trim());
      const pairedPreflight = api && req.method === "OPTIONS" &&
        ["GET", "POST"].includes(String(req.headers["access-control-request-method"])) &&
        requestedHeaders.includes("authorization") &&
        requestedHeaders.every(value => ["authorization", "content-type", "last-event-id"].includes(value));
      if (
        origin &&
        origin !== ownOrigin &&
        !options.allowedOrigins?.includes(origin) &&
        !(api && authenticated) && !pairedPreflight
      ) {
        json(res, 403, {
          error: "Origin is not allowed; configure --allow-origin",
        });
        return;
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Last-Event-ID",
        );
        res.writeHead(204);
        res.end();
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" || !options.staticDir) {
          json(res, 404, { error: "Not found" });
          return;
        }
        const root = resolve(options.staticDir);
        const file = resolve(
          root,
          "." +
            decodeURIComponent(
              url.pathname === "/" ? "/index.html" : url.pathname,
            ),
        );
        if (!file.startsWith(root + sep)) {
          json(res, 403, { error: "Forbidden" });
          return;
        }
        try {
          const actualRoot = canonicalPath(await realpath(root));
          if (!canonicalPath(await realpath(file)).startsWith(actualRoot + sep)) {
            json(res, 403, { error: "Forbidden" }); return;
          }
          const data = await readFile(file);
          const mime: Record<string, string> = {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          };
          res.writeHead(200, {
            "Content-Type": mime[extname(file)] || "application/octet-stream",
          });
          res.end(data);
        } catch {
          json(res, 404, {
            error: "Build the Even Hub app with npm run build first",
          });
        }
        return;
      }
      if (req.method === "POST" && ["/api/glance/relay/event", "/api/glance/relay/probe"].includes(url.pathname)) {
        if (!options.relay || options.isReady && !options.isReady()) { json(res, 503, { error: "Relay is not ready" }); return; }
        json(res, 200, url.pathname.endsWith("/probe") ? options.relay.probe(credential) : options.relay.receive(credential, await body(req)));
        return;
      }
      if (!authenticated) {
        json(res, 401, { error: "A valid bearer token is required" });
        return;
      }
      const readOnlyPaths = ["/api/glance", "/api/completions"];
      if (!control && !readOnlyPaths.includes(url.pathname)) {
        json(res, 403, { error: "This endpoint requires the control token" });
        return;
      }
      if (options.isReady && !options.isReady()) {
        json(res, 503, { error: "Bridge is starting or shutting down; retry shortly" }); return;
      }
      if (url.pathname === "/api/computers") {
        if (!options.computers) { json(res, 503, { error: "Shared computer connections are unavailable; update this backend" }); return; }
        if (req.method === "GET") { json(res, 200, await options.computers.snapshot()); return; }
        if (req.method === "POST") {
          let data: Record<string, unknown>;
          try { data = await body(req); } catch { throw new ComputerDirectoryError("Invalid saved computer data"); }
          json(res, 200, await options.computers.merge(data)); return;
        }
      }
      if (options.updates) {
        if (req.method === "GET" && url.pathname === "/api/updates") { json(res, 200, options.updates.status()); return; }
        if (req.method === "POST" && url.pathname === "/api/updates/settings") { json(res, 200, options.updates.configure((await body(req)).automaticChecks)); return; }
        if (req.method === "POST" && url.pathname === "/api/updates/check") { json(res, 200, await options.updates.check()); return; }
        if (req.method === "POST" && url.pathname === "/api/updates/install") { json(res, 202, options.updates.install((await body(req)).version)); return; }
      }
      if (url.pathname === "/api/glance/routing" && options.relay) {
        if (req.method === "GET") { json(res, 200, options.relay.status()); return; }
        if (req.method === "POST") { json(res, 200, await options.relay.configure(await body(req))); return; }
      }
      if (req.method === "POST" && options.relay && url.pathname === "/api/glance/relay/register") {
        json(res, 200, options.relay.register(await body(req))); return;
      }
      if (req.method === "POST" && options.relay && url.pathname === "/api/glance/relay/revoke") {
        options.relay.revoke((await body(req)).sourceId); json(res, 200, { ok: true }); return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        json(res, 200, runtime.store.state);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/host") {
        if (!options.hostInfo) { json(res, 503, { error: "Host identity unavailable" }); return; }
        json(res, 200, await options.hostInfo()); return;
      }
      if (req.method === "POST" && url.pathname === "/api/g2/view") {
        notifications.g2.update(await body(req));
        json(res, 200, { ok: true }); return;
      }
      if (req.method === "GET" && url.pathname === "/api/pairing") {
        if (!options.pairOrigin) { json(res, 503, { error: "No phone-reachable address available; connect LAN or Tailscale first" }); return; }
        json(res, 200, pairingDetails(options.pairOrigin, options.token)); return;
      }
      if (req.method === "GET" && url.pathname === "/api/monitoring") {
        json(res, 200, { ...runtime.store.state.monitoring, concurrentSessions: Boolean(runtime.concurrentSessions), nativeTerminals: runtime.store.state.nativeTerminals === true }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/desktop/open") {
        if (!options.host || !("applyDesktopDefaults" in options.host)) {
          json(res, 409, { error: "Restart the native desktop backend to apply startup watch defaults" }); return;
        }
        const data = await body(req);
        if (typeof data.openId !== "string") throw new Error("openId is required");
        json(res, 200, await options.host.applyDesktopDefaults(data.openId)); return;
      }
      if (req.method === "POST" && url.pathname === "/api/shutdown" && options.shutdown) {
        json(res, 200, { ok: true }); setImmediate(() => { void options.shutdown!(); }); return;
      }
      const livePath = /^\/api\/runtime\/([a-f0-9]{32})\/(state|events|prompt|interrupt|monitor|terminal)$/.exec(url.pathname);
      if (livePath && options.host) {
        const [, key, action] = livePath;
        if (req.method === "POST" && action === "monitor") {
          const data = await body(req);
          if (typeof data.monitored !== "boolean") throw new Error("monitored must be boolean");
          await options.host.setMonitored(key, data.monitored);
          json(res, 200, runtime.store.state); return;
        }
        if (req.method === "POST" && action === "terminal") {
          const opened = await options.host.openMonitoredSession(key);
          json(res, 200, { key: opened }); return;
        }
        const target = options.host.getRuntime(key);
        if (req.method === "GET" && action === "state") { json(res, 200, target.store.state); return; }
        if (req.method === "GET" && action === "events") {
          res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
          res.flushHeaders(); streams.add(res);
          send(res, "state", target.store.state);
          // Pinned terminal streams subscribe only to their own runtime.
          streams.delete(res);
          let pending: NodeJS.Timeout | undefined;
          const update = target.store.subscribe(() => {
            if (!target.store.state.connected) {
              clearTimeout(pending); pending = undefined;
              send(res, "state", target.store.state); res.end(); return;
            }
            if (!pending) pending = setTimeout(() => {
            pending = undefined; send(res, "state", target.store.state);
            if (!target.store.state.connected) res.end();
          }, 30); });
          const pulse = setInterval(() => send(res, "heartbeat", {}), 15_000); pulse.unref();
          const close = () => { clearTimeout(pending); clearInterval(pulse); update(); pinnedStreams.delete(res); };
          pinnedStreams.add(res); res.on("close", close); return;
        }
        if (req.method === "POST" && action === "prompt") { const data = await body(req); if (typeof data.text !== "string") throw new Error("text is required"); await target.prompt(data.text); json(res, 202, { accepted: true }); return; }
        if (req.method === "POST" && action === "interrupt") { await target.interrupt(); json(res, 200, { ok: true }); return; }
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        json(res, 200, await runtime.listSessions(url.searchParams.get("cwd") ?? undefined));
        return;
      }
      const historyPath = /^\/api\/sessions\/([^/]+)\/history$/.exec(url.pathname);
      if (req.method === "GET" && historyPath) {
        json(res, 200, await runtime.sessionHistory(historyPath[1]));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/completions") {
        const after = Number(url.searchParams.get("after") || "0");
        if (!Number.isSafeInteger(after) || after < 0)
          throw new Error("after must be a non-negative integer");
        json(res, 200, { events: notifications.list(after).filter(event => event.kind !== "attention" && event.kind !== "attention-resolved") });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        streams.add(res);
        send(res, "state", runtime.store.state);
        const cursor = Number(
          req.headers["last-event-id"] || url.searchParams.get("after") || "0",
        );
        for (const event of notifications.list(
          Number.isSafeInteger(cursor) ? cursor : 0,
        ).filter(event => event.kind !== "attention" && event.kind !== "attention-resolved"))
          send(res, "completion", event, event.id);
        res.on("close", () => streams.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/glance") {
        const data = await body(req);
        if (data.operation !== undefined) {
          if (data.operation !== "register_push" && data.operation !== "unregister_push")
            throw new PushError("Unknown Glance operation");
          if (!options.push) throw new PushError("Push registration is unavailable on this bridge", 503);
          if (data.operation === "register_push") options.push.register(data);
          else options.push.unregister(data);
          res.writeHead(204); res.end();
          return;
        }
        if (
          typeof data.watcher !== "string" ||
          !data.watcher.trim() ||
          data.watcher.length > 128
        )
          throw new Error(
            "watcher must be a non-empty name up to 128 characters",
          );
        for (const key of ["max_length", "title_max_length"]) {
          if (
            !Number.isInteger(data[key]) ||
            Number(data[key]) < 1 ||
            Number(data[key]) > 10_000
          )
            throw new Error(`${key} must be an integer from 1 to 10000`);
        }
        const notification = notifications.poll(
          data.watcher,
          Number(data.max_length),
          Number(data.title_max_length),
        );
        json(res, notification ? 200 : 204, notification);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/glance/push") {
        if (!options.push) throw new PushError("Push is unavailable on this bridge", 503);
        json(res, 200, options.push.status());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/glance/push/test") {
        if (!options.push) throw new PushError("Push is unavailable on this bridge", 503);
        const result = options.push.test(await body(req));
        json(res, result.status === "queued" ? 202 : 200, result);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/interaction/respond") {
        const data = await body(req);
        if (typeof data.sessionKey !== "string" || data.sessionKey !== runtime.store.state.session.key)
          throw new SessionError("The selected session changed", 409);
        if (!options.host || !("getRuntime" in options.host) || typeof data.requestId !== "string")
          throw new SessionError("This connector does not support remote choices");
        const target = options.host.getRuntime(data.sessionKey);
        if (!("respond" in target)) throw new SessionError("Update the native connector to answer choices");
        await target.respond({ requestId: data.requestId, answers: data.answers, cancel: data.cancel } as InteractionAnswer);
        json(res, 200, { status: "submitted" }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/prompt") {
        const data = await body(req);
        if (typeof data.text !== "string") throw new Error("text is required");
        if (data.source !== undefined && !["g2", "hub", "desktop"].includes(data.source as string)) throw new SessionError("Invalid prompt source");
        if (!data.text.trim() || data.text.length > 32_000) throw new SessionError("Enter a prompt between 1 and 32,000 characters");
        if (data.sessionKey !== undefined && (typeof data.sessionKey !== "string" || data.sessionKey !== runtime.store.state.session.key))
          throw new SessionError("The selected session changed. Review your prompt before sending again.", 409);
        const prompt = data.source === "g2" ? g2Prompt(data.text) : data.text;
        if (prompt.length > 32_000) throw new SessionError("G2 prompt is too long; shorten it to leave room for the summary instructions");
        await runtime.prompt(prompt);
        json(res, 202, { accepted: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/session/new") {
        const data = !req.headers["transfer-encoding"] && (!req.headers["content-length"] || req.headers["content-length"] === "0")
          ? {} : await body(req);
        if (data.cwd !== undefined && typeof data.cwd !== "string") throw new SessionError("cwd must be a string");
        if (data.name !== undefined && typeof data.name !== "string") throw new SessionError("name must be a string");
        if (data.tunnel !== undefined && !isTunnel(data.tunnel)) throw new SessionError("Unknown tunnel");
        if (data.tunnel && data.tunnel !== "pi" && !(options.host && "selectWatchedSession" in options.host)) throw new SessionError("Start the native desktop backend to use this tunnel");
        const sessionOptions = { cwd: data.cwd as string | undefined, name: data.name as string | undefined,
          tunnel: isTunnel(data.tunnel) ? data.tunnel : undefined };
        await runtime.newSession(sessionOptions);
        json(res, 200, runtime.store.state);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/session/resume") {
        const data = await body(req);
        if (typeof data.key !== "string") throw new SessionError("key is required; select a discovered session");
        if (data.watchedOnly === true) {
          if (!options.host || !("selectWatchedSession" in options.host)) throw new SessionError("Restart the current native desktop backend", 409);
          await options.host.selectWatchedSession(data.key);
        } else await runtime.resumeSession(data.key);
        json(res, 200, runtime.store.state);
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent)
        json(res, error instanceof UpdateError ? error.status : error instanceof SessionError || error instanceof PushError || error instanceof ComputerDirectoryError ? error.statusCode : 400, {
          error: error instanceof Error ? error.message : "Request failed",
        });
      else res.end();
    }
  });
  server.requestTimeout = 35_000;
  const cleanup = () => {
    unsubscribe();
    unnotify();
    clearInterval(heartbeat);
    clearTimeout(broadcastTimer);
  };
  server.on("close", cleanup);
  let closing: Promise<void> | undefined;
  return {
    server,
    close: () => closing ??= (async () => {
      cleanup();
      for (const stream of [...streams, ...pinnedStreams]) stream.end();
      await new Promise<void>((resolve, reject) => {
        // Allow the shutdown response to drain, then close stalled phone/SSE
        // connections. Otherwise the stopped HTTP listener can retain the
        // backend lock indefinitely and prevent the replacement from starting.
        const deadline = setTimeout(() => server.closeAllConnections(), 1_000);
        server.close((error: NodeJS.ErrnoException | undefined) => {
          clearTimeout(deadline);
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      });
    })(),
  };
}
