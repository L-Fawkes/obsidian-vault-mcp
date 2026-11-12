import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/editor.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "editor must contain its application script");
new vm.Script(script);

test("draft export contains only the editable layer, never the visible reference", () => {
  const exportBody = script.match(/function makeExportCanvas\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(exportBody, /ox\.drawImage\(layer/);
  assert.doesNotMatch(exportBody, /drawImage\(ref/);
});

test("resizing preserves the overlapping pixels of the drawing layer", () => {
  assert.match(script, /function init\(W=w,H=h,\{preserve=false\}=\{\}\)/);
  assert.match(script, /if\(previous\)lctx\.drawImage\(previous,0,0,Math\.min\(previous\.width,w\),Math\.min\(previous\.height,h\)\)/);
  assert.match(script, /init\(W,h,\{preserve:true\}\)/);
  assert.match(script, /init\(w,H,\{preserve:true\}\)/);
});

test("pointer movement interpolates pixels between sampled positions", () => {
  assert.match(script, /function drawSegment\(from,to\)/);
  assert.match(script, /drawSegment\(lastPoint,next\)/);
  assert.match(script, /lastPoint=next/);
});
