import sharp from "sharp";
import { randomUUID } from "node:crypto";

const pending = new Map();
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 24000000;

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

export function registerAssetTools(server, cfg) {
  const { z, token, owner, repo, branch } = cfg;
  async function put(path, bytes, message) {
    const url = "https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: Buffer.from(bytes).toString("base64"), branch })
    });
    if (!response.ok) throw new Error("GitHub " + response.status + ": " + (await response.text()).slice(0,200));
    return response.json();
  }

  server.tool("prepare_asset",
    "Recebe imagem anexada como base64, preserva o original em memória e prepara PNG para o RPG. Suporta recorte, redimensionamento nearest-neighbor, chroma-key simples e remapeamento de paleta. Não salva no GitHub.",
    {
      image_base64: z.string().min(100).describe("Imagem em base64, sem prefixo data URL."),
      original_filename: z.string().optional(),
      target_width: z.number().int().min(1).max(4096).optional(),
      target_height: z.number().int().min(1).max(4096).optional(),
      fit: z.enum(["contain","cover","fill","inside","outside"]).optional(),
      crop: z.object({ left:z.number().int().min(0), top:z.number().int().min(0), width:z.number().int().positive(), height:z.number().int().positive() }).optional(),
      grid_size: z.number().int().min(1).max(256).optional(),
      background_color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
      background_tolerance: z.number().int().min(0).max(441).optional(),
      palette: z.array(z.string().regex(/^#?[0-9a-fA-F]{6}$/)).min(2).max(64).optional()
    },
    async (args) => {
      try {
        if (!token || !owner || !repo) throw new Error("Credenciais RPG-assets não configuradas no Render.");
        const input = Buffer.from(args.image_base64.replace(/^data:image\/[^;]+;base64,/i, ""), "base64");
        if (!input.length || input.length > MAX_BYTES) throw new Error("Imagem vazia ou acima de 12 MB.");
        const source = sharp(input, { limitInputPixels: MAX_PIXELS }).rotate();
        const meta = await source.metadata();
        if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS) throw new Error("Imagem acima de 24 megapixels ou dimensões inválidas.");
        let pipeline = source;
        if (args.crop) {
          const c = args.crop;
          if (c.left+c.width>meta.width || c.top+c.height>meta.height) throw new Error("Recorte fora dos limites da imagem.");
          pipeline = pipeline.extract(c);
        }
        if (args.target_width || args.target_height) {
          const w=args.target_width || meta.width, h=args.target_height || meta.height, g=args.grid_size || 1;
          pipeline = pipeline.resize(Math.max(g,Math.round(w/g)*g),Math.max(g,Math.round(h/g)*g),{fit:args.fit||"contain",kernel:sharp.kernel.nearest,background:{r:0,g:0,b:0,alpha:0}});
        }
        let raw = await pipeline.ensureAlpha().raw().toBuffer({resolveWithObject:true});
        const data=raw.data, channels=raw.info.channels;
        if(args.background_color){
          const bg=rgb(args.background_color), threshold=(args.background_tolerance ?? 35)**2;
          for(let i=0;i<data.length;i+=channels) if(dist([data[i],data[i+1],data[i+2]],bg)<=threshold) data[i+3]=0;
        }
        if(args.palette?.length){
          const colors=args.palette.map(rgb);
          for(let i=0;i<data.length;i+=channels){
            if(data[i+3]===0) continue;
            const current=[data[i],data[i+1],data[i+2]];
            let best=colors[0], d=Infinity;
            for(const c of colors){const next=dist(current,c);if(next<d){d=next;best=c;}}
            data[i]=best[0];data[i+1]=best[1];data[i+2]=best[2];
          }
        }
        const output=await sharp(data,{raw:raw.info}).png().toBuffer();
        const om=await sharp(output).metadata(), id=randomUUID();
        pending.set(id,{id,name:cleanName(args.original_filename||"asset").replace(/\.(png|jpe?g|webp|gif)$/i,""),original:input,output,width:om.width,height:om.height,format:meta.format||"unknown",sourceWidth:meta.width,sourceHeight:meta.height,options:{grid_size:args.grid_size||null,background_keyed:!!args.background_color,palette_remapped:!!args.palette?.length}});
        return result(JSON.stringify({asset_id:id,status:"prepared_not_saved",original:{format:meta.format,width:meta.width,height:meta.height,bytes:input.length},prepared:{format:"png",width:om.width,height:om.height,bytes:output.length,alpha_channel:true},options:pending.get(id).options,next:["validate_asset","preview_asset","aguardar aprovação explícita","save_asset"]},null,2));
      }catch(e){return result("prepare_asset: "+e.message,true);}
    });

  server.tool("validate_asset","Confere dimensões, PNG, canal alpha, transparência e alinhamento opcional à grade. Não salva.",
    {asset_id:z.string().uuid(),expected_width:z.number().int().positive().optional(),expected_height:z.number().int().positive().optional(),grid_size:z.number().int().min(1).max(256).optional()},
    async ({asset_id,expected_width,expected_height,grid_size})=>{
      try{
        const a=pending.get(asset_id);if(!a)throw new Error("Asset expirado ou sessão reiniciada; execute prepare_asset novamente.");
        const raw=await sharp(a.output).ensureAlpha().raw().toBuffer({resolveWithObject:true});
        let transparent=0;for(let i=0;i<raw.data.length;i+=raw.info.channels)if(raw.data[i+3]===0)transparent++;
        const checks=[
          {name:"png",passed:true,detail:"PNG"},
          {name:"dimensions",passed:(!expected_width||a.width===expected_width)&&(!expected_height||a.height===expected_height),detail:a.width+"x"+a.height+"px"},
          {name:"alpha_channel",passed:true,detail:"Canal alpha presente"},
          {name:"grid_alignment",passed:!grid_size||(a.width%grid_size===0&&a.height%grid_size===0),detail:grid_size?("Grade "+grid_size+"px"):"Não solicitado"}
        ];
        return result(JSON.stringify({asset_id,compatible:checks.every(x=>x.passed),checks,transparency:{transparent_pixels:transparent,total_pixels:a.width*a.height,percent:Number(100*transparent/(a.width*a.height)).toFixed(2)},warning:"Chroma-key por cor é aproximado; não equivale à segmentação por IA. Validação técnica não substitui revisão artística."},null,2));
      }catch(e){return result("validate_asset: "+e.message,true);}
    });

  server.tool("preview_asset","Retorna a prévia PNG visual e informa que o arquivo ainda não foi salvo.",
    {asset_id:z.string().uuid()},
    async ({asset_id})=>{
      const a=pending.get(asset_id);if(!a)return result("Asset expirado ou sessão reiniciada; execute prepare_asset novamente.",true);
      return {content:[{type:"text",text:"PRÉVIA: "+a.name+"\nID: "+a.id+"\nDimensões: "+a.width+"x"+a.height+"px\nStatus: NÃO SALVO. Aguarde aprovação explícita do usuário."},{type:"image",data:a.output.toString("base64"),mimeType:"image/png"}]};
    });

  server.tool("save_asset","Salva original preservado, PNG preparado e relatório técnico no RPG-assets. Exige frase exata escrita pelo usuário: APROVO SALVAR <asset_id>.",
    {asset_id:z.string().uuid(),user_approval:z.string().min(10),destination_folder:z.enum(["sprites","tilesets","maps","exports"])},
    async ({asset_id,user_approval,destination_folder})=>{
      try{
        const a=pending.get(asset_id);if(!a)throw new Error("Asset expirado ou sessão reiniciada; execute prepare_asset novamente.");
        if(user_approval.trim()!=="APROVO SALVAR "+asset_id)throw new Error("Aprovação ausente. O usuário precisa escrever exatamente: APROVO SALVAR "+asset_id);
        const stamp=new Date().toISOString().replace(/[:.]/g,"-"), stem=a.name+"-"+stamp;
        const originalExt=a.format==="jpeg"?"jpg":(["png","jpg","webp","gif"].includes(a.format)?a.format:"bin");
        const originalPath="references/originals/"+stem+"."+originalExt;
        const finalPath=destination_folder+"/"+stem+".png";
        const reportPath="reports/"+stem+".json";
        const report={asset_id,saved_at:new Date().toISOString(),original_path:originalPath,prepared_path:finalPath,original:{format:a.format,width:a.sourceWidth,height:a.sourceHeight,bytes:a.original.length},prepared:{format:"png",width:a.width,height:a.height,bytes:a.output.length,alpha_channel:true},processing:a.options,approval:"explicit_user_confirmation"};
        await put(originalPath,a.original,"Preserve original "+stem);
        await put(finalPath,a.output,"Save approved RPG asset "+stem);
        await put(reportPath,Buffer.from(JSON.stringify(report,null,2)),"Add asset report "+stem);
        pending.delete(asset_id);
        return result(JSON.stringify({status:"saved",repository:owner+"/"+repo,original_path:originalPath,prepared_path:finalPath,report_path:reportPath},null,2));
      }catch(e){return result("save_asset: "+e.message,true);}
    });
}
