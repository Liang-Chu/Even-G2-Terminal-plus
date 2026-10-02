/** Losslessly pack the pinned MIT-licensed Pretext tables at build time.
 * Measurement functions stay upstream; the phone decodes these small tables once.
 */
import type { Plugin } from "vite";

interface FontTable {
  name: string;
  glyphs?: Record<string, number>;
  ranges?: [number, number][];
  default_adv_w?: number;
  exceptions?: Record<string, number>;
  kern?: { right_cnt: number; cp_to_left: Record<string, number>; cp_to_right: Record<string, number>; values: number[] };
}

function integers(values: number[]): string {
  const bytes: number[] = [];
  for (let n of values) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 0x7fffffff) throw new Error("Unsupported Pretext integer");
    while (n >= 128) { bytes.push((n & 127) | 128); n >>>= 7; }
    bytes.push(n);
  }
  return JSON.stringify(Buffer.from(bytes).toString("base64"));
}
function map(value: Record<string, number>): string {
  let previous = 0;
  const values = Object.entries(value).flatMap(([key, width]) => {
    const point = Number(key), delta = point - previous; previous = point;
    return [delta, width];
  });
  return `unpackMap(${integers(values)})`;
}
export function compactPretext(source: string): string {
  const match = source.match(/^const fontData = ([\s\S]*?);(?=\s*const fonts = fontData.fonts)/);
  if (!match) throw new Error("Pretext data format changed; review the build transform");
  const data = JSON.parse(match[1]) as { line_height: number; fonts: FontTable[] };
  const fonts = data.fonts.map(font => {
    const fields = [`name:${JSON.stringify(font.name)}`];
    if (font.glyphs) fields.push(`glyphs:${map(font.glyphs)}`);
    if (font.ranges) {
      let previous = 0;
      const spans = font.ranges.flatMap(([start, end]: number[]) => {
        const gap = start - previous; previous = end; return [gap, end - start];
      });
      if (!font.exceptions || font.default_adv_w === undefined) throw new Error("Incomplete Pretext ranges");
      fields.push(`ranges:unpackRanges(${integers(spans)})`, `default_adv_w:${font.default_adv_w}`, `exceptions:${map(font.exceptions)}`);
    }
    if (font.kern) {
      const k = font.kern;
      if (!k.values.every((n: number) => Number.isInteger(n) && n >= -128 && n <= 127)) throw new Error("Unsupported Pretext kerning value");
      const bytes = JSON.stringify(Buffer.from(k.values).toString("base64"));
      fields.push(`kern:{right_cnt:${k.right_cnt},cp_to_left:${map(k.cp_to_left)},cp_to_right:${map(k.cp_to_right)},values:Array.from(atob(${bytes}),c=>(c.charCodeAt(0)<<24)>>24)}`);
    }
    return `{${fields.join(",")}}`;
  });
  const decode = `function unpackInts(s){const out=[];let n=0,shift=0;for(const c of atob(s)){const b=c.charCodeAt(0);n|=(b&127)<<shift;if(b&128){shift+=7}else{out.push(n);n=0;shift=0}}return out}
function unpackMap(s){const a=unpackInts(s),out={};let cp=0;for(let i=0;i<a.length;i+=2){cp+=a[i];out[cp]=a[i+1]}return out}
function unpackRanges(s){const a=unpackInts(s),out=[];let end=0;for(let i=0;i<a.length;i+=2){const start=end+a[i];end=start+a[i+1];out.push([start,end])}return out}
const fontData={line_height:${data.line_height},fonts:[${fonts.join(",")}]};`;
  return decode + source.slice(match[0].length);
}
export function compactPretextPlugin(): Plugin {
  return { name: "compact-pretext", enforce: "pre", transform(source, id) {
    if (id.replaceAll("\\", "/").endsWith("/@evenrealities/pretext/dist/font_measure.js")) return { code: compactPretext(source), map: null };
  } };
}
