import test from "node:test";
import assert from "node:assert/strict";
import { measuredPages } from "../apps/evenhub/src/g2/renderer.js";

test("lazy preview wrapping keeps the visible page identical without measuring offscreen paragraphs", () => {
  for (const text of [
    "An English reply with whole words and spaces. ".repeat(200),
    "这是一段需要在眼镜上滚动阅读的中文回复。".repeat(200),
    "\nShort line\n\n" + "A".repeat(3000),
    Array.from({ length: 200 }, (_, index) => `Paragraph ${index}: hello world.`).join("\n"),
  ]) {
    let fullCalls = 0, lazyCalls = 0;
    const width = (value: string) => Array.from(value).length * 10;
    const full = measuredPages(text, value => { fullCalls++; return width(value); }, 100, 7);
    const lazy = measuredPages(text, value => { lazyCalls++; return width(value); }, 100, 7, 1);
    assert.deepEqual(lazy, [full[0]]);
    assert.ok(lazyCalls < fullCalls / 10, "opening a reply measures only its first visible rows");
  }
});

test("lazy preview retains empty and short replies, including paragraph boundaries", () => {
  const width = (value: string) => value.length;
  for (const text of ["", "A short reply", "\n\n", "One\n\nTwo\nThree", "🙂 中文 reply"]) {
    assert.deepEqual(measuredPages(text, width, 30, 7, 1), measuredPages(text, width, 30, 7));
  }
});
