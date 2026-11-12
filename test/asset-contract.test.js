import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../asset-tools.js", import.meta.url), "utf8");

test("staging persists prepared output and metadata together", () => {
  assert.match(source, /async function saveStage[\s\S]*?await commitFiles\(files,/);
  assert.match(source, /files\.push\(\{path:stagePath\(a\.id,"prepared\.png"\)[\s\S]*?metadata\.json/);
});

test("pixel edits do not rewrite the immutable original", () => {
  assert.match(source, /saveStage\(updated,\s*\{\s*includeOriginal:\s*false\s*\}\)/);
  assert.match(source, /if\(includeOriginal\)files\.push\(\{path:stagePath\(a\.id,"original\.bin"\)/);
});

test("staging verifies original and prepared bytes against SHA-256 metadata", () => {
  assert.match(source, /sha256\(original\)!==meta\.originalSha256/);
  assert.match(source, /sha256\(output\)!==meta\.outputSha256/);
});

test("publishing requires the exact current output hash and explicit phrase", () => {
  assert.match(source, /approved_sha256:z\.string\(\)\.regex\(\/\^\[a-f0-9\]\{64\}\$\//);
  assert.match(source, /if\(approved_sha256!==a\.outputSha256\)/);
  assert.match(source, /"APROVO SALVAR "\+asset_id\+" "\+a\.outputSha256/);
});

test("final files and staging cleanup are submitted in one atomic commit", () => {
  assert.match(source, /const files=\[[\s\S]*?originalPath[\s\S]*?finalPath[\s\S]*?reportPath[\s\S]*?metadata\.json/);
  assert.match(source, /const publication=await commitFiles\(files,/);
  assert.match(source, /atomic:true/);
});

test("atomic branch update refuses force-push", () => {
  assert.match(source, /method:"PATCH"[\s\S]*?force:false/);
});

test("MCP exposes confirmed slicing, staged atlas, and explicit Tiled export tools", () => {
  assert.match(source, /server\.tool\("slice_asset_elements"/);
  assert.match(source, /server\.tool\("build_asset_atlas"/);
  assert.match(source, /server\.tool\("export_tiled_files"/);
  assert.match(source, /manifest\.source_sha256!==a\.outputSha256/);
  assert.match(source, /requires_tiled_application_validation:true/);
});

test("TMX export rejects GIDs beyond declared tileset count", () => {
  assert.match(source, /placements\.some\(p=>p\.gid>args\.tile_count\)/);
});

test("staging cleanup is dry-run by default and protects malformed or recent metadata", () => {
  assert.match(source, /server\.tool\("cleanup_stale_asset_staging"/);
  assert.match(source, /dry_run\?\?true/);
  assert.match(source, /ttl_days\?\?30/);
  assert.match(source, /tree\.truncated\)throw new Error/);
  assert.match(source, /created>=cutoff/);
  assert.match(source, /path!==stagePath\(meta\.id,"metadata\.json"\)/);
  assert.match(source, /commitFiles\(files,"Expire stale RPG asset staging/);
});
