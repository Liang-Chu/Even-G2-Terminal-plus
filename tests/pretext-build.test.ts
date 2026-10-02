import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { compactPretext } from "../scripts/compact-pretext.js";

test("packed Pretext reconstructs every official glyph, range and kerning entry losslessly", async () => {
  const source = readFileSync(new URL("../node_modules/@evenrealities/pretext/dist/font_measure.js", import.meta.url), "utf8");
  const packed = compactPretext(source);
  const tables = (code: string) => JSON.parse(JSON.stringify(runInNewContext(
    code.slice(0, code.indexOf("const fonts = fontData.fonts")) + "\nfontData", { atob })));
  assert.deepEqual(tables(packed), tables(source));
  const original = await import("../node_modules/@evenrealities/pretext/dist/font_measure.js");
  const decoded = await import("data:text/javascript;base64," + Buffer.from(packed).toString("base64"));
  for (const text of ["AVATAR To WA ffi", "← 中文回复测试，可以继续 →", "😀ΩαЯé—…", "Ｗｉｄｅ and narrow iii", "\ud83d\ude80 unsupported\u{20000}", "", "Hello\n世界"])
    for (const width of [16, 100, 544]) {
      assert.equal(decoded.getTextWidth(text), original.getTextWidth(text));
      assert.deepEqual(decoded.measureTextWrap(text, width), original.measureTextWrap(text, width));
    }
  assert.ok(packed.length < source.length / 4);
  assert.throws(() => compactPretext("changed upstream format"), /format changed/);
});
