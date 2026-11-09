import { chromium } from "playwright";
export const log=[];
export async function open(){
  const ctx=await chromium.launchPersistentContext("/workspace/pixelquest/2026-10-26-boss-of-the-iron-citadel/profile",{channel:"chrome",headless:true,args:["--enable-features=WebMCPTesting"],viewport:{width:1600,height:1000},acceptDownloads:true});
  const page=ctx.pages()[0]||await ctx.newPage();
  await page.addInitScript(()=>localStorage.setItem("gbk.agentTools","1"));
  page.on("pageerror",e=>console.log("pageerror",e.message));
  await page.goto(process.env.GBK_URL||"https://yishengjiang99.github.io/gbk/",{waitUntil:"networkidle"});
  for(let i=0;i<60;i++){const n=await page.evaluate(async()=>((await document.modelContext?.getTools())??[]).length).catch(()=>0); if(n>40)break; await page.waitForTimeout(500);}
  return {ctx,page};
}
export async function tool(page,name,args={}){
  const out=await page.evaluate(async([n,a])=>{const mc=document.modelContext;const t=(await mc.getTools()).find(x=>x.name===n);if(!t)return JSON.stringify({ok:false,error:{code:"NOT_REGISTERED",message:n}});try{return await mc.executeTool(t,a);}catch(e){return JSON.stringify({ok:false,error:{code:"THROW",message:String(e)}})}},[name,args]);
  const r=JSON.parse(out); log.push({name,args,ok:r.ok,error:r.error}); console.error(`[${name}] ok=${r.ok}${r.error?" "+JSON.stringify(r.error):""}`); return r;
}
