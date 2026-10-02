import type { BridgeApi } from "./client.js";
let qrDialog: HTMLDialogElement | undefined;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function ensureDialog() {
  if (qrDialog) return;
  qrDialog = document.createElement("dialog"); qrDialog.className = "pairing-dialog";
  const copyIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/></svg>';
  qrDialog.innerHTML = `<div class="dialog-heading"><h2>Phone connection</h2><button type="button" class="subtle" aria-label="Close connection details">✕</button></div>
    <p>On your phone, open Connection and enter these values.</p>
    <div class="pairing-content"><div class="pairing-details"><div class="pairing-fields">
      <div class="pairing-field"><label for="pairing-origin">Bridge URL</label><div class="pairing-control"><input id="pairing-origin" readonly spellcheck="false" aria-describedby="pairing-copy-status"/><button type="button" class="pairing-copy-button" data-copy-url aria-label="Copy URL" title="Copy URL">${copyIcon}</button></div></div>
      <div class="pairing-field"><label for="pairing-key">Connection key</label><div class="pairing-control"><input id="pairing-key" type="text" readonly spellcheck="false" autocomplete="off" aria-describedby="pairing-copy-status"/><button type="button" class="pairing-copy-button" data-copy-key aria-label="Copy connection key" title="Copy connection key">${copyIcon}</button></div></div>
    </div><p id="pairing-copy-status" class="caption" role="status"></p></div><img alt="Connection QR code"/></div>`;
  qrDialog.querySelector("button")!.onclick = () => qrDialog!.close(); document.body.append(qrDialog);
  qrDialog.addEventListener("close", () => {
    $<HTMLInputElement>("pairing-key").value = ""; qrDialog!.querySelector("img")!.removeAttribute("src");
  });
  async function copyPairingField(id: string, label: string) {
    const field = $<HTMLInputElement | HTMLTextAreaElement>(id);
    try { await navigator.clipboard.writeText(field.value); $("pairing-copy-status").textContent = `${label} copied.`; }
    catch { field.focus(); field.select(); $("pairing-copy-status").textContent = "Selected. Press Ctrl+C to copy."; }
  }
  qrDialog.querySelector<HTMLButtonElement>("[data-copy-key]")!.onclick = () => { void copyPairingField("pairing-key", "Connection key"); };
  qrDialog.querySelector<HTMLButtonElement>("[data-copy-url]")!.onclick = () => { void copyPairingField("pairing-origin", "URL"); };
}
export async function showPairing(client: BridgeApi) {
  ensureDialog();
  const pairing = await client.request("/api/pairing") as { image: string; url: string; registrationUrl: string };
  $<HTMLInputElement>("pairing-origin").value = new URL(pairing.registrationUrl).origin;
  $<HTMLInputElement>("pairing-key").value = new URLSearchParams(new URL(pairing.url).hash.slice(1)).get("pilot-token") || "";
  $("pairing-copy-status").textContent = "";
  qrDialog!.querySelector("img")!.src = pairing.image;
  qrDialog!.showModal();
}
