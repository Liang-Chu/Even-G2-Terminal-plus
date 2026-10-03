import type { Connection } from "./client.js";
import type { FleetClient } from "./fleet.js";

/** The desktop restores only its serving computer; the phone restores its saved fleet. */
export async function restoreViewerConnections(
  client: Pick<FleetClient, "connections" | "remove" | "add" | "choose">,
  saved: Connection[], activeUrl?: string, servingOrigin?: string,
) {
  const connections = servingOrigin ? saved.filter(item => item.url === servingOrigin) : saved;
  for (const existing of client.connections()) if (!connections.some(item => item.url === existing.url)) client.remove(existing.url);
  for (const next of connections) {
    if (!client.connections().some(item => item.url === next.url && item.token === next.token)) await client.add(next, true, false);
  }
  const selected = servingOrigin || activeUrl;
  if (selected && client.connections().some(item => item.url === selected)) client.choose(selected);
}
