import {open,tool} from "./lib.mjs"; import fs from "fs";
const V=process.argv[2]||"1";const P=JSON.parse(fs.readFileSync("plan.json"));
const T=async(n,a)=>{let r=await tool(page,n,a);if(r.ok&&r.data?.proposalId&&r.data?.status==="pending"){const c=await tool(page,"gbk_commit_proposal",{proposalId:r.data.proposalId});if(!c.ok)throw new Error("commit "+JSON.stringify(c.error));} if(!r.ok)throw new Error(n+" "+JSON.stringify(r.error));return r;};
const {ctx,page}=await open();
try{
const cp=await T("gbk_create_project",{name:"Sunrise Over Pixel Ridge (Pixel Quest) v"+V,tempo:P.bpm,timeSignature:[4,4],key:"D major",ppq:480,replaceCurrent:false,descriptors:{form:"intro-A-A'-B-A loop",style:"chiptune overworld"}});
await T("gbk_set_song_structure",{sections:P.sections});
const TR=[["Square Lead","lead",0,80,114,60],["Pulse Arp","arp",1,80,52,88],["Pulse Bass","bass",2,38,104,64],["Noise Drums","drums",9,0,88,64]];const ids=[];
for(const [nm,k,ch,pr,vol,pan] of TR){const r=await T("gbk_create_track",{name:nm,channel:ch,program:pr,bankMsb:0,volume:vol,pan});ids.push(r.data.trackId||r.data.trackIds?.[0]||r.data.tracks?.[0]?.id);}
for(const [i,[nm,k,ch,pr,vol,pan]] of TR.entries()){await T("gbk_set_track_mix",{trackId:ids[i],mode:"default",volume:vol,pan});await T("gbk_propose_note_patch",{add:P.tracks[k].map(n=>({trackId:ids[i],...n})),summary:"notes "+nm});}
await T("gbk_set_effects",{enabled:true,roomSize:0.2,damping:0.6,reverbLevel:0.1,chorusLevel:0,chorusDepthMs:1,chorusRateHz:0.4,chorusDelayMs:10,summary:"dry chip room"});
const sum=await T("gbk_get_project_summary",{});fs.writeFileSync(`summary_v${V}.json`,JSON.stringify({project:cp.data,summary:sum.data},null,1));
let r=await T("gbk_render_wav",{output:"artifact",download:false,sampleRate:44100,channels:2,format:"pcm16",tailSeconds:1,saveArtifact:true});
while(r.data.status&&!["completed","failed","cancelled"].includes(r.data.status)){await page.waitForTimeout(1000);r=await T("gbk_get_render_status",{jobId:r.data.jobId});}
fs.writeFileSync(`render_meta_v${V}.json`,JSON.stringify(r.data,null,1));
const parts=[];let off=0;for(;;){const c=await T("gbk_read_wav_bytes",{artifactId:r.data.artifactId,offset:off,length:262144});parts.push(Buffer.from(c.data.base64,"base64"));if(c.data.eof)break;off=c.data.nextOffset;}
fs.writeFileSync(`sunrise_over_pixel_ridge_v${V}.wav`,Buffer.concat(parts));console.log("done");
}finally{await ctx.close();}
