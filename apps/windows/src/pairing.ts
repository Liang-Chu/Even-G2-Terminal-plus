import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";

const require = createRequire(import.meta.url);
const qr = require("qr-image") as { imageSync(text: string, options: { type: "png"; size: number; margin: number }): Buffer };
const terminalQr = require("qrcode-terminal") as { generate(text: string, options: { small: boolean }, callback: (text: string) => void): void };

export function preferredPairOrigin(host: string, port: number): string | undefined {
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return;
  if (host !== "0.0.0.0") return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const addresses = Object.values(networkInterfaces()).flat().filter(address => address && address.family === "IPv4" && !address.internal).map(address => address!.address);
  const address = addresses.find(address => { const [a, b] = address.split(".").map(Number); return a === 100 && b >= 64 && b <= 127; }) || addresses.find(address => !address.startsWith("169.254."));
  return address ? `http://${address}:${port}` : undefined;
}

export function printPairingQr(origin: string, token: string) {
  terminalQr.generate(pairingUrl(origin, token), { small: true }, code => console.log(code));
}

export function pairingUrl(origin: string, token: string) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTP(S) bridge origin without a path, query or fragment");
  }
  if (token.length < 24 || token.length > 512 || /[\r\n]/.test(token)) throw new Error("Use the bridge control token, at least 24 characters");
  url.hash = new URLSearchParams({ "pilot-pair": "1", "pilot-token": token }).toString();
  return url.toString();
}
export function pairingDetails(origin: string, token: string) {
  const url = pairingUrl(origin, token);
  return { version: 1, url, registrationUrl: new URL("/api/glance", origin).href,
    image: "data:image/png;base64," + qr.imageSync(url, { type: "png", size: 6, margin: 4 }).toString("base64") };
}

export function savePairingQr(origin: string, token: string, output: string) {
  const url = pairingUrl(origin, token);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, qr.imageSync(url, { type: "png", size: 8, margin: 4 }), { mode: 0o600 });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    url: { type: "string" }, output: { type: "string", default: ".local/even-pilot-pairing.png" },
  } });
  try {
    if (!values.url) throw new Error("Usage: npm run pair -- --url http://<PC-LAN-or-Tailscale-IP>:4317; set EVEN_PILOT_TOKEN to the running bridge's control token first");
    const output = savePairingQr(values.url, process.env.EVEN_PILOT_TOKEN || "", resolve(values.output!));
    console.log(`Pairing QR saved: ${output}\nScan with the Even app's development QR scanner to open this bridge.\nThe image contains your control token; keep it private.`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
