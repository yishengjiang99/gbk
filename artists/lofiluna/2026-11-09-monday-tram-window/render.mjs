import {open,tool} from "./lib.mjs"; import fs from "fs"; import crypto from "crypto";
const P=JSON.parse(fs.readFileSync("plan.json"));const L=[];
const T=async(n,a)=>{let r=await tool(page,n,a);L.push({n,ok:r.ok,err:r.error,w:r.warnings});if(r.ok&&r.data?.proposalId&&r.data?.status==="pending"){const c=await tool(page,"gbk_commit_proposal",{proposalId:r.data.proposalId});if(!c.ok)throw new Error("commit "+JSON.stringify(c.error));} if(!r.ok)throw new Error(n+" "+JSON.stringify(r.error));return r;};
const {ctx,page}=await open();
try{
const nTools=await page.evaluate(async()=>((await document.modelContext?.getTools())??[]).length).catch(()=>0);
if(nTools<=40){console.error("WebMCP tools low:",nTools);await page.reload({waitUntil:"load",timeout:60000});for(let i=0;i<60;i++){const n=await page.evaluate(async()=>((await document.modelContext?.getTools())??[]).length).catch(()=>0);if(n>40)break;await page.waitForTimeout(500);}const n2=await page.evaluate(async()=>((await document.modelContext?.getTools())??[]).length).catch(()=>0);if(n2<=40)throw new Error("WebMCP tools failed to load: "+n2);}
const cp=await T("gbk_create_project",{name:"Monday Tram Window",tempo:88,timeSignature:[4,4],key:"A major",ppq:480,replaceCurrent:false,descriptors:{form:"intro-A-B-A-outro",style:"bright-commuter-chillhop"}});
await T("gbk_set_song_structure",{sections:[
  {name:"Intro",startBar:1,bars:4,energy:0.35},
  {name:"A",startBar:5,bars:16,energy:0.55},
  {name:"B",startBar:21,bars:16,energy:0.75},
  {name:"A2",startBar:37,bars:12,energy:0.55},
  {name:"Outro",startBar:49,bars:4,energy:0.3}
]});
// Rhodes EP1=4, New Age Pad=88, Fingered Bass=33, Flute=73, drums ch9
const TR=[["Electric Piano 2","rhodes",0,5,90,52],["Warm Pad","pad",1,89,74,66],["Acoustic Bass","bass",2,32,94,64],["Clarinet","flute",3,71,82,70],["Standard Kit","drums",9,0,94,64]];
const ids=[];
for(const [nm,k,ch,pr,vol,pan] of TR){const r=await T("gbk_create_track",{name:nm,channel:ch,program:pr,bankMsb:0,volume:vol,pan});ids.push(r.data.trackId||r.data.trackIds?.[0]||r.data.tracks?.[0]?.id);}
for(const [i,[nm,k,ch,pr,vol,pan]] of TR.entries()){
 await T("gbk_set_track_mix",{trackId:ids[i],mode:"default",volume:vol,pan});
 await T("gbk_propose_note_patch",{add:P[k].map(n=>({trackId:ids[i],...n})),summary:"notes "+nm});
}
await T("gbk_set_effects",{enabled:true,roomSize:0.42,damping:0.55,reverbLevel:0.28,chorusLevel:0.07,chorusDepthMs:1,chorusRateHz:0.25,chorusDelayMs:10,summary:"tram cabin room"});
const sum=await T("gbk_get_project_summary",{});fs.writeFileSync("summary.json",JSON.stringify(sum.data,null,1));
let r=await T("gbk_render_wav",{output:"artifact",download:false,sampleRate:44100,channels:2,format:"pcm16",tailSeconds:2.5,saveArtifact:true,normalize:"loudness",targetLufs:-16});
while(r.data.status&&!["completed","failed","cancelled"].includes(r.data.status)){await page.waitForTimeout(1000);r=await T("gbk_get_render_status",{jobId:r.data.jobId});}
fs.writeFileSync("render_meta.json",JSON.stringify(r.data,null,1));
await page.waitForTimeout(2000);
const pid=cp.data?.projectId;
const proj=await page.evaluate(async(id)=>new Promise((res,rej)=>{const q=indexedDB.open("gbk-midi");q.onerror=()=>rej(String(q.error));q.onsuccess=()=>{const g=q.result.transaction("projects").objectStore("projects").get(id);g.onsuccess=()=>res(g.result?.project??null);g.onerror=()=>rej(String(g.error));};}),pid);
if(proj) fs.writeFileSync("project.json",JSON.stringify(proj)); else console.log("NO_PROJECT_IN_IDB");
const aid=r.data.artifactId;const parts=[];let off=0;
for(;;){const c=await T("gbk_read_wav_bytes",{artifactId:aid,offset:off,length:262144});parts.push(Buffer.from(c.data.base64,"base64"));if(c.data.eof)break;off=c.data.nextOffset;}
const w=Buffer.concat(parts);const sha=crypto.createHash("sha256").update(w).digest("hex");
fs.writeFileSync("gbk_raw.wav",w);console.log(JSON.stringify({project:cp.data?.projectId,sha,artifactSha:r.data.sha256,bytes:w.length,status:r.data.status}));
}finally{fs.writeFileSync("calls.json",JSON.stringify(L,null,1));await ctx.close();}
