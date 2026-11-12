import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
const routeStart = source.indexOf('app.post("/assets-upload"');
const routeEnd = source.indexOf('app.post("/mcp"', routeStart);
const route = source.slice(routeStart, routeEnd);
const formStart = source.indexOf('app.get("/assets-upload"');
const formEnd = source.indexOf('app.post("/assets-upload"', formStart);
const form = source.slice(formStart, formEnd);

test("legacy reference upload authenticates bearer credentials before multer buffers a file", () => {
  assert.match(route, /replace\(\/\^Bearer\\s\+\/i,\s*""\)/);
  assert.ok(route.indexOf("safeSecretEqual(provided, ASSETS_UPLOAD_SECRET)") < route.indexOf('upload.single("image")'));
  assert.doesNotMatch(route, /req\.query|req\.body\?\.secret/);
});

test("legacy upload form sends the password in Authorization, not multipart body or URL", () => {
  assert.match(form, /headers:\{Authorization:"Bearer "\+secret\}/);
  assert.match(form, /data\.delete\("secret"\)/);
  assert.doesNotMatch(form, /\?secret=|name="secret"[^>]*type="hidden"/);
});

test("legacy upload requires actual image format, MIME, and filename extension to agree", () => {
  assert.match(route, /expectedMime !== req\.file\.mimetype/);
  assert.match(route, /expectedExt/);
  assert.match(route, /meta\.width \* meta\.height > 24000000/);
  assert.match(source, /fileSize:\\s*12\\s*\\*\\s*1024\\s*\\*\\s*1024/);
});
