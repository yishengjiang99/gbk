// MCP Apps UI resource for GBK Composer.
// Single HTML document, vanilla JS. The only external resources are on our own origin (declared in the resource CSP):
// the renderer bundle + SF2 AudioWorklet (/api/mcp/widget/*, loaded on demand when the user presses Render), the
// SoundFont, and the render-job snapshot/upload endpoints. Render synthesizes the WAV in the user's browser with the
// canonical OfflineAudioContext path (src/widget/widget-render.ts -> src/audio/offline-context.ts); the server never does.
// Served by the MCP server as COMPOSER_UI_URI and rendered inside ChatGPT /
// other MCP Apps hosts. Data arrives via the ui/* postMessage bridge
// (ui/notifications/tool-result, structuredContent) with a window.openai
// fallback for ChatGPT-specific hosts.

// Versioned: hosts cache templates by URI, and v2 changed the HTML (in-chat rendering).
export const COMPOSER_UI_URI = "ui://gbk/composer-v2.html";

/** The player HTML for a server at `origin` (e.g. https://compose.grepawk.com). */
export function composerUiHtml(origin: string): string { return TEMPLATE.replace("__GBK_ORIGIN__", JSON.stringify(origin.replace(/\/$/, ""))); }

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GBK Composer</title>
<style>
:root{
  --bg:#111318; --panel:#1a1d24; --panel2:#22262f; --text:#f2f3f5; --muted:#a7adb8;
  --line:#333947; --accent:#7aa2ff; --accent-text:#0b1020; --danger:#ff8a8a; --chip:#2a2f3b;
  color-scheme:dark;
}
@media (prefers-color-scheme:light){
  :root{ --bg:#ffffff; --panel:#f4f5f7; --panel2:#eceef1; --text:#17191d; --muted:#5b636e;
    --line:#d7dbe1; --accent:#245fd6; --accent-text:#ffffff; --danger:#b3261e; --chip:#e3e7ee; color-scheme:light; }
}
:root[data-theme="light"]{ --bg:#ffffff; --panel:#f4f5f7; --panel2:#eceef1; --text:#17191d; --muted:#5b636e;
  --line:#d7dbe1; --accent:#245fd6; --accent-text:#ffffff; --danger:#b3261e; --chip:#e3e7ee; color-scheme:light; }
:root[data-theme="dark"]{ --bg:#111318; --panel:#1a1d24; --panel2:#22262f; --text:#f2f3f5; --muted:#a7adb8;
  --line:#333947; --accent:#7aa2ff; --accent-text:#0b1020; --danger:#ff8a8a; --chip:#2a2f3b; color-scheme:dark; }
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-x:hidden}
main{max-width:960px;margin:0 auto;padding:14px}
h1{font-size:20px;margin:0 0 2px;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:13px}
.rev{color:var(--muted);font-size:12px}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button,.btn{display:inline-block;border:1px solid var(--line);background:var(--panel2);color:var(--text);
  border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{border-color:var(--accent)}
button:focus-visible,.btn:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent);font-weight:600}
button[aria-pressed="true"]{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
input[type="range"]{flex:1 1 140px;min-width:100px;accent-color:var(--accent)}
.time{font-variant-numeric:tabular-nums;color:var(--muted);font-size:13px;white-space:nowrap}
#loading,#noRender{padding:18px;text-align:center;color:var(--muted)}
#noRender{color:var(--danger)}
#rollScroll{overflow-x:auto;overflow-y:hidden;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}
canvas{display:block}
#ccWrap{margin-top:8px}
#ccWrap .lbl{font-size:12px;color:var(--muted);margin-bottom:4px}
ul.tracks{list-style:none;margin:0;padding:0}
ul.tracks li{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
ul.tracks li:last-child{border-bottom:0}
.chip{width:14px;height:14px;border-radius:4px;flex:0 0 auto;border:1px solid var(--line)}
.tname{font-weight:600;overflow-wrap:anywhere}
.tinfo{color:var(--muted);font-size:12px}
.tspacer{flex:1}
label.zoomlbl{font-size:12px;color:var(--muted)}
.followup input[type="text"]{flex:1 1 200px;min-width:140px;background:var(--bg);color:var(--text);
  border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px}
.hidden{display:none !important}
audio{display:none}
.prog{flex:1 1 140px;min-width:100px;height:8px;border-radius:4px;background:var(--panel2);border:1px solid var(--line);overflow:hidden}
.prog>div{height:100%;width:0;background:var(--accent);transition:width .2s}
@media (max-width:420px){ main{padding:8px} h1{font-size:17px} section{padding:9px} }
</style>
</head>
<body>
<main id="app">
  <header>
    <h1 id="title">GBK Composer</h1>
    <div class="meta" id="metaLine">—</div>
    <div class="rev" id="revLine"></div>
  </header>

  <div id="loading" role="status">Waiting for composition data…</div>
  <div id="noRender" class="hidden" role="status">No audio yet — press Render to synthesize it here in your browser.</div>

  <section id="playerSec" class="hidden" aria-label="Playback">
    <div class="row">
      <button id="playBtn" class="primary" type="button" aria-label="Play">▶ Play</button>
      <span class="time"><span id="curTime">0:00</span> / <span id="durTime">0:00</span></span>
      <input id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
    </div>
    <div class="row" id="renderRow" style="margin-top:8px">
      <button id="renderBtn" type="button">Render audio</button>
      <button id="stopBtn" type="button" class="hidden">Stop</button>
      <div class="prog hidden" id="progWrap" role="progressbar" aria-label="Render progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="progBar"></div></div>
      <span class="time" id="progPct"></span>
    </div>
    <div class="meta" id="renderStatus" role="status">Renders in your browser with the GBK SoundFont engine. No GBK Studio tab needed.</div>
    <audio id="audio" preload="metadata"></audio>
    <div class="meta" id="playerErr"></div>
  </section>

  <section id="rollSec" class="hidden" aria-label="Piano roll">
    <div class="row" style="margin-bottom:8px">
      <span class="zoomlbl" id="zoomLbl">Zoom</span>
      <button type="button" data-zoom="1" aria-pressed="true">Fit</button>
      <button type="button" data-zoom="2" aria-pressed="false">2×</button>
      <button type="button" data-zoom="4" aria-pressed="false">4×</button>
      <span class="tspacer"></span>
      <span class="meta">Click the piano roll to seek. Track “Highlight” toggles are visual only — the audio is a fixed mix.</span>
    </div>
    <div id="rollScroll">
      <canvas id="roll" role="img" aria-label="Piano roll visualization of the composition"></canvas>
    </div>
    <div id="ccWrap" class="hidden">
      <div class="lbl">Expression (CC11)</div>
      <canvas id="cc" role="img" aria-label="Expression controller (CC11) curves"></canvas>
    </div>
  </section>

  <section id="trackSec" class="hidden" aria-label="Tracks">
    <div class="meta" style="margin-bottom:6px">Tracks — Highlight toggles affect the piano roll only, not the audio mix.</div>
    <ul class="tracks" id="trackList"></ul>
  </section>

  <section id="actionSec" class="hidden" aria-label="Actions">
    <div class="row">
      <a class="btn hidden" id="dlWav" href="#" download>Download WAV</a>
      <a class="btn hidden" id="dlMidi" href="#" download>Download MIDI</a>
      <a class="btn hidden" id="openStudio" href="#" target="_blank" rel="noopener">Open in GBK Studio</a>
      <button id="refreshBtn" type="button">Refresh</button>
    </div>
    <form class="row followup" id="followForm" style="margin-top:10px">
      <input type="text" id="followText" aria-label="Follow-up message to GBK Composer" placeholder="Ask for a change, e.g. make bars 17–24 more dramatic">
      <button type="submit">Send follow-up</button>
    </form>
    <div class="meta" id="statusLine" role="status"></div>
  </section>
</main>

<script>
(function(){
"use strict";
var ORIGIN=__GBK_ORIGIN__;
var COLORS=["#7aa2ff","#ff9f6e","#6ed3a5","#e58ad1","#ffd166","#6ec9e8","#b49aff","#ff7a7a","#9ede6e","#e8c07a","#7ad1c3","#c3a6ff"];
var state={toolArgs:null,data:null,zoom:1,highlight:{},anyHighlight:false,playing:false,raf:0};
var pending={}; var nextId=1;
var $=function(id){return document.getElementById(id);};
var els={title:$("title"),meta:$("metaLine"),rev:$("revLine"),loading:$("loading"),noRender:$("noRender"),
  player:$("playerSec"),rollSec:$("rollSec"),trackSec:$("trackSec"),actions:$("actionSec"),
  audio:$("audio"),play:$("playBtn"),seek:$("seek"),cur:$("curTime"),dur:$("durTime"),perr:$("playerErr"),
  scroll:$("rollScroll"),roll:$("roll"),ccWrap:$("ccWrap"),cc:$("cc"),tracks:$("trackList"),
  wav:$("dlWav"),midi:$("dlMidi"),studio:$("openStudio"),refresh:$("refreshBtn"),
  status:$("statusLine"),form:$("followForm"),follow:$("followText"),
  renderBtn:$("renderBtn"),stopBtn:$("stopBtn"),progWrap:$("progWrap"),progBar:$("progBar"),progPct:$("progPct"),rstatus:$("renderStatus")};

function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function fmt(t){ if(!isFinite(t)||t<0)t=0; var m=Math.floor(t/60), s=Math.floor(t%60); return m+":"+(s<10?"0":"")+s; }
function post(obj){ if(window.parent&&window.parent!==window) window.parent.postMessage(obj,"*"); }
function rpcRequest(method,params){
  return new Promise(function(resolve,reject){
    var id=nextId++; pending[id]={resolve:resolve,reject:reject};
    post({jsonrpc:"2.0",id:id,method:method,params:params||{}});
    setTimeout(function(){ if(pending[id]){ delete pending[id]; reject(new Error("Host did not answer "+method)); } },15000);
  });
}
function notify(method,params){ post({jsonrpc:"2.0",method:method,params:params||{}}); }
function applyTheme(theme){ if(theme==="light"||theme==="dark") document.documentElement.setAttribute("data-theme",theme); }

function callTool(name,args){
  if(window.openai&&typeof window.openai.callTool==="function"){
    return Promise.resolve(window.openai.callTool(name,args||{})).then(function(r){
      return (r&&r.structuredContent)||r||{};
    });
  }
  return rpcRequest("tools/call",{name:name,arguments:args||{}}).then(function(r){
    if(r&&r.structuredContent) return r.structuredContent;
    if(r&&r.result&&r.result.structuredContent) return r.result.structuredContent;
    return r||{};
  });
}
function sendMessage(text){
  if(window.openai&&typeof window.openai.sendFollowUpMessage==="function"){
    window.openai.sendFollowUpMessage({prompt:text}); return;
  }
  notify("ui/message",{role:"user",content:[{type:"text",text:text}]});
}

/* ---------- host bridge ---------- */
window.addEventListener("message",function(ev){
  var msg=ev.data; if(!msg||typeof msg!=="object") return;
  if(msg.id!=null&&pending[msg.id]){
    var p=pending[msg.id]; delete pending[msg.id];
    if(msg.error) p.reject(new Error(msg.error.message||"Host error")); else p.resolve(msg.result||{});
    return;
  }
  if(msg.method==="ui/notifications/tool-result"){
    var sc=msg.params&&msg.params.structuredContent;
    if(sc&&sc.compositionId) render(sc);
  } else if(msg.method==="ui/notifications/tool-input"){
    var a=msg.params&&(msg.params.arguments||msg.params);
    if(a&&typeof a==="object") state.toolArgs=a;
    if(a&&a.structuredContent) render(a.structuredContent);
  } else if(msg.method==="ui/notifications/host-context-changed"){
    if(msg.params&&msg.params.theme) applyTheme(msg.params.theme);
  }
});

function initBridge(){
  var openaiInput=window.openai&&(window.openai.toolInput||window.openai.tool_input);
  if(openaiInput&&typeof openaiInput==="object") state.toolArgs=openaiInput;
  var openaiData=window.openai&&(window.openai.toolOutput||window.openai.tool_output);
  if(openaiData&&openaiData.compositionId) render(openaiData);
  rpcRequest("ui/initialize",{
    protocolVersion:"2026-01-26",
    appInfo:{name:"GBK Composer",version:"1.0.0"},
    appCapabilities:{}
  }).then(function(result){
    var hc=result&&(result.hostContext||result.host_context);
    if(hc&&hc.theme) applyTheme(hc.theme);
    notify("ui/notifications/initialized",{});
  }).catch(function(){
    notify("ui/notifications/initialized",{});
  });
}

/* ---------- musical helpers ---------- */
function ticksPerBar(d){ return d.ppq*d.timeSignature[0]*(4/d.timeSignature[1]); }
function totalTicks(d){
  var t=d.bars*ticksPerBar(d);
  (d.notes||[]).forEach(function(n){ var e=n.tick+n.duration; if(e>t)t=e; });
  return Math.max(t,1);
}
function tickToSec(d,tick){ return tick*(60/(d.tempoBpm*d.ppq)); }
function trackColor(i){ return COLORS[i%COLORS.length]; }
function trackIndex(d,id){ for(var i=0;i<d.tracks.length;i++) if(d.tracks[i].id===id) return i; return 0; }

/* ---------- rendering ---------- */
function render(data){
  if(!data||!data.compositionId) return;
  state.data=data;
  els.loading.classList.add("hidden");
  document.title=data.title||"GBK Composer";
  els.title.textContent=data.title||"Untitled composition";
  var parts=[];
  if(data.key) parts.push("Key "+data.key);
  if(data.style) parts.push(data.style);
  parts.push(data.tempoBpm+" BPM");
  parts.push(data.timeSignature[0]+"/"+data.timeSignature[1]);
  parts.push(data.bars+" bars");
  parts.push(fmt(data.durationSec||tickToSec(data,totalTicks(data))));
  els.meta.textContent=parts.join(" · ");
  els.rev.textContent="Revision "+data.revision+" · Composition "+data.compositionId;
  els.roll.setAttribute("aria-label","Piano roll of "+(data.title||"composition")+": "+
    data.tracks.length+" tracks, "+(data.notes||[]).length+" notes, "+data.bars+" bars.");

  var art=data.artifacts||{};
  var hasWav=!!(art.wav&&art.wav.downloadUrl);
  var local=pl.mode==="buf";
  els.noRender.classList.toggle("hidden",hasWav||local);
  els.player.classList.remove("hidden");
  if(hasWav&&!local){
    pl.mode="el";
    if(els.audio.getAttribute("src")!==art.wav.downloadUrl) els.audio.setAttribute("src",art.wav.downloadUrl);
    els.dur.textContent=fmt(art.wav.durationSeconds||data.durationSec||0);
  }
  if(!local){ els.wav.classList.toggle("hidden",!hasWav); if(hasWav) els.wav.setAttribute("href",art.wav.downloadUrl); }
  els.renderBtn.textContent=(hasWav||local)?"Re-render":"Render audio";
  var hasMidi=!!(art.midi&&art.midi.downloadUrl);
  els.midi.classList.toggle("hidden",!hasMidi);
  if(hasMidi) els.midi.setAttribute("href",art.midi.downloadUrl);
  if(data.projectUrl){ els.studio.classList.remove("hidden"); els.studio.setAttribute("href",data.projectUrl); }

  els.rollSec.classList.remove("hidden");
  els.trackSec.classList.remove("hidden");
  els.actions.classList.remove("hidden");
  renderTracks(data);
  drawRoll(); drawCC();
}

function renderTracks(data){
  while(els.tracks.firstChild) els.tracks.removeChild(els.tracks.firstChild);
  data.tracks.forEach(function(tr,i){
    var li=document.createElement("li");
    var chip=document.createElement("span"); chip.className="chip"; chip.style.background=trackColor(i); li.appendChild(chip);
    var name=document.createElement("span"); name.className="tname"; name.textContent=tr.name||("Track "+(i+1)); li.appendChild(name);
    var info=document.createElement("span"); info.className="tinfo";
    var inst=tr.presetName?tr.presetName:("Program "+tr.program);
    info.textContent=inst+" · Ch "+(tr.channel+1)+" · "+tr.noteCount+" notes"+
      (tr.mix?(" · Vol "+tr.mix.volume+" · Pan "+tr.mix.pan+" · Expr "+tr.mix.expression):"");
    li.appendChild(info);
    var sp=document.createElement("span"); sp.className="tspacer"; li.appendChild(sp);
    var btn=document.createElement("button"); btn.type="button"; btn.textContent="Highlight";
    btn.setAttribute("aria-pressed",state.highlight[tr.id]?"true":"false");
    btn.setAttribute("aria-label","Highlight track "+(tr.name||("Track "+(i+1)))+" in piano roll (visual only)");
    btn.addEventListener("click",function(){
      if(state.highlight[tr.id]) delete state.highlight[tr.id]; else state.highlight[tr.id]=true;
      state.anyHighlight=Object.keys(state.highlight).length>0;
      btn.setAttribute("aria-pressed",state.highlight[tr.id]?"true":"false");
      drawRoll(); drawCC();
    });
    li.appendChild(btn);
    els.tracks.appendChild(li);
  });
}

function setupCanvas(cv,w,h){
  var dpr=window.devicePixelRatio||1;
  cv.style.width=w+"px"; cv.style.height=h+"px";
  cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr);
  var ctx=cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0); return ctx;
}
function rollWidth(){
  var avail=els.scroll.clientWidth||320;
  return Math.max(avail,Math.floor(avail*state.zoom)-2);
}
function drawRoll(){
  var d=state.data; if(!d) return;
  var notes=d.notes||[]; if(!notes.length){ return; }
  var minP=127,maxP=0,i;
  for(i=0;i<notes.length;i++){ if(notes[i].pitch<minP)minP=notes[i].pitch; if(notes[i].pitch>maxP)maxP=notes[i].pitch; }
  minP=Math.max(0,minP-2); maxP=Math.min(127,maxP+2);
  var rows=maxP-minP+1, rowH=Math.max(5,Math.min(10,Math.floor(260/rows)));
  var h=rows*rowH+18, w=rollWidth(), tot=totalTicks(d), tpb=ticksPerBar(d);
  var ctx=setupCanvas(els.roll,w,h);
  var dark=document.documentElement.getAttribute("data-theme")!=="light";
  ctx.fillStyle=dark?"#171a20":"#f7f8fa"; ctx.fillRect(0,0,w,h);
  ctx.strokeStyle=dark?"#2b303c":"#dde1e8"; ctx.lineWidth=1;
  for(var b=0;b<=d.bars;b++){ var x=Math.round((b*tpb/tot)*w)+0.5; ctx.beginPath(); ctx.moveTo(x,14); ctx.lineTo(x,h); ctx.stroke(); }
  ctx.fillStyle=dark?"#a7adb8":"#5b636e"; ctx.font="10px system-ui,sans-serif";
  (d.sections||[]).forEach(function(s){
    var x=(s.startBar*tpb/tot)*w;
    ctx.strokeStyle=dark?"#7aa2ff":"#245fd6"; ctx.beginPath(); ctx.moveTo(x+0.5,0); ctx.lineTo(x+0.5,h); ctx.stroke();
    ctx.fillText(String(s.name||""),x+3,10);
  });
  for(i=0;i<notes.length;i++){
    var n=notes[i], ti=trackIndex(d,n.trackId);
    var dim=state.anyHighlight&&!state.highlight[n.trackId];
    ctx.globalAlpha=dim?0.15:0.55+0.45*((n.velocity||64)/127);
    ctx.fillStyle=trackColor(ti);
    var x=(n.tick/tot)*w, nw=Math.max(2,(n.duration/tot)*w);
    var y=14+(maxP-n.pitch)*rowH;
    ctx.fillRect(x,y+0.5,nw,Math.max(2,rowH-1));
  }
  ctx.globalAlpha=1;
  var curSec=pCur();
  var curTick=curSec/(60/(d.tempoBpm*d.ppq));
  var cx=(curTick/tot)*w;
  ctx.strokeStyle=dark?"#ffffff":"#111111"; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,h); ctx.stroke();
}
function drawCC(){
  var d=state.data; if(!d) return;
  var lanes=(d.controllers||[]).filter(function(c){return c.controller===11&&c.points&&c.points.length;});
  if(!lanes.length){ els.ccWrap.classList.add("hidden"); return; }
  els.ccWrap.classList.remove("hidden");
  var w=rollWidth(), h=54, tot=totalTicks(d);
  var ctx=setupCanvas(els.cc,w,h);
  ctx.strokeStyle="#888"; ctx.strokeRect(0.5,0.5,w-1,h-1);
  lanes.forEach(function(lane){
    var ti=trackIndex(d,lane.trackId);
    var dim=state.anyHighlight&&!state.highlight[lane.trackId];
    ctx.globalAlpha=dim?0.15:1; ctx.strokeStyle=trackColor(ti); ctx.lineWidth=1.5; ctx.beginPath();
    lane.points.forEach(function(p,i){
      var x=(p.tick/tot)*w, y=h-3-(p.value/127)*(h-6);
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  });
  ctx.globalAlpha=1;
}

/* ---------- playback ----------
   Two sources: "el" = the saved WAV artifact in <audio> (signed URL on our origin), "buf" = a WAV rendered in this
   widget, played through an AudioContext buffer (no blob: media URL needed, so a strict media-src CSP is fine). */
var pl={mode:null,ac:null,buf:null,src:null,t0:0,off:0,playing:false};
function ensureAc(){
  if(!pl.ac){ var C=window.AudioContext||window.webkitAudioContext; if(!C) return null; try{ pl.ac=new C(); }catch(e){ return null; } }
  if(pl.ac.state==="suspended"){ try{ pl.ac.resume(); }catch(e){} }
  return pl.ac;
}
function pDur(){ if(pl.mode==="buf") return pl.buf?pl.buf.duration:0; return els.audio.duration||(state.data?state.data.durationSec:0)||0; }
function pCur(){
  if(pl.mode==="buf"){ var t=pl.playing&&pl.ac?pl.off+(pl.ac.currentTime-pl.t0):pl.off; return Math.max(0,Math.min(t,pDur())); }
  return els.audio.currentTime||0;
}
function setPlaying(on){ state.playing=on; pl.playing=on; els.play.textContent=on?"⏸ Pause":"▶ Play"; els.play.setAttribute("aria-label",on?"Pause":"Play");
  if(on) loop(); else { if(state.raf)cancelAnimationFrame(state.raf); syncUi(); } }
function bufStop(){ if(pl.src){ try{ pl.src.onended=null; pl.src.stop(); }catch(e){} pl.src=null; } }
function bufStart(at){
  var ac=ensureAc(); if(!ac||!pl.buf) return;
  bufStop(); var src=ac.createBufferSource(); src.buffer=pl.buf; src.connect(ac.destination);
  pl.off=Math.max(0,Math.min(at,pl.buf.duration)); pl.t0=ac.currentTime; src.start(0,pl.off); pl.src=src;
  src.onended=function(){ if(pl.src===src){ pl.src=null; pl.off=0; setPlaying(false); } };
  setPlaying(true);
}
function pSeek(sec){
  if(pl.mode==="buf"){ if(pl.playing) bufStart(sec); else pl.off=Math.max(0,Math.min(sec,pDur())); }
  else if(els.audio.getAttribute("src")){ try{ els.audio.currentTime=Math.min(sec,isFinite(els.audio.duration)?els.audio.duration:sec); }catch(e){} }
  syncUi();
}
function syncUi(){
  var dur=pDur(), cur=pCur();
  els.cur.textContent=fmt(cur); if(dur) els.dur.textContent=fmt(dur);
  els.seek.value=dur?String(Math.round(cur/dur*1000)):"0";
  drawRoll();
}
function loop(){ if(state.playing){ syncUi(); state.raf=requestAnimationFrame(loop); } }
els.play.addEventListener("click",function(){
  if(pl.mode==="buf"){ if(pl.playing){ pl.off=pCur(); bufStop(); setPlaying(false); } else bufStart(pl.off>=pDur()-0.01?0:pl.off); return; }
  if(!els.audio.getAttribute("src")){ els.perr.textContent="No audio yet. Press Render to make it here."; return; }
  if(els.audio.paused){ var p=els.audio.play(); if(p&&p.catch) p.catch(function(e){ els.perr.textContent="Playback was blocked ("+(e&&e.message||e)+"). Press Play again."; }); } else { els.audio.pause(); }
});
els.audio.addEventListener("play",function(){ if(pl.mode==="el") setPlaying(true); });
els.audio.addEventListener("pause",function(){ if(pl.mode==="el") setPlaying(false); });
els.audio.addEventListener("ended",function(){ if(pl.mode==="el") setPlaying(false); });
els.audio.addEventListener("timeupdate",function(){ if(!state.playing) syncUi(); });
els.audio.addEventListener("loadedmetadata",syncUi);
els.audio.addEventListener("error",function(){ if(pl.mode==="el") els.perr.textContent="The saved audio could not load here. Press Render to make it in this player, or use Download WAV."; });
els.seek.addEventListener("input",function(){ var dur=pDur(); if(dur) pSeek((Number(els.seek.value)/1000)*dur); });
els.roll.addEventListener("click",function(ev){
  var d=state.data; if(!d) return;
  var r=els.roll.getBoundingClientRect();
  var ratio=(ev.clientX-r.left)/Math.max(1,r.width);
  pSeek(ratio*tickToSec(d,totalTicks(d)));
});

/* ---------- in-browser render ----------
   Render: gbk_widget_render_start (job + capability token) -> fetch the pinned snapshot -> GbkWidgetRender.render()
   (OfflineAudioContext + SF2 AudioWorklet, progress, Stop, timeouts) -> play locally + blob download -> upload the WAV
   in chunks -> gbk_widget_render_finish (server verifies SHA-256/header, publishes WAV + MIDI artifacts). */
var RENDER_TIMEOUT_MS=15*60*1000;
var job={busy:false,ctl:null,info:null,pct:0,blobUrl:null};
function callToolRaw(name,args){
  var p;
  if(window.openai&&typeof window.openai.callTool==="function") p=Promise.resolve(window.openai.callTool(name,args||{}));
  else p=rpcRequest("tools/call",{name:name,arguments:args||{}});
  return p.then(function(r){
    r=r||{}; if(r.result&&!r.structuredContent&&!r.content) r=r.result;
    if(r.isError){ var t=r.content&&r.content[0]&&r.content[0].text; var e; try{ e=JSON.parse(t).error; }catch(x){ e={message:t||"tool failed"}; }
      var err=new Error((e&&e.message)||"tool failed"); err.code=e&&e.code; throw err; }
    return r.structuredContent||r;
  });
}
function setProg(frac,label){
  var pct=Math.max(job.pct,Math.round(Math.max(0,Math.min(1,frac))*100)); job.pct=pct;
  els.progBar.style.width=pct+"%"; els.progWrap.setAttribute("aria-valuenow",String(pct)); els.progPct.textContent=pct+"%";
  if(label) els.rstatus.textContent=label;
}
var STAGES={worklet:"Loading the audio engine…",soundfont:"Downloading the SoundFont (first time ~32 MB)…",loading:"Preparing…",resolving:"Resolving instruments…",rendering:"Rendering audio…",encoding:"Encoding WAV…",validating:"Checking the WAV…"};
function loadRenderer(){
  if(window.GbkWidgetRender) return Promise.resolve(window.GbkWidgetRender);
  return new Promise(function(resolve,reject){
    var sc=document.createElement("script"); sc.src=ORIGIN+"/api/mcp/widget/gbk-widget-render.js"; sc.async=true; sc.crossOrigin="anonymous";
    sc.onload=function(){ window.GbkWidgetRender?resolve(window.GbkWidgetRender):reject(new Error("renderer script loaded but did not initialise")); };
    sc.onerror=function(){ reject(new Error("could not load the renderer from "+ORIGIN+" (blocked by the host?)")); };
    document.head.appendChild(sc);
  });
}
function renderUi(busy){
  job.busy=busy; els.renderBtn.disabled=busy; els.stopBtn.classList.toggle("hidden",!busy);
  els.progWrap.classList.toggle("hidden",!busy&&job.pct===0);
}
function finishJob(ok,extra){
  var i=job.info; if(!i) return Promise.resolve(null);
  var args={jobId:i.jobId,token:i.token,ok:ok}; if(i.accessToken) args.accessToken=i.accessToken;
  if(ok) args.meta=extra; else { args.errorCode=extra.code||"RENDER_FAILED"; args.errorMessage=String(extra.message||extra).slice(0,1900); }
  return callToolRaw("gbk_widget_render_finish",args).catch(function(){ return null; });
}
function startRender(){
  var d=state.data; if(!d||job.busy) return;
  ensureAc(); // inside the click: unlocks audio output for later playback
  var ctl=new AbortController(); job.ctl=ctl; job.info=null; job.pct=0; setProg(0,"Starting…"); renderUi(true); els.perr.textContent="";
  var timer=setTimeout(function(){ job.timedOut=true; ctl.abort(); },RENDER_TIMEOUT_MS);
  var res=null;
  var startArgs={compositionId:d.compositionId,revision:d.revision};
  var tok=state.toolArgs&&state.toolArgs.accessToken; if(typeof tok==="string"&&tok) startArgs.accessToken=tok;
  // Account-free project opened with only a read capability: render + play locally, nothing is saved.
  var br=d.browserRender;
  var startJob=callToolRaw("gbk_widget_render_start",startArgs).catch(function(e){
    if(br&&br.snapshotUrl&&br.readAccessToken) return {localOnly:true,snapshotUrl:br.snapshotUrl,headers:{"x-gbk-project-token":br.readAccessToken},
      options:{sampleRate:44100,channels:2,format:"pcm16",normalize:"loudness",tailSeconds:3}};
    throw e;
  });
  Promise.all([loadRenderer(),startJob]).then(function(x){
    var R=x[0]; job.info=x[1].localOnly?null:x[1]; var src=x[1];
    if(job.info&&startArgs.accessToken) job.info.accessToken=startArgs.accessToken;
    if(ctl.signal.aborted) throw abortErr();
    return fetch(src.snapshotUrl,{headers:src.headers||{"x-gbk-render-token":src.token},signal:ctl.signal}).then(function(r){
      if(!r.ok) throw new Error("snapshot unavailable (HTTP "+r.status+")"); return r.json();
    }).then(function(snap){
      return R.render({base:ORIGIN,project:snap.project,options:src.options,signal:ctl.signal,onProgress:function(f,st){ setProg(f*0.95,STAGES[st]||st); }});
    });
  }).then(function(r){
    res=r; job.worklet=r.worklet; setProg(0.95,"Rendered "+fmt(r.durationSeconds)+". Preparing playback…");
    var name=((d.title||"gbk").replace(/[^\\w\\- .]/g,"_").slice(0,60)||"gbk")+".wav";
    try{ if(job.blobUrl) URL.revokeObjectURL(job.blobUrl); job.blobUrl=URL.createObjectURL(r.blob); els.wav.setAttribute("href",job.blobUrl); els.wav.setAttribute("download",name); els.wav.classList.remove("hidden"); }catch(e){}
    var ac=ensureAc();
    if(!ac) throw new Error("this browser has no AudioContext for playback; use Download WAV");
    return ac.decodeAudioData(r.bytes.slice().buffer).then(function(buf){
      bufStop(); els.audio.pause(); pl.mode="buf"; pl.buf=buf; pl.off=0; setPlaying(false);
      els.noRender.classList.add("hidden"); els.renderBtn.textContent="Re-render"; syncUi();
      if(!job.info) return {localOnly:true};
      setProg(0.96,"Ready to play. Saving the WAV to your GBK library…");
      return upload(r,ctl.signal);
    });
  }).then(function(fin){
    setProg(1,null);
    if(fin&&fin.localOnly){ els.rstatus.textContent="Done: "+fmt(res.durationSeconds)+" rendered in your browser. Press Play. (Not saved: this player only has read access; Download WAV saves it to your device.)"; return; }
    var w=fin&&fin.latest&&fin.latest.wav;
    if(fin&&fin.status==="completed"){
      if(w&&w.downloadUrl){ els.wav.setAttribute("href",w.downloadUrl); els.wav.removeAttribute("download"); els.wav.setAttribute("target","_blank"); }
      var m=fin.latest&&fin.latest.midi; if(m&&m.downloadUrl){ els.midi.setAttribute("href",m.downloadUrl); els.midi.classList.remove("hidden"); }
      d.artifacts={wav:w?{downloadUrl:w.downloadUrl,durationSeconds:res.durationSeconds}:undefined,midi:m};
      els.rstatus.textContent="Done: "+fmt(res.durationSeconds)+" rendered in your browser and saved. Press Play.";
    } else els.rstatus.textContent="Rendered and playable here, but saving to your library failed"+(fin&&fin.error?" ("+fin.error.message+")":"")+". Download WAV still works.";
  }).catch(function(e){
    var code=(e&&e.code)||""; var stopped=ctl.signal.aborted;
    var msg=stopped?(job.timedOut?"Render timed out and was stopped.":"Render stopped."):("Render failed: "+((e&&e.message)||String(e)));
    if(code==="UNAUTHENTICATED") msg="Sign in to GBK Composer in ChatGPT to render.";
    if(res&&!stopped) msg="Rendered and playable here, but saving failed: "+((e&&e.message)||e);
    els.rstatus.textContent=msg;
    finishJob(false,{code:stopped?"OPERATION_CANCELLED":(code||"RENDER_FAILED"),message:(e&&e.message)||String(e)});
  }).then(function(){ clearTimeout(timer); job.ctl=null; job.timedOut=false; renderUi(false); });
}
function abortErr(){ var e=new Error("cancelled"); e.code="OPERATION_CANCELLED"; return e; }
function upload(r,signal){
  var i=job.info, step=Math.max(65536,Math.min(i.chunkBytes||8388608,8388608)), off=0, b=r.bytes;
  function next(){
    if(off>=b.length) return null;
    var part=b.subarray(off,Math.min(off+step,b.length));
    return fetch(i.uploadUrl+"?offset="+off,{method:"PUT",headers:{"x-gbk-render-token":i.token,"content-type":"application/octet-stream"},body:part,signal:signal}).then(function(u){
      if(!u.ok) throw new Error("upload failed at byte "+off+" (HTTP "+u.status+")");
      off+=part.length; setProg(0.96+0.03*(off/b.length),null); return next();
    });
  }
  return Promise.resolve(next()).then(function(){
    var meta={sha256:r.sha256,durationSeconds:r.durationSeconds,musicSeconds:r.musicSeconds,tailSeconds:r.tailSeconds,sampleRate:r.sampleRate,channels:r.channels,format:r.format,
      framesRendered:r.framesRendered,byteLength:r.byteLength,peakDbFS:r.peakDbFS,rmsDbFS:r.rmsDbFS,clippedSamples:r.clippedSamples,gain:r.gain,validated:r.validated,
      loudness:r.loudness,instruments:r.instruments,warnings:r.warnings,soundFont:r.soundFont,noteCount:r.noteCount,renderMs:r.renderMs,worklet:r.worklet};
    var fa={jobId:i.jobId,token:i.token,ok:true,meta:meta}; if(i.accessToken) fa.accessToken=i.accessToken;
    return callToolRaw("gbk_widget_render_finish",fa);
  });
}
els.renderBtn.addEventListener("click",startRender);
els.stopBtn.addEventListener("click",function(){ if(job.ctl) job.ctl.abort(); });
els.wav.addEventListener("click",function(ev){
  var href=els.wav.getAttribute("href")||"";
  if(/^https?:/.test(href)&&window.openai&&typeof window.openai.openExternal==="function"){ ev.preventDefault(); try{ window.openai.openExternal({href:href,redirectUrl:false}); }catch(e){ window.open(href,"_blank"); } }
});

/* ---------- actions ---------- */
var zoomBtns=document.querySelectorAll("[data-zoom]");
zoomBtns.forEach(function(btn){
  btn.addEventListener("click",function(){
    state.zoom=Number(btn.getAttribute("data-zoom"))||1;
    zoomBtns.forEach(function(b){ b.setAttribute("aria-pressed",b===btn?"true":"false"); });
    drawRoll(); drawCC();
  });
});
els.refresh.addEventListener("click",function(){
  var d=state.data; if(!d) return;
  els.status.textContent="Refreshing…";
  callTool("gbk_get_artifacts",{compositionId:d.compositionId}).then(function(a){
    if(a&&a.artifacts) d.artifacts=a.artifacts;
    return callTool("gbk_get_composition",{compositionId:d.compositionId});
  }).then(function(fresh){
    if(fresh&&fresh.compositionId){ if(!fresh.artifacts&&d.artifacts) fresh.artifacts=d.artifacts; render(fresh); }
    else render(d);
    els.status.textContent="Refreshed at revision "+state.data.revision+".";
  }).catch(function(err){ els.status.textContent="Refresh failed: "+(err&&err.message?err.message:String(err)); });
});
els.form.addEventListener("submit",function(ev){
  ev.preventDefault();
  var text=els.follow.value.trim(); if(!text) return;
  var d=state.data;
  sendMessage((d?("For composition "+d.compositionId+" (revision "+d.revision+"): "):"")+text);
  els.follow.value=""; els.status.textContent="Follow-up sent to GBK Composer.";
});
window.addEventListener("resize",function(){ drawRoll(); drawCC(); });

initBridge();
window.__gbkPlayer={state:state,pl:pl,job:job,render:render,startRender:startRender};
})();
</script>
</body>
</html>
`;

/** The player HTML with a same-origin base (tests, screenshots). */
export const COMPOSER_UI_HTML = composerUiHtml("");
