import type { Connection } from "./client.js";

/** The token stays in the URL fragment, never in HTTP URLs or access logs. */
export function parsePairingUrl(value: string): Connection | undefined {
  const url = new URL(value);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("pilot-token");
  if (token === null) return;
  const desktopQuery = url.search === "?desktop=1";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || (url.search && !desktopQuery)) {
    throw new Error("Invalid Terminal+ pairing address");
  }
  if (fragment.getAll("pilot-token").length !== 1 || fragment.getAll("pilot-pair").length > 1 || (fragment.has("pilot-pair") && fragment.get("pilot-pair") !== "1")) throw new Error("Unsupported pairing code");
  if (token.length < 24 || token.length > 512 || /[\r\n]/.test(token)) throw new Error("Invalid Terminal+ pairing token");
  return { url: url.origin, token };
}

export function consumePairingUrl(): Connection | undefined {
  const connection = parsePairingUrl(location.href);
  if (!connection) return;
  // Remove the credential before creating UI links or starting any requests.
  history.replaceState(null, "", location.pathname + location.search);
  return connection;
}
