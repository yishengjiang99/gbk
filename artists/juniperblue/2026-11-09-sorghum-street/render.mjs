import {open,tool} from "./lib.mjs"; import fs from "fs"; import crypto from "crypto";
const V=process.argv[2]||"1";
const P=JSON.parse(fs.readFileSync(`plan_v${V}.json`));
const L=[];
const T=async(n,a)=>{let r=await tool(page,n,a);L.push({n,ok:r.ok,err:r.error});if(r.ok&&r.data?.proposalId&&r.data?.status==="pending"){const c=await tool(page,"gbk_commit_proposal",{proposalId:r.data.proposalId});if(!c.ok)throw new Error("commit "+JSON.stringify(c.error));} if(!r.ok)throw new Error(n+" "+JSON.stringify(r.error));return r;};
const {ctx,page}=await open();
try{
const nTools=await page.evaluate(async()=>((await document.modelContext?.getTools())??[]).length).catch(()=>0);
if(nTools<=40){console.error("WebMCP tools low:",nTools);await page.reload({waitUntil:"load",timeout:60000});for(let i=0;i<60;i++){const n=await page.evaluate(async()=>((await document.modelContext?.getTools())??[]).length).catch(()=>0);if(n>40)break;await page.waitForTimeout(500);}const n2=await page.evaluate(async()=>((await document.modelContext?.getTools())??[]).length).catch(()=>0);if(n2<=40)throw new Error("WebMCP tools failed to load: "+n2);}
const cp=await T("gbk_create_project",{name:"Sorghum Street (Juniper Blue) v"+V,tempo:P.bpm,timeSignature:[4,4],key:"F major",ppq:480,replaceCurrent:false,descriptors:{form:"intro-head A bridge A (12-bar blues A)-guitar solo-organ solo-head out bridge A-coda",style:"soul-jazz organ trio shuffle"}});
await T("gbk_set_song_structure",{sections:P.sections});
const TR=JSON.parse(process.env.MIX||'[["Drawbar Organ","organ",0,16,96,56],["Jazz Guitar","guitar",1,26,100,76],["Percussive Organ","comp",2,17,80,48],["Electric Bass","bass",3,33,100,64],["Standard Kit","drums",9,0,92,64]]');
const ids=[];
for(const [nm,k,ch,pr,vol,pan] of TR){const r=await T("gbk_create_track",{name:nm,channel:ch,program:pr,bankMsb:0,volume:vol,pan});ids.push(r.data.trackId||r.data.trackIds?.[0]||r.data.tracks?.[0]?.id);}
for(const [i,[nm,k,ch,pr,vol,pan]] of TR.entries()){
 await T("gbk_set_track_mix",{trackId:ids[i],mode:"default",volume:vol,pan});
 await T("gbk_propose_note_patch",{add:P.tracks[k].map(n=>({trackId:ids[i],...n})),summary:"notes "+nm});
}
await T("gbk_set_effects",{enabled:true,roomSize:0.45,damping:0.5,reverbLevel:0.2,chorusLevel:0.12,chorusDepthMs:1.2,chorusRateHz:0.35,chorusDelayMs:10,summary:"club room, organ chorus"});
const sum=await T("gbk_get_project_summary",{});fs.writeFileSync(`summary_v${V}.json`,JSON.stringify(sum.data,null,1));
let r=await T("gbk_render_wav",{output:"artifact",download:false,sampleRate:44100,channels:2,format:"pcm16",tailSeconds:2.5,saveArtifact:true,normalize:"loudness",targetLufs:-16});
while(r.data.status&&!["completed","failed","cancelled"].includes(r.data.status)){await page.waitForTimeout(1000);r=await T("gbk_get_render_status",{jobId:r.data.jobId});}
fs.writeFileSync(`render_meta_v${V}.json`,JSON.stringify(r.data,null,1));
await page.waitForTimeout(1500);
const pid=cp.data?.projectId;
const proj=await page.evaluate(async(id)=>new Promise((res,rej)=>{const q=indexedDB.open("gbk-midi");q.onerror=()=>rej(String(q.error));q.onsuccess=()=>{const g=q.result.transaction("projects").objectStore("projects").get(id);g.onsuccess=()=>res(g.result?.project??null);g.onerror=()=>rej(String(g.error));};}),pid);
if(proj) fs.writeFileSync(`project_v${V}.json`,JSON.stringify(proj)); else console.log("NO_PROJECT_IN_IDB");
const aid=r.data.artifactId;const parts=[];let off=0;
for(;;){const c=await T("gbk_read_wav_bytes",{artifactId:aid,offset:off,length:262144});parts.push(Buffer.from(c.data.base64,"base64"));if(c.data.eof)break;off=c.data.nextOffset;}
const w=Buffer.concat(parts);const sha=crypto.createHash("sha256").update(w).digest("hex");
fs.writeFileSync(`sorghum_street_v${V}.wav`,w);console.log(JSON.stringify({project:pid,sha,bytes:w.length,status:r.data.status}));
}finally{fs.writeFileSync(`calls_v${V}.json`,JSON.stringify(L,null,1));await ctx.close();}
