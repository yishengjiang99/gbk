// MCP Apps UI resource for GBK Composer.
// Single self-contained HTML document: no external resources, vanilla JS only.
// Served by the MCP server as COMPOSER_UI_URI and rendered inside ChatGPT /
// other MCP Apps hosts. Data arrives via the ui/* postMessage bridge
// (ui/notifications/tool-result, structuredContent) with a window.openai
// fallback for ChatGPT-specific hosts.

export const COMPOSER_UI_URI = "ui://gbk/composer.html";

export const COMPOSER_UI_HTML = `<!doctype html>
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
  <div id="noRender" class="hidden" role="status">No render yet — ask GBK to render this composition.</div>

  <section id="playerSec" class="hidden" aria-label="Playback">
    <div class="row">
      <button id="playBtn" class="primary" type="button" aria-label="Play">▶ Play</button>
      <span class="time"><span id="curTime">0:00</span> / <span id="durTime">0:00</span></span>
      <input id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
    </div>
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
var COLORS=["#7aa2ff","#ff9f6e","#6ed3a5","#e58ad1","#ffd166","#6ec9e8","#b49aff","#ff7a7a","#9ede6e","#e8c07a","#7ad1c3","#c3a6ff"];
var state={data:null,zoom:1,highlight:{},anyHighlight:false,playing:false,raf:0};
var pending={}; var nextId=1;
var $=function(id){return document.getElementById(id);};
var els={title:$("title"),meta:$("metaLine"),rev:$("revLine"),loading:$("loading"),noRender:$("noRender"),
  player:$("playerSec"),rollSec:$("rollSec"),trackSec:$("trackSec"),actions:$("actionSec"),
  audio:$("audio"),play:$("playBtn"),seek:$("seek"),cur:$("curTime"),dur:$("durTime"),perr:$("playerErr"),
  scroll:$("rollScroll"),roll:$("roll"),ccWrap:$("ccWrap"),cc:$("cc"),tracks:$("trackList"),
  wav:$("dlWav"),midi:$("dlMidi"),studio:$("openStudio"),refresh:$("refreshBtn"),
  status:$("statusLine"),form:$("followForm"),follow:$("followText")};

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
    if(a&&a.structuredContent) render(a.structuredContent);
  } else if(msg.method==="ui/notifications/host-context-changed"){
    if(msg.params&&msg.params.theme) applyTheme(msg.params.theme);
  }
});

function initBridge(){
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
  els.noRender.classList.toggle("hidden",hasWav);
  els.player.classList.remove("hidden");
  if(hasWav){
    if(els.audio.getAttribute("src")!==art.wav.downloadUrl) els.audio.setAttribute("src",art.wav.downloadUrl);
    els.dur.textContent=fmt(art.wav.durationSeconds||data.durationSec||0);
  }
  els.wav.classList.toggle("hidden",!hasWav);
  if(hasWav) els.wav.setAttribute("href",art.wav.downloadUrl);
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
  var curSec=els.audio.currentTime||0;
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

/* ---------- playback ---------- */
function syncUi(){
  var dur=els.audio.duration||(state.data?state.data.durationSec:0)||0;
  var cur=els.audio.currentTime||0;
  els.cur.textContent=fmt(cur); if(dur) els.dur.textContent=fmt(dur);
  els.seek.value=dur?String(Math.round(cur/dur*1000)):"0";
  drawRoll();
}
function loop(){ if(state.playing){ syncUi(); state.raf=requestAnimationFrame(loop); } }
els.play.addEventListener("click",function(){
  if(!els.audio.getAttribute("src")){ els.perr.textContent="No WAV render is available yet."; return; }
  if(els.audio.paused){ els.audio.play(); } else { els.audio.pause(); }
});
els.audio.addEventListener("play",function(){ state.playing=true; els.play.textContent="⏸ Pause"; els.play.setAttribute("aria-label","Pause"); loop(); });
els.audio.addEventListener("pause",function(){ state.playing=false; els.play.textContent="▶ Play"; els.play.setAttribute("aria-label","Play"); if(state.raf)cancelAnimationFrame(state.raf); syncUi(); });
els.audio.addEventListener("ended",function(){ state.playing=false; });
els.audio.addEventListener("timeupdate",function(){ if(!state.playing) syncUi(); });
els.audio.addEventListener("loadedmetadata",syncUi);
els.audio.addEventListener("error",function(){ els.perr.textContent="Audio failed to load. Use Download WAV instead."; });
els.seek.addEventListener("input",function(){
  var dur=els.audio.duration||0; if(dur) els.audio.currentTime=(Number(els.seek.value)/1000)*dur;
  syncUi();
});
els.roll.addEventListener("click",function(ev){
  var d=state.data; if(!d) return;
  var r=els.roll.getBoundingClientRect();
  var ratio=(ev.clientX-r.left)/Math.max(1,r.width);
  var sec=ratio*tickToSec(d,totalTicks(d));
  if(els.audio.getAttribute("src")&&isFinite(els.audio.duration)) els.audio.currentTime=Math.min(sec,els.audio.duration||sec);
  else { try{ els.audio.currentTime=sec; }catch(e){} }
  syncUi();
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
})();
</script>
</body>
</html>
`;
