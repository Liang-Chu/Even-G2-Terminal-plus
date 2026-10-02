export interface G2Frame { prefix: string; title: string; body: string; status: string; footer: string; bodyPadding?: number; list?: { labels: string[]; selected: number } }
export interface G2Tile { id: number; name: string; png: string }
export interface G2Renderer {
  pages(text: string): string[];
  render(frame: G2Frame, now: number, encodeImages?: boolean): G2Tile[];
  canvas?: HTMLCanvasElement;
}
export const G2_LAYOUT = { width: 576, height: 288, small: 16, body: 22, bodyY: 42, lineHeight: 28, rows: 7 };
// Native text scrollbars can overlay the right edge. Keep reading text inset;
// SDK padding is uniform, and applies only to the expanded message body.
export const G2_READING_PADDING = 12;
// Both bars use the same small font. Native text has no font-size control.
// Four small strips avoid sending pixels for the native conversation list.
export const G2_IMAGE_REGIONS = [
  { x: 0, y: 0, width: 288, height: 34 }, { x: 288, y: 0, width: 288, height: 34 },
  { x: 0, y: 262, width: 288, height: 26 }, { x: 288, y: 262, width: 288, height: 26 },
];

/** Pixel-measured wrapping keeps CJK and proportional fonts inside the display. */
export function measuredPages(text: string, measure: (text: string) => number, width = 560, rows = 7): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const token of paragraph.match(/\S+|\s+/gu) || []) {
      if (line && measure(line + token) > width && measure(token) <= width) { lines.push(line.trimEnd()); line = ""; }
      for (const character of token) {
        if (!line && /\s/u.test(character)) continue;
        if (line && measure(line + character) > width) { lines.push(line.trimEnd()); line = ""; }
        line += character;
      }
    }
    lines.push(line.trimEnd());
  }
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows).join("\n"));
  return pages.length ? pages : [""];
}

/** Static, pixel-bounded labels avoid continuous decorative BLE image traffic. */
export function fitText(text: string, measure: (text: string) => number, width: number): string {
  const suffix = "...";
  if (width <= 0) return "";
  if (measure(text) <= width) return text;
  if (measure(suffix) > width) return "";
  const chars = Array.from(text);
  let low = 0, high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(chars.slice(0, middle).join("") + suffix) <= width) low = middle;
    else high = middle - 1;
  }
  return chars.slice(0, low).join("") + suffix;
}

/** Images contain only header/footer; the native message layer sits above them. */
export class CanvasG2Renderer implements G2Renderer {
  readonly canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private tiles = Array.from({ length: 4 }, () => document.createElement("canvas"));
  private chromeKeys: string[] = [];
  private encodedTiles: G2Tile[] = [];
  private fittedTitle?: { text: string; width: number; value: string };
  constructor() {
    this.canvas.width = 576; this.canvas.height = 288;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("G2 canvas is unavailable");
    this.context = context;
    this.tiles.forEach((tile, index) => { tile.width = G2_IMAGE_REGIONS[index].width; tile.height = G2_IMAGE_REGIONS[index].height; });
  }
  private font(size: number) { this.context.font = `${size}px Arial, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`; }
  pages(text: string) { this.font(G2_LAYOUT.body); return measuredPages(text, value => this.context.measureText(value).width); }
  render(frame: G2Frame, _now: number, encodeImages = true): G2Tile[] {
    const c = this.context;
    c.fillStyle = "#000"; c.fillRect(0, 0, 576, 288); c.textBaseline = "top"; c.fillStyle = "#fff";
    this.font(G2_LAYOUT.small); c.fillText(frame.prefix, 8, 7);
    const titleX = 8 + c.measureText(frame.prefix).width + 8, available = Math.max(0, 568 - titleX);
    c.save(); c.beginPath(); c.rect(titleX, 0, available, 30); c.clip();
    if (this.fittedTitle?.text !== frame.title || this.fittedTitle.width !== available)
      this.fittedTitle = { text: frame.title, width: available, value: fitText(frame.title, value => c.measureText(value).width, available) };
    const title = this.fittedTitle.value;
    c.fillText(title, titleX, 7); c.restore();
    c.fillStyle = "#aaa"; c.fillRect(8, 31, 560, 1);
    c.fillRect(8, 262, 560, 1);
    const footer = fitText(frame.footer, value => c.measureText(value).width, 560);
    c.fillStyle = "#fff"; c.fillText(footer, 8, 269);
    // Only the small header/footer strips are encoded. Native list focus and
    // rows are preview-only, so a swipe requires no image or page write.
    const images = encodeImages ? this.tiles.map((tile, index) => {
      const { x, y, width, height } = G2_IMAGE_REGIONS[index];
      const key = JSON.stringify(index < 2 ? [frame.prefix, title] : footer);
      if (key === this.chromeKeys[index]) return this.encodedTiles[index];
      tile.getContext("2d")!.drawImage(this.canvas, x, y, width, height, 0, 0, width, height);
      this.chromeKeys[index] = key;
      return this.encodedTiles[index] = { id: index + 2, name: `pilot-img-${index}`, png: tile.toDataURL("image/png") };
    }) : [];

    c.fillStyle = "#fff"; this.font(G2_LAYOUT.body);
    const padding = frame.bodyPadding || 0;
    const lines = !frame.list && frame.body ? measuredPages(frame.body, value => c.measureText(value).width, 560 - 2 * padding)[0].split("\n") : [];
    c.save(); c.beginPath(); c.rect(8 + padding, 38 + padding, 560 - 2 * padding, 222 - 2 * padding); c.clip();
    lines.forEach((line, i) => c.fillText(line, 8 + padding, G2_LAYOUT.bodyY + padding + i * G2_LAYOUT.lineHeight));
    c.restore();
    if (frame.list) {
      const start = Math.floor(frame.list.selected / 5) * 5;
      frame.list.labels.slice(start, start + 5).forEach((label, row) => {
        const y = 38 + row * 40;
        if (start + row === frame.list!.selected) {
          c.fillStyle = "#888";
          c.fillRect(8, y, 560, 1); c.fillRect(8, y + 39, 560, 1);
          c.fillRect(8, y, 1, 40); c.fillRect(567, y, 1, 40);
        }
        c.fillStyle = "#fff"; c.fillText(label, 16, y + 6);
      });
    }
    if (frame.status) {
      const y = G2_LAYOUT.bodyY + lines.length * G2_LAYOUT.lineHeight + 2;
      c.fillStyle = "#bbb"; c.beginPath(); c.moveTo(9, y + 3); c.lineTo(9, y + 13); c.lineTo(16, y + 8); c.closePath(); c.fill();
      this.font(G2_LAYOUT.small); c.fillText(frame.status, 23, y);
    }
    return images;
  }
}

export function pngBytes(dataUrl: string): Uint8Array {
  return Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), character => character.charCodeAt(0));
}
