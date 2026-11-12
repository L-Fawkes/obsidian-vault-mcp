import sharp from "sharp";
import { createHash } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const xml = (s) => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
const safeId = (s) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

export async function sliceConfirmedBoxes(input, boxes) {
  if (!Buffer.isBuffer(input) || !Array.isArray(boxes) || boxes.length < 1 || boxes.length > 512) throw new Error("Imagem e de 1 a 512 caixas confirmadas são obrigatórias.");
  const meta = await sharp(input,{limitInputPixels:24000000}).metadata();
  if (!meta.width || !meta.height || meta.width * meta.height > 24000000) throw new Error("Imagem inválida ou acima de 24 MP.");
  const ids = new Set();
  const out = [];
  for (const box of boxes) {
    if (!box || !safeId(box.id) || ids.has(box.id)) throw new Error("IDs de elemento inválidos ou duplicados.");
    ids.add(box.id);
    const {x,y,width,height}=box;
    if (![x,y,width,height].every(Number.isInteger) || x<0 || y<0 || width<1 || height<1 || x+width>meta.width || y+height>meta.height) throw new Error("Caixa "+box.id+" fora dos limites da imagem.");
    const png=await sharp(input).extract({left:x,top:y,width,height}).png().toBuffer();
    out.push({id:box.id,name:String(box.name||box.id).slice(0,100),x,y,width,height,png,sha256:sha256(png)});
  }
  return out;
}

export async function packAtlas(elements, options={}) {
  const {padding=1,margin=1,maxWidth=2048} = options;
  if (!Array.isArray(elements) || !elements.length || elements.length>512) throw new Error("Atlas exige de 1 a 512 elementos.");
  if (![padding,margin,maxWidth].every(Number.isInteger) || padding<0 || margin<0 || maxWidth<1 || maxWidth>8192) throw new Error("Parâmetros de atlas inválidos.");
  const ids=new Set(), prepared=[];
  for(const e of elements){
    if(!safeId(e.id)||ids.has(e.id)) throw new Error("IDs de atlas inválidos ou duplicados.");
    ids.add(e.id);
    const m=await sharp(e.png,{limitInputPixels:24000000}).metadata();
    if(!m.width||!m.height||m.width+2*padding+2*margin>maxWidth) throw new Error("Elemento "+e.id+" excede a largura máxima.");
    prepared.push({...e,width:m.width,height:m.height});
  }
  // Stable shelf packing: preserve caller order, wrap only when the next item exceeds maxWidth.
  let x=margin,y=margin,rowH=0,usedW=0;
  const positions=[];
  for(const e of prepared){
    const w=e.width+2*padding,h=e.height+2*padding;
    if(x!==margin && x+w+margin>maxWidth){x=margin;y+=rowH+padding;rowH=0;}
    positions.push({...e,x:x+padding,y:y+padding});
    x+=w+padding;rowH=Math.max(rowH,h);usedW=Math.max(usedW,x-padding+margin);
  }
  const atlasW=Math.max(1,usedW),atlasH=Math.max(1,y+rowH+margin);
  if(atlasW>maxWidth||atlasH>8192||atlasW*atlasH>24000000) throw new Error("Dimensões finais do atlas excedem os limites.");
  const composites=[];
  for(const p of positions) composites.push({input:p.png,left:p.x,top:p.y});
  const png=await sharp({create:{width:atlasW,height:atlasH,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(composites).png().toBuffer();
  const manifest={version:1,atlas:{width:atlasW,height:atlasH,sha256:sha256(png)},padding,margin,elements:positions.map(({id,name,x,y,width,height,sha256})=>({id,name,x,y,width,height,sha256}))};
  return {png,manifest};
}

export function createTsx({name,imageSource,imageWidth,imageHeight,tileWidth,tileHeight,columns,tileCount,spacing=0,margin=0}) {
  if(!name||!imageSource||![imageWidth,imageHeight,tileWidth,tileHeight,columns,tileCount,spacing,margin].every(Number.isInteger)||[imageWidth,imageHeight,tileWidth,tileHeight,columns,tileCount].some(v=>v<1)||spacing<0||margin<0) throw new Error("Parâmetros TSX inválidos.");
  const rows=Math.ceil(tileCount/columns);
  if(margin*2+columns*tileWidth+(columns-1)*spacing>imageWidth||margin*2+rows*tileHeight+(rows-1)*spacing>imageHeight) throw new Error("Tileset não cabe nas dimensões informadas.");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tileset version="1.10" tiledversion="1.10.2" name="${xml(name)}" tilewidth="${tileWidth}" tileheight="${tileHeight}" tilecount="${tileCount}" columns="${columns}">\n <image source="${xml(imageSource)}" width="${imageWidth}" height="${imageHeight}"/>\n</tileset>\n`;
}

export function createTmx({width,height,tileWidth,tileHeight,tilesetSource,firstGid=1,placements}) {
  if(![width,height,tileWidth,tileHeight,firstGid].every(Number.isInteger)||[width,height,tileWidth,tileHeight,firstGid].some(v=>v<1)||!Array.isArray(placements)) throw new Error("Parâmetros TMX inválidos.");
  const data=Array(width*height).fill(0), seen=new Set();
  for(const p of placements){
    if(!Number.isInteger(p.x)||!Number.isInteger(p.y)||!Number.isInteger(p.gid)||p.x<0||p.y<0||p.x>=width||p.y>=height||p.gid<firstGid) throw new Error("Posicionamento TMX inválido.");
    const i=p.y*width+p.x;if(seen.has(i))throw new Error("Mais de um tile ocupa a mesma célula.");seen.add(i);data[i]=p.gid;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.10" tiledversion="1.10.2" orientation="orthogonal" renderorder="right-down" width="${width}" height="${height}" tilewidth="${tileWidth}" tileheight="${tileHeight}" infinite="0">\n <tileset firstgid="${firstGid}" source="${xml(tilesetSource)}"/>\n <layer id="1" name="Camada 1" width="${width}" height="${height}"><data encoding="csv">\n${data.join(",")}\n</data></layer>\n</map>\n`;
}
