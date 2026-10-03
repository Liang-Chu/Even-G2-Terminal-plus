import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";

type RequestFactory = (url: URL, options: RequestOptions, receive: (response: IncomingMessage) => void) => ClientRequest;
const addressErrors = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED"]);

/** Updater-only Windows transport. Some Windows dual-stack resolvers return a
 * home router for an IPv4-only host. Resolve a family explicitly while keeping
 * normal CA, hostname and SNI verification; never pin an address or retry TLS errors. */
export async function windowsUpdateFetch(input: string | URL, init: RequestInit = {}, request: RequestFactory = httpsRequest): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || init.body != null)
    throw new TypeError("Invalid update HTTPS request");
  const method = init.method || "GET";
  if (!["GET", "HEAD"].includes(method) || init.redirect === "follow") throw new TypeError("Unsupported update request");
  const headers = new Headers(init.headers);
  headers.set("Accept-Encoding", "identity");
  if (!headers.has("User-Agent")) headers.set("User-Agent", "Even-Pilot");
  const attempt = (family: 4 | 6) => new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) { reject(init.signal.reason || new DOMException("Aborted", "AbortError")); return; }
    const connection = request(url, { family, method, headers: Object.fromEntries(headers),
      servername: url.hostname, rejectUnauthorized: true, maxHeaderSize: 32_768, signal: init.signal || undefined }, incoming => {
      const status = incoming.statusCode || 0;
      if (init.redirect === "error" && [301, 302, 303, 307, 308].includes(status)) {
        incoming.destroy(); reject(new TypeError("Update redirect was rejected")); return;
      }
      try {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        const empty = method === "HEAD" || [204, 205, 304].includes(status);
        if (empty) incoming.resume();
        const response = new Response(empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          { status, statusText: incoming.statusMessage, headers: responseHeaders });
        Object.defineProperty(response, "url", { value: url.href });
        resolve(response);
      } catch (error) { incoming.destroy(); reject(error); }
    });
    connection.on("error", reject);
    connection.end();
  });
  try { return await attempt(4); }
  catch (error: any) {
    // Support IPv6-only Windows networks, but never turn certificate, body or
    // cancellation failures into a retry through another route.
    if (!init.signal?.aborted && addressErrors.has(error?.code)) return attempt(6);
    throw error;
  }
}

export const fetchUpdateResource = (input: string | URL, init?: RequestInit) =>
  process.platform === "win32" ? windowsUpdateFetch(input, init) : fetch(input, init);
