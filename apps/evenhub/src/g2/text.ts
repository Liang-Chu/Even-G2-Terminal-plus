/** Plain, readable text for the glasses' text containers (not an HTML renderer). */
export function readableText(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n")
    .replace(/^\s*```[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]*[-*+]\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

const width = (character: string) => /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{1f000}-\u{1ffff}]/u.test(character) ? 2 : 1;
export function shortLine(text: string, columns = 46): string {
  let result = "", used = 0;
  for (const character of text.replace(/\s+/g, " ").trim()) {
    if (used + width(character) > columns) {
      const characters = Array.from(result);
      while (used + 1 > columns && characters.length) used -= width(characters.pop()!);
      return characters.join("") + "…";
    }
    result += character; used += width(character);
  }
  return result;
}

/** Six bounded lines fit below the fixed title/header; never split a surrogate pair. */
export function textPages(text: string, columns = 46, rows = 6): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) { if (lines.at(-1) !== "") lines.push(""); continue; }
    let line = "", used = 0;
    for (const token of paragraph.match(/\S+|\s+/gu) || []) {
      const size = Array.from(token).reduce((sum, char) => sum + width(char), 0);
      if (used && used + size > columns && size <= columns) { lines.push(line.trimEnd()); line = ""; used = 0; }
      for (const character of token) {
        if (!line && /\s/u.test(character)) continue;
        if (used + width(character) > columns) { lines.push(line.trimEnd()); line = ""; used = 0; }
        line += character; used += width(character);
      }
    }
    if (line) lines.push(line.trimEnd());
  }
  const pages: string[] = [];
  for (let index = 0; index < lines.length; index += rows) pages.push(lines.slice(index, index + rows).join("\n"));
  return pages.length ? pages : [""];
}
