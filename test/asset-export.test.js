import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { sliceConfirmedBoxes, packAtlas, createTsx, createTmx } from "../asset-export.js";

async function fixture(){
  return sharp({create:{width:4,height:3,channels:4,background:{r:20,g:40,b:60,alpha:1}}}).png().toBuffer();
}

test("slices only confirmed boxes and preserves exact crop dimensions",async()=>{
  const img=await fixture();
  const [a]=await sliceConfirmedBoxes(img,[{id:"wall",name:"Wall",x:1,y:1,width:2,height:2}]);
  const m=await sharp(a.png).metadata();
  assert.equal(m.width,2);assert.equal(m.height,2);assert.match(a.sha256,/^[a-f0-9]{64}$/);
});

test("rejects duplicate IDs and boxes outside the source image",async()=>{
  const img=await fixture();
  await assert.rejects(()=>sliceConfirmedBoxes(img,[{id:"x",x:0,y:0,width:1,height:1},{id:"x",x:1,y:1,width:1,height:1}]),/duplicados/);
  await assert.rejects(()=>sliceConfirmedBoxes(img,[{id:"x",x:3,y:2,width:2,height:2}]),/limites/);
});

test("packs a deterministic transparent atlas and emits manifest coordinates",async()=>{
  const img=await fixture();
  const parts=await sliceConfirmedBoxes(img,[{id:"a",x:0,y:0,width:2,height:2},{id:"b",x:2,y:0,width:2,height:2}]);
  const one=await packAtlas(parts,{padding:1,margin:1,maxWidth:16});
  const two=await packAtlas(parts,{padding:1,margin:1,maxWidth:16});
  assert.deepEqual(one.manifest,two.manifest);
  const meta=await sharp(one.png).metadata();
  assert.equal(meta.width,one.manifest.atlas.width);
  assert.equal(one.manifest.elements.length,2);
  assert.notEqual(one.manifest.elements[0].x,one.manifest.elements[1].x);
});

test("creates escaped TSX and rejects tile geometry outside image bounds",()=>{
  const tsx=createTsx({name:"Casa & Muro",imageSource:"atlas.png",imageWidth:64,imageHeight:32,tileWidth:16,tileHeight:16,columns:4,tileCount:8});
  assert.match(tsx,/Casa &amp; Muro/);assert.match(tsx,/<image source="atlas.png"/);
  assert.throws(()=>createTsx({name:"x",imageSource:"a.png",imageWidth:16,imageHeight:16,tileWidth:16,tileHeight:16,columns:2,tileCount:2}),/não cabe/);
});

test("creates TMX only from explicit placements and rejects collisions",()=>{
  const tmx=createTmx({width:2,height:2,tileWidth:16,tileHeight:16,tilesetSource:"set.tsx",placements:[{x:1,y:0,gid:1}]});
  assert.match(tmx,/<data encoding="csv">\n0,1,0,0/);
  assert.throws(()=>createTmx({width:1,height:1,tileWidth:16,tileHeight:16,tilesetSource:"set.tsx",placements:[{x:0,y:0,gid:1},{x:0,y:0,gid:2}]}),/mesma célula/);
});
