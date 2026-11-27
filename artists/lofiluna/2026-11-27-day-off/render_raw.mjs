// usage: node render.mjs <dir>  (dir has plan.json + song.json)
import {open,tool} from "./lib.mjs"; import fs from "fs"; import crypto from "crypto";
const D=process.argv[2];const P=JSON.parse(fs.readFileSync(D+"/plan.json"));const S=JSON.parse(fs.readFileSync(D+"/song.json"));const L=[];
let page;
const T0=0;const T=async(n,a)=>{let r=await tool(page,n,a);L.push({n,ok:r.ok,err:r.error,w:r.warnings});if(r.ok&&r.data?.proposalId&&r.data?.status==="pending"){const c=await tool(page,"gbk_commit_proposal",{proposalId:r.data.proposalId});if(!c.ok)throw new Error("commit "+JSON.stringify(c.error));} if(!r.ok)throw new Error(n+" "+JSON.stringify(r.error));return r;};
const o=await open();page=o.page;const ctx=o.ctx;
try{
const nt=await page.evaluate(async()=>((await document.modelContext?.getTools())??[]).length).catch(()=>0);
if(nt<=40) throw new Error("WebMCP tools low: "+nt);
const cp=await T("gbk_create_project",{name:S.title,tempo:S.bpm,timeSignature:[4,4],key:S.key,ppq:480,replaceCurrent:false,descriptors:{form:"intro-A-B-A-outro",style:S.style}});
await T("gbk_set_song_structure",{sections:S.sections});
const ids=[];
for(const t of S.tracks){const r=await T("gbk_create_track",{name:t.name,channel:t.ch,program:t.prog,bankMsb:0,volume:t.vol,pan:t.pan});ids.push(r.data.trackId||r.data.trackIds?.[0]||r.data.tracks?.[0]?.id);}
for(const [i,t] of S.tracks.entries()){
 await T("gbk_set_track_mix",{trackId:ids[i],mode:"default",volume:t.vol,pan:t.pan});
 if(P[t.key].length) await T("gbk_propose_note_patch",{add:P[t.key].map(n=>({trackId:ids[i],...n})),summary:"notes "+t.name});
}
await T("gbk_set_effects",{enabled:true,...S.fx,summary:"room"});
const sum=await T("gbk_get_project_summary",{});fs.writeFileSync(D+"/summary.json",JSON.stringify(sum.data,null,1));
let r=await T("gbk_render_wav",{output:"artifact",download:false,sampleRate:44100,channels:2,format:"pcm16",tailSeconds:3,saveArtifact:true,normalize:"off"});
while(r.data.status&&!["completed","failed","cancelled"].includes(r.data.status)){await page.waitForTimeout(1000);r=await T("gbk_get_render_status",{jobId:r.data.jobId});}
fs.writeFileSync(D+"/render_meta.json",JSON.stringify(r.data,null,1));
await page.waitForTimeout(2000);
const pid=cp.data?.projectId;
const proj=await page.evaluate(async(id)=>new Promise((res,rej)=>{const q=indexedDB.open("gbk-midi");q.onerror=()=>rej(String(q.error));q.onsuccess=()=>{const g=q.result.transaction("projects").objectStore("projects").get(id);g.onsuccess=()=>res(g.result?.project??null);g.onerror=()=>rej(String(g.error));};}),pid);
if(proj) fs.writeFileSync(D+"/project.json",JSON.stringify(proj)); else console.log("NO_PROJECT_IN_IDB");
const aid=r.data.artifactId;const parts=[];let off=0;
for(;;){const c=await T("gbk_read_wav_bytes",{artifactId:aid,offset:off,length:262144});parts.push(Buffer.from(c.data.base64,"base64"));if(c.data.eof)break;off=c.data.nextOffset;}
const w=Buffer.concat(parts);
fs.writeFileSync(D+"/gbk_raw.wav",w);console.log(JSON.stringify({project:pid,sha:crypto.createHash("sha256").update(w).digest("hex"),bytes:w.length,status:r.data.status}));
}finally{fs.writeFileSync(D+"/calls.json",JSON.stringify(L,null,1));await ctx.close();fs.rmSync(o.prof,{recursive:true,force:true});}
