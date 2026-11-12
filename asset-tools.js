import sharp from "sharp";
import { sliceConfirmedBoxes, packAtlas, createTsx, createTmx } from "./asset-export.js";
import { randomUUID, createHash } from "node:crypto";

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 24000000;
const STAGING_PREFIX = ".staging";

function cleanName(value) {
  return String(value || "asset").split(/[\\/]/).pop().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80) || "asset";
}
function rgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function dist(a,b) {
  return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
}
function result(text, isError=false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function registerAssetTools(server, cfg) {
  const { z, token, owner, repo, branch } = cfg;
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/`;
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "rpg-assets-bridge"
  };
  async function put(path, bytes, message) {
    const response = await fetch(api + path.split("/").map(encodeURIComponent).join("/"), {
      method: "PUT", headers,
      body: JSON.stringify({ message, content: Buffer.from(bytes).toString("base64"), branch })
    });
    if (!response.ok) throw new Error("GitHub " + response.status + ": " + (await response.text()).slice(0,200));
    return response.json();
  }
  async function get(path) {
    const response = await fetch(api + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch), { headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("GitHub " + response.status + ": " + (await response.text()).slice(0,200));
    const data = await response.json();
    if (data.content && data.encoding === "base64") return Buffer.from(data.content.replace(/\s/g, ""), "base64");
    // Contents API omits inline content for larger files; retrieve the Git blob directly.
    if (!data.sha) throw new Error("GitHub não retornou SHA para " + path);
    const blobResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${data.sha}`, { headers });
    if (!blobResponse.ok) throw new Error("Git blob " + blobResponse.status + ": " + (await blobResponse.text()).slice(0,200));
    const blob = await blobResponse.json();
    if (blob.encoding !== "base64" || !blob.content) throw new Error("Blob sem conteúdo base64 para " + path);
    return Buffer.from(blob.content.replace(/\s/g, ""), "base64");
  }
  async function remove(path, message) {
    const response = await fetch(api + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch), { headers });
    if (response.status === 404) return;
    if (!response.ok) throw new Error("GitHub " + response.status + " ao localizar " + path);
    const data = await response.json();
    const deleted = await fetch(api + path.split("/").map(encodeURIComponent).join("/"), {
      method: "DELETE", headers,
      body: JSON.stringify({ message, sha: data.sha, branch })
    });
    if (!deleted.ok) throw new Error("GitHub " + deleted.status + " ao remover " + path);
  }
  async function commitFiles(files, message) {
    // Rebuild from the latest branch head after a concurrent non-fast-forward update.
    const git = `https://api.github.com/repos/${owner}/${repo}/git`;
    const refUrl = `${git}/ref/heads/${encodeURIComponent(branch)}`;
    for (let attempt=1; attempt<=3; attempt++) {
      const refRes = await fetch(refUrl, { headers });
      if (!refRes.ok) throw new Error("GitHub " + refRes.status + " ao consultar branch: " + (await refRes.text()).slice(0,200));
      const refData = await refRes.json();
      const parentSha = refData.object?.sha;
      if (!parentSha) throw new Error("GitHub não retornou commit atual da branch.");
      const parentRes = await fetch(`${git}/commits/${parentSha}`, { headers });
      if (!parentRes.ok) throw new Error("GitHub " + parentRes.status + " ao consultar árvore base.");
      const parent = await parentRes.json();
      const entries = await Promise.all(files.map(async file => {
        if (file.delete) return { path:file.path, mode:"100644", type:"blob", sha:null };
        const blobRes = await fetch(`${git}/blobs`, { method:"POST", headers, body:JSON.stringify({content:Buffer.from(file.bytes).toString("base64"),encoding:"base64"}) });
        if (!blobRes.ok) throw new Error("GitHub " + blobRes.status + " ao criar blob: " + (await blobRes.text()).slice(0,200));
        const blob = await blobRes.json();
        return { path:file.path, mode:"100644", type:"blob", sha:blob.sha };
      }));
      const treeRes = await fetch(`${git}/trees`, { method:"POST", headers, body:JSON.stringify({base_tree:parent.tree.sha,tree:entries}) });
      if (!treeRes.ok) throw new Error("GitHub " + treeRes.status + " ao criar árvore: " + (await treeRes.text()).slice(0,200));
      const tree = await treeRes.json();
      const commitRes = await fetch(`${git}/commits`, { method:"POST", headers, body:JSON.stringify({message,tree:tree.sha,parents:[parentSha]}) });
      if (!commitRes.ok) throw new Error("GitHub " + commitRes.status + " ao criar commit: " + (await commitRes.text()).slice(0,200));
      const commit = await commitRes.json();
      const updateRes = await fetch(`${git}/refs/heads/${encodeURIComponent(branch)}`, { method:"PATCH", headers, body:JSON.stringify({sha:commit.sha,force:false}) });
      if (updateRes.ok) return {commit_sha:commit.sha,files:files.length,attempts:attempt};
      const updateError = await updateRes.text();
      const concurrent = updateRes.status===422 && /fast.?forward|reference update failed|is at/i.test(updateError);
      if (!concurrent || attempt===3) throw new Error("GitHub " + updateRes.status + " ao atualizar branch sem force: " + updateError.slice(0,200));
      console.warn("Concorrência ao gravar staging; reconstruindo commit sobre HEAD atualizado (tentativa "+(attempt+1)+").");
    }
    throw new Error("Não foi possível concluir commit após conflitos concorrentes.");
  }
  function stagePath(id, name) { return `${STAGING_PREFIX}/${id}/${name}`; }
  async function saveStage(a, { includeOriginal = true } = {}) {
    const meta = { id:a.id,name:a.name,width:a.width,height:a.height,format:a.format,sourceWidth:a.sourceWidth,sourceHeight:a.sourceHeight,options:a.options,originalSha256:sha256(a.original),outputSha256:sha256(a.output),createdAt:new Date().toISOString() };
    const files=[];
    if(includeOriginal)files.push({path:stagePath(a.id,"original.bin"),bytes:a.original});
    files.push({path:stagePath(a.id,"prepared.png"),bytes:a.output},{path:stagePath(a.id,"metadata.json"),bytes:Buffer.from(JSON.stringify(meta))});
    await commitFiles(files,"Stage RPG asset "+a.id);
  }
  async function loadStage(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("ID de asset inválido.");
    const metaBytes=await get(stagePath(id,"metadata.json"));
    if (!metaBytes) return null;
    const meta=JSON.parse(metaBytes.toString("utf8"));
    if (meta.id!==id) throw new Error("Metadados de staging inconsistentes.");
    const [original,output]=await Promise.all([get(stagePath(id,"original.bin")),get(stagePath(id,"prepared.png"))]);
    if (!original || !output) throw new Error("Staging incompleto; execute prepare_asset novamente.");
    if (sha256(original)!==meta.originalSha256 || sha256(output)!==meta.outputSha256) throw new Error("Falha de integridade SHA-256 no staging.");
    return {...meta,original,output};
  }
  async function clearStage(id) {
    try { await commitFiles(["metadata.json","prepared.png","original.bin"].map(name=>({path:stagePath(id,name),delete:true})),"Remove completed RPG asset staging "+id); }
    catch(e){console.error("Staging cleanup warning:",e.message);}
  }

  server.tool("cleanup_stale_asset_staging","Lista ou remove staging antigo. Padrão dry_run=true; só remove assets com metadata válida e idade superior ao TTL, sem tocar em publicações finais.",
    {ttl_days:z.number().int().min(7).max(365).optional(),dry_run:z.boolean().optional()},
    async ({ttl_days,dry_run})=>{
      try{
        const ttl=ttl_days??30, dry=dry_run??true, cutoff=Date.now()-ttl*86400000;
        const git=`https://api.github.com/repos/${owner}/${repo}/git`;
        const refRes=await fetch(`${git}/ref/heads/${encodeURIComponent(branch)}`,{headers});
        if(!refRes.ok)throw new Error("GitHub "+refRes.status+" ao consultar branch.");
        const refData=await refRes.json();
        const commitRes=await fetch(`${git}/commits/${refData.object.sha}`,{headers});
        if(!commitRes.ok)throw new Error("GitHub "+commitRes.status+" ao consultar árvore.");
        const commit=await commitRes.json();
        const treeRes=await fetch(`${git}/trees/${commit.tree.sha}?recursive=1`,{headers});
        if(!treeRes.ok)throw new Error("GitHub "+treeRes.status+" ao listar staging.");
        const tree=await treeRes.json();
        if(tree.truncated)throw new Error("Árvore Git truncada; limpeza cancelada por segurança.");
        const metadataPaths=tree.tree.filter(x=>x.type==="blob"&&/^\.staging\/[0-9a-f-]{36}\/metadata\.json$/i.test(x.path)).map(x=>x.path);
        const candidates=[];
        for(const path of metadataPaths){
          const bytes=await get(path);if(!bytes)continue;
          let meta;try{meta=JSON.parse(bytes.toString("utf8"));}catch{continue;}
          const created=Date.parse(meta.createdAt||"");
          if(!/^[0-9a-f-]{36}$/i.test(meta.id||"")||path!==stagePath(meta.id,"metadata.json")||!Number.isFinite(created)||created>=cutoff)continue;
          const prefix=stagePath(meta.id,"");
          const paths=tree.tree.filter(x=>x.type==="blob"&&x.path.startsWith(prefix)).map(x=>x.path);
          candidates.push({asset_id:meta.id,created_at:meta.createdAt,files:paths});
        }
        const files=candidates.flatMap(c=>c.files.map(path=>({path,delete:true})));
        if(!dry&&files.length)await commitFiles(files,"Expire stale RPG asset staging older than "+ttl+" days");
        return result(JSON.stringify({status:dry?"dry_run":"cleanup_complete",ttl_days:ttl,assets:candidates.map(({asset_id,created_at,files})=>({asset_id,created_at,file_count:files.length})),assets_count:candidates.length,files_count:files.length,deleted:!dry,commit_created:!dry&&files.length>0},null,2));
      }catch(e){return result("cleanup_stale_asset_staging: "+e.message,true);}
    });

  server.tool("prepare_asset",
    "Recebe imagem base64, preserva o original e prepara PNG para o RPG. O staging é persistido no repositório privado entre chamadas MCP stateless. Suporta recorte, resize nearest-neighbor, chroma-key simples e remapeamento de paleta. Ainda não publica o asset final.",
    {
      image_base64: z.string().min(100),
      original_filename: z.string().optional(),
      target_width: z.number().int().min(1).max(4096).optional(),
      target_height: z.number().int().min(1).max(4096).optional(),
      fit: z.enum(["contain","cover","fill","inside","outside"]).optional(),
      crop: z.object({left:z.number().int().min(0),top:z.number().int().min(0),width:z.number().int().positive(),height:z.number().int().positive()}).optional(),
      grid_size: z.number().int().min(1).max(256).optional(),
      background_color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
      background_tolerance: z.number().int().min(0).max(441).optional(),
      palette: z.array(z.string().regex(/^#?[0-9a-fA-F]{6}$/)).min(2).max(64).optional()
    },
    async (args) => {
      try {
        if (!token || !owner || !repo) throw new Error("Credenciais RPG-assets não configuradas.");
        const encoded=args.image_base64.replace(/^data:image\/[^;]+;base64,/i,"");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Base64 inválido.");
        const input=Buffer.from(encoded,"base64");
        if (!input.length || input.length>MAX_BYTES) throw new Error("Imagem vazia ou acima de 12 MB.");
        const inspected=await sharp(input,{limitInputPixels:MAX_PIXELS}).metadata();
        if (!inspected.width || !inspected.height || inspected.width*inspected.height>MAX_PIXELS) throw new Error("Imagem acima de 24 megapixels ou dimensões inválidas.");
        if (!["png","jpeg","webp","gif"].includes(inspected.format)) throw new Error("Formato real não permitido: use PNG, JPEG, WEBP ou GIF.");
        // Normalize EXIF orientation before validating crop coordinates and dimensions.
        const normalized=await sharp(input,{limitInputPixels:MAX_PIXELS}).rotate().toBuffer({resolveWithObject:true});
        const meta={...inspected,width:normalized.info.width,height:normalized.info.height};
        if (!meta.width || !meta.height || meta.width*meta.height>MAX_PIXELS) throw new Error("Imagem orientada acima de 24 megapixels ou dimensões inválidas.");
        const source=sharp(normalized.data,{limitInputPixels:MAX_PIXELS});
        let pipeline=source;
        if(args.crop){const c=args.crop;if(c.left+c.width>meta.width||c.top+c.height>meta.height)throw new Error("Recorte fora dos limites.");pipeline=pipeline.extract(c);}
        if(args.target_width||args.target_height){
          const w=args.target_width||meta.width,h=args.target_height||meta.height,g=args.grid_size||1;
          pipeline=pipeline.resize(Math.max(g,Math.round(w/g)*g),Math.max(g,Math.round(h/g)*g),{fit:args.fit||"contain",kernel:sharp.kernel.nearest,background:{r:0,g:0,b:0,alpha:0}});
        }
        let raw=await pipeline.ensureAlpha().raw().toBuffer({resolveWithObject:true});
        const data=raw.data,channels=raw.info.channels;
        if(args.background_color){const bg=rgb(args.background_color),threshold=(args.background_tolerance??35)**2;for(let i=0;i<data.length;i+=channels)if(dist([data[i],data[i+1],data[i+2]],bg)<=threshold)data[i+3]=0;}
        if(args.palette?.length){const colors=args.palette.map(rgb);for(let i=0;i<data.length;i+=channels){if(data[i+3]===0)continue;const current=[data[i],data[i+1],data[i+2]];let best=colors[0],d=Infinity;for(const c of colors){const next=dist(current,c);if(next<d){d=next;best=c;}}data[i]=best[0];data[i+1]=best[1];data[i+2]=best[2];}}
        const output=await sharp(data,{raw:raw.info}).png().toBuffer();
        const om=await sharp(output).metadata(),id=randomUUID();
        const asset={id,name:cleanName(args.original_filename||"asset").replace(/\.(png|jpe?g|webp|gif)$/i,""),original:input,output,width:om.width,height:om.height,format:meta.format,sourceWidth:meta.width,sourceHeight:meta.height,options:{grid_size:args.grid_size||null,background_keyed:!!args.background_color,palette_remapped:!!args.palette?.length}};
        await saveStage(asset);
        return result(JSON.stringify({asset_id:id,status:"prepared_not_saved",staging:"durable_private_repository",original:{format:meta.format,width:meta.width,height:meta.height,bytes:input.length,sha256:sha256(input)},prepared:{format:"png",width:om.width,height:om.height,bytes:output.length,sha256:sha256(output)},options:asset.options,next:["validate_asset","preview_asset","aguardar aprovação explícita","save_asset"]},null,2));
      }catch(e){return result("prepare_asset: "+e.message,true);}
    });

  server.tool("edit_asset_pixels",
    "Aplica edições determinísticas em pixels sobre a cópia preparada no staging. O original permanece intacto. As alterações não são publicadas; valide e mostre a prévia antes de pedir aprovação para salvar.",
    {
      asset_id:z.string().uuid(),
      operations:z.array(z.discriminatedUnion("type",[
        z.object({type:z.literal("pixel"),x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),color:z.string().regex(/^#?[0-9a-fA-F]{6}$/)}),
        z.object({type:z.literal("rect"),x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive(),height:z.number().int().positive(),color:z.string().regex(/^#?[0-9a-fA-F]{6}$/),filled:z.boolean().optional()}),
        z.object({type:z.literal("line"),x1:z.number().int().nonnegative(),y1:z.number().int().nonnegative(),x2:z.number().int().nonnegative(),y2:z.number().int().nonnegative(),color:z.string().regex(/^#?[0-9a-fA-F]{6}$/)})
      ])).min(1).max(20000)
    },
    async ({asset_id,operations})=>{
      try{
        const a=await loadStage(asset_id);if(!a)throw new Error("Asset não encontrado no staging.");
        const raw=await sharp(a.output).ensureAlpha().raw().toBuffer({resolveWithObject:true});
        const {data,info}=raw,channels=info.channels;
        // Bound CPU work even when a caller submits huge rectangles or many operations.
        let work=0;
        for(const op of operations){
          if(op.type==="pixel") work+=1;
          else if(op.type==="rect") work+=op.filled===false ? 2*op.width+2*op.height : op.width*op.height;
          else work+=Math.abs(op.x2-op.x1)+Math.abs(op.y2-op.y1)+1;
          if(work>2000000) throw new Error("Limite de edição excedido: máximo de 2 milhões de pixels por chamada.");
        }
        const paint=(x,y,color)=>{
          if(x<0||y<0||x>=info.width||y>=info.height)throw new Error("Operação fora dos limites da imagem.");
          const col=rgb(color),i=(y*info.width+x)*channels;
          data[i]=col[0];data[i+1]=col[1];data[i+2]=col[2];data[i+3]=255;
        };
        for(const op of operations){
          if(op.type==="pixel"){paint(op.x,op.y,op.color);continue;}
          if(op.type==="rect"){
            if(op.x+op.width>info.width||op.y+op.height>info.height)throw new Error("Retângulo fora dos limites.");
            if(op.filled!==false){for(let y=op.y;y<op.y+op.height;y++)for(let x=op.x;x<op.x+op.width;x++)paint(x,y,op.color);}
            else{for(let x=op.x;x<op.x+op.width;x++){paint(x,op.y,op.color);paint(x,op.y+op.height-1,op.color);}for(let y=op.y;y<op.y+op.height;y++){paint(op.x,y,op.color);paint(op.x+op.width-1,y,op.color);}}
            continue;
          }
          let x=op.x1,y=op.y1,dx=Math.abs(op.x2-op.x1),sx=op.x1<op.x2?1:-1,dy=-Math.abs(op.y2-op.y1),sy=op.y1<op.y2?1:-1,err=dx+dy;
          while(true){paint(x,y,op.color);if(x===op.x2&&y===op.y2)break;const e2=2*err;if(e2>=dy){err+=dy;x+=sx;}if(e2<=dx){err+=dx;y+=sy;}}
        }
        const output=await sharp(data,{raw:info}).png().toBuffer();
        const updated={...a,output,outputSha256:sha256(output)};
        // The immutable source bytes are already staged; persist only the changed PNG and metadata.\n        await saveStage(updated, { includeOriginal: false });
        return result(JSON.stringify({asset_id,status:"edited_staging_only",operations:operations.length,width:a.width,height:a.height,output_sha256:updated.outputSha256,next:["validate_asset","preview_asset","aguardar aprovação explícita","save_asset"]},null,2));
      }catch(e){return result("edit_asset_pixels: "+e.message,true);}
    });

  server.tool("validate_asset","Confere dimensões, PNG, alpha, transparência e alinhamento. Não salva o arquivo final.",
    {asset_id:z.string().uuid(),expected_width:z.number().int().positive().optional(),expected_height:z.number().int().positive().optional(),grid_size:z.number().int().min(1).max(256).optional()},
    async ({asset_id,expected_width,expected_height,grid_size})=>{
      try{
        const a=await loadStage(asset_id);if(!a)throw new Error("Asset não encontrado no staging; execute prepare_asset novamente.");
        const raw=await sharp(a.output).ensureAlpha().raw().toBuffer({resolveWithObject:true});
        let transparent=0;for(let i=0;i<raw.data.length;i+=raw.info.channels)if(raw.data[i+3]===0)transparent++;
        const checks=[
          {name:"png",passed:true,detail:"PNG"},
          {name:"dimensions",passed:(!expected_width||a.width===expected_width)&&(!expected_height||a.height===expected_height),detail:a.width+"x"+a.height+"px"},
          {name:"alpha_channel",passed:true,detail:"Canal alpha presente"},
          {name:"grid_alignment",passed:!grid_size||(a.width%grid_size===0&&a.height%grid_size===0),detail:grid_size?"Grade "+grid_size+"px":"Não solicitado"}
        ];
        return result(JSON.stringify({asset_id,compatible:checks.every(x=>x.passed),checks,transparency:{transparent_pixels:transparent,total_pixels:a.width*a.height,percent:Number((100*transparent/(a.width*a.height)).toFixed(2))}},null,2));
      }catch(e){return result("validate_asset: "+e.message,true);}
    });

  server.tool("slice_asset_elements","Recorta elementos usando exclusivamente caixas delimitadoras confirmadas. Persiste PNGs e manifesto no staging privado; não publica assets.",
    {asset_id:z.string().uuid(),boxes:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),name:z.string().max(100).optional(),x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive(),height:z.number().int().positive()})).min(1).max(512)},
    async ({asset_id,boxes})=>{
      try{
        const a=await loadStage(asset_id);if(!a)throw new Error("Asset não encontrado no staging.");
        const elements=await sliceConfirmedBoxes(a.output,boxes);
        const manifest={version:1,asset_id,source_sha256:a.outputSha256,created_at:new Date().toISOString(),elements:elements.map(({id,name,x,y,width,height,sha256})=>({id,name,x,y,width,height,sha256,path:stagePath(asset_id,"elements/"+id+".png")}))};
        const files=elements.map(e=>({path:stagePath(asset_id,"elements/"+e.id+".png"),bytes:e.png}));
        files.push({path:stagePath(asset_id,"elements/manifest.json"),bytes:Buffer.from(JSON.stringify(manifest,null,2))});
        const commit=await commitFiles(files,"Slice confirmed RPG asset elements "+asset_id);
        return result(JSON.stringify({status:"sliced_staging_only",asset_id,count:elements.length,manifest_path:stagePath(asset_id,"elements/manifest.json"),commit_sha:commit.commit_sha,elements:manifest.elements},null,2));
      }catch(e){return result("slice_asset_elements: "+e.message,true);}
    });

  server.tool("build_asset_atlas","Monta atlas PNG determinístico a partir dos elementos já recortados e persistidos no staging. Não publica.",
    {asset_id:z.string().uuid(),padding:z.number().int().min(0).max(64).optional(),margin:z.number().int().min(0).max(128).optional(),max_width:z.number().int().min(1).max(8192).optional()},
    async ({asset_id,padding,margin,max_width})=>{
      try{
        const a=await loadStage(asset_id);if(!a)throw new Error("Asset não encontrado no staging.");
        const raw=await get(stagePath(asset_id,"elements/manifest.json"));if(!raw)throw new Error("Elementos não recortados; execute slice_asset_elements.");
        const manifest=JSON.parse(raw.toString("utf8"));
        if(manifest.asset_id!==asset_id||manifest.source_sha256!==a.outputSha256)throw new Error("Manifesto de recortes não corresponde à versão atual do asset.");
        const elements=await Promise.all(manifest.elements.map(async e=>{const png=await get(stagePath(asset_id,"elements/"+e.id+".png"));if(!png||sha256(png)!==e.sha256)throw new Error("Elemento ausente ou SHA-256 divergente: "+e.id);return {...e,png};}));
        const packed=await packAtlas(elements,{padding:padding??1,margin:margin??1,maxWidth:max_width??2048});
        const atlasManifest={...packed.manifest,asset_id,source_sha256:a.outputSha256,created_at:new Date().toISOString(),atlas_path:stagePath(asset_id,"atlas.png")};
        const commit=await commitFiles([{path:stagePath(asset_id,"atlas.png"),bytes:packed.png},{path:stagePath(asset_id,"atlas-manifest.json"),bytes:Buffer.from(JSON.stringify(atlasManifest,null,2))}],"Build deterministic RPG atlas "+asset_id);
        return result(JSON.stringify({status:"atlas_staged_not_published",asset_id,atlas_path:atlasManifest.atlas_path,manifest_path:stagePath(asset_id,"atlas-manifest.json"),width:atlasManifest.atlas.width,height:atlasManifest.atlas.height,elements:atlasManifest.elements.length,sha256:atlasManifest.atlas.sha256,commit_sha:commit.commit_sha},null,2));
      }catch(e){return result("build_asset_atlas: "+e.message,true);}
    });

  server.tool("export_tiled_files","Gera TSX e, opcionalmente, TMX a partir de parâmetros explícitos. Requer uma imagem tileset em grade regular; atlas de sprites irregulares não é automaticamente um tileset.",
    {asset_id:z.string().uuid(),tileset_name:z.string().min(1).max(80),image_source:z.string().min(1).max(240),image_width:z.number().int().positive(),image_height:z.number().int().positive(),tile_width:z.number().int().positive(),tile_height:z.number().int().positive(),columns:z.number().int().positive(),tile_count:z.number().int().positive(),spacing:z.number().int().min(0).optional(),margin:z.number().int().min(0).optional(),map:z.object({width:z.number().int().positive(),height:z.number().int().positive(),placements:z.array(z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),gid:z.number().int().positive()})).max(100000)}).optional()},
    async (args)=>{
      try{
        const a=await loadStage(args.asset_id);if(!a)throw new Error("Asset não encontrado no staging.");
        const tsx=createTsx({name:args.tileset_name,imageSource:args.image_source,imageWidth:args.image_width,imageHeight:args.image_height,tileWidth:args.tile_width,tileHeight:args.tile_height,columns:args.columns,tileCount:args.tile_count,spacing:args.spacing??0,margin:args.margin??0});
        const stem=cleanName(args.tileset_name),files=[{path:stagePath(args.asset_id,"exports/"+stem+".tsx"),bytes:Buffer.from(tsx)}];
        if(args.map){
          if(args.map.placements.some(p=>p.gid>args.tile_count))throw new Error("GID informado excede tile_count do TSX.");
          const tmx=createTmx({width:args.map.width,height:args.map.height,tileWidth:args.tile_width,tileHeight:args.tile_height,tilesetSource:stem+".tsx",placements:args.map.placements});
          files.push({path:stagePath(args.asset_id,"exports/"+stem+".tmx"),bytes:Buffer.from(tmx)});
        }
        const commit=await commitFiles(files,"Export staged Tiled files "+args.asset_id);
        return result(JSON.stringify({status:"tiled_exports_staged_not_published",asset_id:args.asset_id,files:files.map(f=>f.path),commit_sha:commit.commit_sha,requires_tiled_application_validation:true},null,2));
      }catch(e){return result("export_tiled_files: "+e.message,true);}
    });

  server.tool("save_asset","Publica original, PNG e relatório em um único commit. A aprovação fica vinculada ao SHA-256 exato da imagem visualizada.",
    {asset_id:z.string().uuid(),approved_sha256:z.string().regex(/^[a-f0-9]{64}$/),user_approval:z.string().min(80),destination_folder:z.enum(["sprites","tilesets","maps","exports"])},
    async ({asset_id,approved_sha256,user_approval,destination_folder})=>{
      try{
        const a=await loadStage(asset_id);if(!a)throw new Error("Asset não encontrado no staging.");
        if(approved_sha256!==a.outputSha256)throw new Error("Hash aprovado não corresponde à versão atual. Gere nova prévia e valide novamente.");
        const requiredApproval="APROVO SALVAR "+asset_id+" "+a.outputSha256;
        if(user_approval.trim()!==requiredApproval)throw new Error("Aprovação ausente ou inválida. Confirme exatamente: "+requiredApproval);
        const stamp=new Date().toISOString().replace(/[:.]/g,"-"),stem=a.name+"-"+stamp;
        const originalExt=a.format==="jpeg"?"jpg":a.format;
        const originalPath="references/originals/"+stem+"."+originalExt,finalPath=destination_folder+"/"+stem+".png",reportPath="reports/"+stem+".json";
        const report={asset_id,saved_at:new Date().toISOString(),original_path:originalPath,prepared_path:finalPath,original:{format:a.format,width:a.sourceWidth,height:a.sourceHeight,bytes:a.original.length,sha256:a.originalSha256},prepared:{format:"png",width:a.width,height:a.height,bytes:a.output.length,sha256:a.outputSha256},processing:a.options,approval:{type:"explicit_user_confirmation",approved_sha256:a.outputSha256}};
        const files=[
          {path:originalPath,bytes:a.original},{path:finalPath,bytes:a.output},{path:reportPath,bytes:Buffer.from(JSON.stringify(report,null,2))},
          ...["metadata.json","prepared.png","original.bin"].map(name=>({path:stagePath(asset_id,name),delete:true}))
        ];
        const publication=await commitFiles(files,"Publish approved RPG asset "+stem);
        return result(JSON.stringify({status:"saved",repository:owner+"/"+repo,original_path:originalPath,prepared_path:finalPath,report_path:reportPath,sha256:report.prepared.sha256,commit_sha:publication.commit_sha,atomic:true},null,2));
      }catch(e){return result("save_asset: "+e.message,true);}
    });
}
