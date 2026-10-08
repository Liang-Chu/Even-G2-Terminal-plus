import type { Connection } from "./client.js";
import type { FleetClient } from "./fleet.js";

/** Every viewer connects directly to its explicitly saved computers. */
export async function restoreViewerConnections(
  client: Pick<FleetClient, "connections" | "remove" | "add" | "choose">,
  saved: Connection[], activeUrl?: string, servingOrigin?: string,
) {
  for (const existing of client.connections()) if (!saved.some(item => item.url === existing.url)) client.remove(existing.url);
  for (const next of saved) {
    if (!client.connections().some(item => item.url === next.url && item.token === next.token)) await client.add(next, true, false);
  }
  const connections = client.connections();
  const selected = connections.some(item => item.url === activeUrl) ? activeUrl : servingOrigin;
  if (selected && client.connections().some(item => item.url === selected)) client.choose(selected);
}
