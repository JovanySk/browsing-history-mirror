
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const PAGE_STEP=100;

let currentView="history", renderLimit=PAGE_STEP;
let currentRecords=[], totalCount=0, deletedCount=0, loading=false, pendingLiveChanges=0;
let searchTimer=null;
let presenceState=null, localDeviceId=null, presenceTimer=null;
let deviceLabels={};

const VIEW_COPY={
  history:["Historial completo","Cada visita de tus dispositivos, copiada en tiempo real."],
  deleted:["Borrado de Chrome","Visitas que ya no están en Chrome. El espejo conserva la copia."],
  sites:["Sitios","Los dominios que más visitas, con sus borrados detectados."]
};
const ICONS={
  chevron:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  laptop:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20"/></svg>',
  phone:'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>',
  empty:'<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
};

function esc(s){return String(s??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));}
function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,"")}catch{return""}}
function fmtNum(n){return Number(n||0).toLocaleString("es-MX")}

function normalizePresenceUrl(url){
  try{
    const u=new URL(url||"");
    u.hash="";
    const entries=[...u.searchParams.entries()].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
    u.search="";
    for(const [k,v] of entries)u.searchParams.append(k,v);
    return u.toString();
  }catch{return String(url||"")}
}

function presenceMatchesUrl(url){
  if(!presenceState?.active || !presenceState.url) return false;
  if(Date.now()-Number(presenceState.lastSeenAt||0)>90000) return false;
  return normalizePresenceUrl(url)===normalizePresenceUrl(presenceState.url);
}

function durationShort(ms){
  ms=Math.max(0,Number(ms||0));
  const s=Math.floor(ms/1000);
  if(s<60)return`${s} s`;
  const m=Math.floor(s/60);
  if(m<60)return`${m} min`;
  const h=Math.floor(m/60);
  if(h<48)return`${h} h ${m%60} min`;
  return`${Math.floor(h/24)} días`;
}

function presenceFreshness(){
  if(!presenceState) return Infinity;
  return Date.now()-Number(presenceState.lastSeenAt||0);
}

// Favicons are looked up per site, so one stored icon serves every page of that host.
function faviconUrl(url){const h=hostOf(url);return "/api/favicon?url="+encodeURIComponent(h?"https://"+h+"/":String(url||""))}
function hueOf(text){let h=0;for(const ch of String(text))h=(h*31+ch.charCodeAt(0))>>>0;return h%360}
function avatar(url,domain){
  const host=domain||hostOf(url)||"?",letter=(host.replace(/^(www|m)\./,"")[0]||"?").toUpperCase();
  return `<span class="avatar" style="--h:${hueOf(host)}" data-letter="${esc(letter)}"><img src="${esc(faviconUrl(url||""))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;
}
function deviceChip(id){
  if(!id)return"";
  const label=deviceLabels[id]||id,phone=/phone|m[oó]vil|celular|android|iphone/i.test(label);
  return `<span class="dev">${phone?ICONS.phone:ICONS.laptop}${esc(label)}</span>`;
}
function ownUrl(url){try{return String(url||"").startsWith(chrome.runtime.getURL(""))}catch{return false}}
function fmtTime(ms){return new Date(ms).toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit",hour12:false})}
function fmtFull(ms){return new Date(ms).toLocaleString("es-MX",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",hour12:false})}
function dateKey(ms){const d=new Date(ms);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function dayParts(ms){
  const d=new Date(ms),t=new Date(),y=new Date();y.setDate(t.getDate()-1);
  const same=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
  const weekday=d.toLocaleDateString("es-MX",{weekday:"long"}),date=d.toLocaleDateString("es-MX",{day:"numeric",month:"long",...(d.getFullYear()!==t.getFullYear()?{year:"numeric"}:{})});
  if(same(d,t))return["Hoy",`${weekday} ${date}`];
  if(same(d,y))return["Ayer",`${weekday} ${date}`];
  return[weekday,date];
}
function fmtDate(ms){return dayParts(ms).join(" · ")}
// The count is shown only when the whole day fits on the current page.
function dayHeader(ms,count,complete=true){
  const label=complete?`<span class="dayCount">${fmtNum(count)} ${count===1?"visita":"visitas"}</span>`:"";
  if(ms==null)return`<div class="dayHeader"><span class="dayName">Sin fecha</span>${label}</div>`;
  const [name,date]=dayParts(ms);
  return`<div class="dayHeader"><span class="dayName">${esc(name)}</span><span class="dayDate">${esc(date)}</span>${label}</div>`;
}

function statusOf(v){if(v.chromeState==="deleted")return"deleted";if(v.chromeState==="present")return"present";return"unknown"}
// Present visits stay quiet; only deleted or unverified visits get a visible tag.
function statusTag(v){const s=statusOf(v);if(s==="deleted")return`<span class="tag deleted"><span class="statusDot"></span>Borrada de Chrome</span>`;if(s==="present")return"";return`<span class="tag unknown"><span class="statusDot"></span>Sin verificar</span>`}
function statusText(v){const s=statusOf(v);return s==="deleted"?"La copia sigue aquí, pero esta visita ya no aparece en Chrome.":s==="present"?"Esta visita sigue en Chrome.":"Todavía no se verificó."}
// The bar only appears for slow loads, so the 2-second live refresh does not flicker.
let loadingTimer=null;
function setLoading(on){loading=on;clearTimeout(loadingTimer);if(on)loadingTimer=setTimeout(()=>$("#loadingBar").classList.add("show"),350);else $("#loadingBar").classList.remove("show")}
function filters(){return{q:$("#q").value.trim(),from:$("#from").value?new Date($("#from").value+"T00:00:00").getTime():-Infinity,to:$("#to").value?new Date($("#to").value+"T23:59:59.999").getTime():Infinity}}

// One row component for the timeline and the deleted view.
function rowHTML(v,{key,time,isNew=false}={}){
  const url=v.url||"",safeUrl=/^https?:\/\//i.test(url)?url:"",domain=v.domain||hostOf(url),title=v.title||"(sin título)",when=time??v.visitTime??v.eventTime;
  let tags="";
  if(isNew)tags+=`<span class="tag fresh">Nueva</span>`;
  if(presenceMatchesUrl(url))tags+=`<span class="tag live"><span class="statusDot"></span>Activo ahora</span>`;
  if(v.playingAudio)tags+=`<span class="tag playing"><span aria-hidden="true">♫</span> Reproduciendo</span>`;
  tags+=statusTag(v);
  const classes=["row"];if(statusOf(v)==="deleted")classes.push("is-deleted");if(isNew)classes.push("is-new");
  return`<article class="${classes.join(" ")}" data-key="${esc(key??v.fingerprint)}">
  <time class="rowTime" datetime="${when?esc(new Date(when).toISOString()):""}">${esc(when?fmtTime(when):"--:--")}</time>
  ${avatar(url,domain)}
  <div class="rowMain"><div class="rowTitle">${safeUrl?`<a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${esc(title)}</a>`:esc(title)}</div><div class="rowMeta"><span class="rowHost">${esc(domain)}</span>${deviceChip(v.captureDevice)}</div></div>
  <div class="rowSide">${tags}</div>
  <details class="rowDetails"><summary aria-label="Ver detalles">${ICONS.chevron}</summary><div class="detailBody"><dl>
    <dt>Fecha de visita</dt><dd>${when?esc(fmtFull(when)):"-"}</dd>
    <dt>Estado en Chrome</dt><dd>${esc(statusText(v))}</dd>
    ${v.deletedAt?`<dt>Borrado de Chrome</dt><dd>${esc(fmtFull(v.deletedAt))}</dd>`:""}
    ${v.captureDevice?`<dt>Dispositivo de captura</dt><dd>${esc(deviceLabels[v.captureDevice]||v.captureDevice)}</dd>`:""}
    ${safeUrl?`<dt>Dirección</dt><dd class="detailurl">${esc(safeUrl)}</dd>`:""}
    <dt>Copiado al espejo</dt><dd>${v.capturedAt?esc(fmtFull(v.capturedAt)):"-"}</dd>
  </dl>${safeUrl?`<div class="detailActions"><button class="smallBtn openUrl" data-url="${esc(safeUrl)}">Abrir página</button><button class="smallBtn copyUrl" data-url="${esc(safeUrl)}">Copiar URL</button></div>`:""}</div></details>
</article>`;
}
function buildEntry(v){return rowHTML(v)}
function bindEntries(){
  $$(".openUrl").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();chrome.tabs.create({url:b.dataset.url})}));
  $$(".copyUrl").forEach(b=>b.addEventListener("click",async e=>{e.stopPropagation();try{await navigator.clipboard.writeText(b.dataset.url);const x=b.textContent;b.textContent="Copiada";setTimeout(()=>b.textContent=x,900)}catch{}}));
}
function emptyState(text){return`<div class="empty">${ICONS.empty}<div>${esc(text)}</div></div>`}
function renderHistory(records){
  if(!records.length){$("#content").innerHTML=emptyState("No hay visitas para estos filtros.");return}
  const groups=new Map(),partial=records.length>=renderLimit;for(const v of records){const k=dateKey(v.visitTime);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(v)}
  const last=[...groups.values()].at(-1);let html="";for(const items of groups.values()){html+=`<section class="day">${dayHeader(items[0].visitTime,items.length,!(partial&&items===last))}<div class="entries">${items.map(v=>rowHTML(v)).join("")}</div></section>`}
  $("#content").innerHTML=html;bindEntries()
}
async function loadSites(){
  const arr=(await getAggregationSample(5000)).filter(v=>!ownUrl(v.url)),map=new Map();
  for(const v of arr){const h=hostOf(v.url)||"(sin dominio)",x=map.get(h)||{count:0,last:v,deleted:0};x.count++;if(statusOf(v)==="deleted")x.deleted++;if(v.visitTime>x.last.visitTime)x.last=v;map.set(h,x)}
  const sites=[...map.entries()].sort((a,b)=>b[1].count-a[1].count),top=sites[0]?.[1].count||1;
  $("#pagerTop").innerHTML="";$("#archiveCounts").textContent="";$("#toolbarMeta").textContent=`${fmtNum(sites.length)} sitios en las últimas ${fmtNum(arr.length)} visitas`;$("#loadMoreWrap").style.display="none";
  $("#content").innerHTML=sites.length?`<div class="siteList">${sites.map(([h,x])=>`<div class="siteRow">${avatar(x.last.url,h)}<div style="min-width:0"><div class="siteName">${esc(h)}</div><div class="siteMeta">Última visita: ${esc(fmtFull(x.last.visitTime))}</div></div><div class="siteBar" aria-hidden="true"><span style="width:${Math.max(2,Math.round(x.count/top*100))}%"></span></div><div class="siteCount">${fmtNum(x.count)} visitas<small>${x.deleted?`<span class="danger">${fmtNum(x.deleted)} ${x.deleted===1?"borrada":"borradas"}</span>`:"sin borrados detectados"}</small></div></div>`).join("")}</div>`:emptyState("No hay sitios.")
}
async function loadDeletedNotice(){
  const ev=(await getRecentEvents(60)).filter(e=>e.type==="chrome_history_deleted"),n=$("#notice");if(ev.length){n.classList.add("show");n.textContent=`${ev.length} ${ev.length===1?"borrado detectado":"borrados detectados"} en Chrome, el último el ${fmtFull(ev[0].time)}. El espejo conservó las copias.`}else n.classList.remove("show")
}
async function exportCSV(){setLoading(true);try{const arr=(await getAggregationSample(100000)).filter(v=>!ownUrl(v.url)).sort((a,b)=>a.visitTime-b.visitTime),q=v=>`"${String(v??"").replace(/"/g,'""')}"`,lines=[["fecha_hora","timestamp_ms","titulo","url","dominio","estado_chrome","borrado_en"].map(q).join(",")];for(const v of arr){lines.push([new Date(v.visitTime).toLocaleString(),v.visitTime,v.title||"",v.url||"",hostOf(v.url),statusOf(v),v.deletedAt?new Date(v.deletedAt).toLocaleString():""].map(q).join(","))}const blob=new Blob(["﻿"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`historial_espejo_${dateKey(Date.now())}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}finally{setLoading(false)}}


async function fetchPresenceState(){
  try{
    const localInfo=await new Promise(resolve=>{
      chrome.runtime.sendMessage({type:"presence_get_local_info"},r=>resolve(r||{}));
    });
    localDeviceId=localInfo.deviceId||null;

    const sync=await chrome.storage.sync.get("sharedPresence");
    presenceState=sync.sharedPresence||null;
    renderPresenceState();
  }catch{
    presenceState=null;
    renderPresenceState();
  }
}

function renderPresenceState(){
  const card=$("#presenceCard"), status=$("#presenceStatus"), title=$("#presenceTitle"), sub=$("#presenceSub"),
        url=$("#presenceUrl"), device=$("#presenceDevice"),
        elapsed=$("#presenceElapsed"), signal=$("#presenceSignal");

  if(!presenceState){
    card.dataset.state="idle";
    status.innerHTML='<span class="liveDot idle"></span> Sin señal';
    title.textContent="Esperando un dispositivo que comparta su pestaña activa…";
    sub.textContent='Activa “Emitir presencia” únicamente en el dispositivo que quieras compartir.';
    url.textContent="";
    device.textContent="-";
    elapsed.textContent="-";
    signal.textContent="-";
    return;
  }

  const age=presenceFreshness();
  const stale=age>90000;
  const sameDevice=localDeviceId && presenceState.deviceId===localDeviceId;
  const deviceLabel=presenceState.deviceName || `${presenceState.deviceType||""} ${presenceState.platform||""}`.trim() || "Dispositivo";

  if(stale){
    card.dataset.state="stale";
    status.innerHTML='<span class="liveDot warn"></span> Sin señal reciente';
    title.textContent=presenceState.title || presenceState.host || "Última página conocida";
    sub.textContent=`No se puede confirmar que siga ahí. Última señal hace ${durationShort(age)}${sameDevice?" · este dispositivo":""}.`;
  }else if(presenceState.active){
    card.dataset.state="active";
    status.innerHTML='<span class="liveDot"></span> Activo ahora';
    title.textContent=presenceState.title || presenceState.host || "Página web";
    sub.textContent=`${presenceState.host||"Sitio web"} · ${sameDevice?"este dispositivo":"otro dispositivo"} · Chrome enfocado`;
  }else{
    card.dataset.state="stale";
    status.innerHTML='<span class="liveDot warn"></span> Chrome no está activo';
    title.textContent=presenceState.title || presenceState.host || "Última página conocida";
    sub.textContent=`La última página quedó registrada, pero la ventana de Chrome no está enfocada${sameDevice?" · este dispositivo":""}.`;
  }

  url.textContent=presenceState.url||"";
  device.textContent=deviceLabel;
  elapsed.textContent=(presenceState.active&&presenceState.since)?durationShort(Date.now()-presenceState.since):"-";
  signal.textContent=stale?"hace "+durationShort(age):"ahora";

  if(["history","deleted"].includes(currentView) && currentRecords.length){
    for(const row of $$(".row")){
      const link=row.querySelector(".rowTitle a"),side=row.querySelector(".rowSide");if(!link||!side)continue;
      const active=presenceMatchesUrl(link.href),tag=side.querySelector(".tag.live");
      if(active&&!tag)side.insertAdjacentHTML("afterbegin",'<span class="tag live"><span class="statusDot"></span>Activo ahora</span>');
      if(!active&&tag)tag.remove();
    }
  }
}

async function refreshPresenceToggle(){
  const info=await new Promise(resolve=>{
    chrome.runtime.sendMessage({type:"presence_get_local_info"},r=>resolve(r||{}));
  });
  localDeviceId=info.deviceId||null;
  const on=!!info.enabled,button=$("#presenceToggle");
  button.textContent=`Emitir presencia: ${on?"ON":"OFF"}`;
  button.classList.toggle("on",on);
  button.title=on
    ? `Este dispositivo está compartiendo su pestaña activa${info.deviceName?` como “${info.deviceName}”`:""}.`
    : "Comparte la pestaña web activa del dispositivo de captura seleccionado. Déjalo desactivado en el equipo que solo recibe.";
}

$("#presenceToggle").addEventListener("click",async()=>{
  const info=await new Promise(resolve=>{
    chrome.runtime.sendMessage({type:"presence_get_local_info"},r=>resolve(r||{}));
  });

  if(info.enabled){
    await new Promise(resolve=>{
      chrome.runtime.sendMessage({type:"presence_disable"},()=>resolve());
    });
    await refreshPresenceToggle();
    await fetchPresenceState();
    return;
  }

  let name=String(info.deviceName||"").trim();
  if(!name){
    name=prompt(
      "Nombre para identificar el dispositivo de captura seleccionado.\n\nEjemplo: Mi laptop\n\nSolo actívalo en un dispositivo cuyo usuario sepa y acepte compartir su pestaña activa.",
      `${info.deviceType||"Computadora"} · ${info.platform||""}`.trim()
    );
    if(name===null)return;
    name=String(name).trim();
  }

  await new Promise(resolve=>{
    chrome.runtime.sendMessage({type:"presence_enable",deviceName:name},()=>resolve());
  });
  await refreshPresenceToggle();
  await fetchPresenceState();
});

chrome.storage.onChanged.addListener((changes, area)=>{
  if(area==="sync" && changes.sharedPresence){
    presenceState=changes.sharedPresence.newValue||null;
    renderPresenceState();
  }
});

function showSnackbar(text){$("#snackbarText").textContent=text;$("#snackbar").classList.add("show")}function hideSnackbar(){$("#snackbar").classList.remove("show");pendingLiveChanges=0}
function activeNav(v){
  $$(".navitem").forEach(n=>n.classList.toggle("active",n.dataset.view===v));
  $$("#mobileTabs button").forEach(b=>b.classList.toggle("active",b.dataset.view===v));
  if(v!=="history"){$("#freshPill").hidden=true;seenIds=null;}
  const [title,sub]=VIEW_COPY[v]||VIEW_COPY.history;$("#viewTitle").textContent=title;$("#viewSub").textContent=sub;
}

chrome.runtime.onMessage.addListener(message=>{
  if(message?.type!=="mirror-change")return;
  if(message.kind==="delete"){loadView({preserveScroll:true});return}
  if(window.scrollY<350&&currentView==="history"&&!$("#q").value){renderLimit=PAGE_STEP;loadView()}else{pendingLiveChanges++;showSnackbar(`${pendingLiveChanges} ${pendingLiveChanges===1?"visita nueva":"visitas nuevas"}`)}
});


$("#verify").addEventListener("click",()=>verifyVisible({manual:true}));$("#import").addEventListener("click",importCurrentHistory);$("#export").addEventListener("click",exportCSV);
$("#loadMore").addEventListener("click",async()=>{renderLimit+=PAGE_STEP;await loadView({preserveScroll:true})});
$("#q").addEventListener("input",()=>{$("#searchBox").classList.toggle("hasValue",!!$("#q").value);clearTimeout(searchTimer);searchTimer=setTimeout(()=>{renderLimit=PAGE_STEP;loadView()},180)});
$("#clearSearch").addEventListener("click",()=>{$("#q").value="";$("#searchBox").classList.remove("hasValue");renderLimit=PAGE_STEP;loadView();$("#q").focus()});
document.addEventListener("keydown",e=>{if(e.key==="/"&&!/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName||"")){e.preventDefault();$("#q").focus()}if(e.key==="Escape"&&document.activeElement===$("#q")&&$("#q").value)$("#clearSearch").click()});
$("#from").addEventListener("change",()=>{renderLimit=PAGE_STEP;loadView()});$("#to").addEventListener("change",()=>{renderLimit=PAGE_STEP;loadView()});
$$(".navitem").forEach(n=>n.addEventListener("click",()=>{currentView=n.dataset.view;activeNav(currentView);renderLimit=PAGE_STEP;loadView()}));
$$("#mobileTabs button").forEach(b=>b.addEventListener("click",()=>$(`.navitem[data-view="${b.dataset.view}"]`).click()));
$("#snackbarAction").addEventListener("click",()=>{hideSnackbar();renderLimit=PAGE_STEP;window.scrollTo({top:0,behavior:"smooth"});setTimeout(()=>loadView(),180)});
window.addEventListener("focus",()=>{if(!loading)loadView({preserveScroll:true})});

// Web commands run in the connected capture extension; this page never reads a device's history directly.
function autoVerifyVisible(){}
async function verifyUrls(urls){
  const unique=[...new Set(urls.filter(Boolean))];if(!unique.length)return;
  try{await webCommand({type:'verify_urls',urls:unique});}catch(error){webError(error);throw error;}
}
async function verifyVisible(){
  const button=$('#verify');button.disabled=true;
  try{await verifyUrls(currentRecords.map(v=>v.url));await loadView({preserveScroll:true});}
  catch(error){showSnackbar(error.message);}finally{button.disabled=false;}
}
async function importCurrentHistory(){
  const button=$('#import');button.disabled=true;$('#liveText').textContent='Importando…';
  try{await webCommand({type:'import_chrome'});renderLimit=PAGE_STEP;await loadView();}
  catch(error){webError(error);showSnackbar(error.message);}finally{button.disabled=false;await webHeartbeat();}
}

// Paged timeline served by the persistent index on the server.
let archiveOffset=0,archiveHours=null,archiveFilterKey='',archiveRequestedKey='',archiveAsOf=0,archiveFreshRetry=null;
// Live indicator: ids seen on the first page of the current filter, and rows that just arrived.
let seenKey='',seenIds=null,freshUntil=new Map(),freshTimer=null;
function archiveVisibility(){$('#archiveControls').hidden=currentView!=='history';}
function archiveEntry(item,isNew=false){return rowHTML(item,{key:item.id,time:item.eventTime,isNew});}
function markFresh(entries,key){
  if(archiveOffset){return;}
  const now=Date.now(),ids=entries.map(item=>item.id),sameKey=seenKey===key&&seenIds;
  if(sameKey){
    const arrived=ids.filter(id=>!seenIds.has(id));
    for(const id of arrived)freshUntil.set(id,now+15000);
    if(arrived.length){
      $('#freshText').textContent=arrived.length===1?'1 visita nueva':`${fmtNum(arrived.length)} visitas nuevas`;
      $('#freshPill').hidden=false;$('#livePill').classList.remove('flash');void $('#livePill').offsetWidth;$('#livePill').classList.add('flash');
      clearTimeout(freshTimer);freshTimer=setTimeout(()=>{$('#freshPill').hidden=true;},15000);
    }
  }else{freshUntil.clear();$('#freshPill').hidden=true;}
  seenIds=new Set([...(sameKey?seenIds:[]),...ids]);seenKey=key;
  for(const [id,until] of freshUntil)if(until<now)freshUntil.delete(id);
}
async function loadTimeline(){
  archiveVisibility();
  let f=filters(),from=Number.isFinite(f.from)?f.from:null,to=Number.isFinite(f.to)?f.to:null;
  if(archiveHours){from=archiveHours.from;to=archiveHours.to;}
  const key=[window.webSource,currentView,f.q,from,to].join('|');
  if(key!==archiveFilterKey){archiveOffset=0;archiveAsOf=0;archiveFilterKey=key;$('#archiveLiveNew').hidden=true;$('#content').innerHTML='<div class="empty">Cargando las visitas de esta selección…</div>';}
  const query=new URLSearchParams({source:window.webSource||'all',q:f.q,offset:String(archiveOffset),limit:'100'});
  if(from!=null)query.set('from',String(from));if(to!=null)query.set('to',String(to));
  if(archiveOffset&&archiveAsOf)query.set('asof',String(archiveAsOf));
  const requestKey=query.toString();archiveRequestedKey=requestKey;
  const data=await webJSON('/api/timeline?'+query);
  if(requestKey!==archiveRequestedKey||currentView!=='history')return;
  if(!archiveOffset&&(typeof lastMeta!=='undefined'&&Number(data.revision)<Number(lastMeta))&&!archiveFreshRetry){
    archiveFreshRetry=setTimeout(()=>{archiveFreshRetry=null;if(currentView==='history'&&!archiveOffset)queueLiveRefresh();},500);
  }
  $('#archiveCounts').textContent=`${fmtNum(data.chromeCount)} visitas en el índice${data.indexing?' · preparando el índice completo…':''}`;
  $('#toolbarMeta').textContent=data.total?`${fmtNum(archiveOffset+1)}-${fmtNum(Math.min(archiveOffset+100,data.total))} de ${fmtNum(data.total)} ${f.q?'resultados':'visitas'}`:'Sin resultados';
  $('#loadMoreWrap').style.display='none';
  currentRecords=data.entries;
  markFresh(data.entries,key);
  const entering=new Set([...document.querySelectorAll('.row')].map(row=>row.dataset.key));
  let output='',groups=[];
  $('#pagerTop').innerHTML=data.total>100?`<button data-archive-page="${Math.max(0,archiveOffset-100)}" ${archiveOffset?'':'disabled'} aria-label="Más recientes">‹</button><button data-archive-page="${archiveOffset+100}" ${data.hasMore?'':'disabled'} aria-label="Más antiguas">›</button>`:'';
  for(const item of data.entries){
    const day=item.eventTime?dateKey(item.eventTime):'undated';
    if(!groups.length||groups[groups.length-1].day!==day)groups.push({day,time:item.eventTime||null,items:[]});
    groups[groups.length-1].items.push(item);
  }
  groups.forEach((group,index)=>{group.complete=!(index===0&&archiveOffset)&&!(index===groups.length-1&&data.hasMore);});
  for(const group of groups)output+=`<section class="day">${dayHeader(group.time,group.items.length,group.complete)}<div class="entries">${group.items.map(item=>archiveEntry(item,freshUntil.has(item.id))).join('')}</div></section>`;
  if(!data.entries.length)output=emptyState(f.q?`Sin resultados para “${f.q}”.`:'No hay visitas para estos filtros.');
  else output+=`<div class="pagination">${archivePagerInner(data)}</div>`;
  const expanded=new Set([...document.querySelectorAll('.row details[open]')].map(detail=>detail.closest('.row').dataset.key));
  $('#content').innerHTML=output;
  for(const article of document.querySelectorAll('.row')){
    if(expanded.has(article.dataset.key))article.querySelector('details').open=true;
    if(article.classList.contains('is-new')&&entering.size&&!entering.has(article.dataset.key))article.classList.add('enter');
  }
  bindEntries();
  for(const button of document.querySelectorAll('[data-archive-page]:not(:disabled)'))button.addEventListener('click',async()=>{if(!archiveAsOf)archiveAsOf=Date.now();archiveOffset=Number(button.dataset.archivePage);if(!archiveOffset)archiveAsOf=0;await loadTimeline();$('#filters').scrollIntoView({block:'start'});});
}
function archivePagerInner(data){
  return `${archiveOffset?`<button class="pillBtn" data-archive-page="${Math.max(0,archiveOffset-100)}">← Más recientes</button>`:''}<span>Página ${fmtNum(Math.floor(archiveOffset/100)+1)} de ${fmtNum(Math.max(1,Math.ceil(data.total/100)))}</span>${data.hasMore?`<button class="pillBtn" data-archive-page="${archiveOffset+100}">Más antiguas →</button>`:''}`;
}
function archivePager(data){return `<div class="pagination">${archivePagerInner(data)}</div>`;}
$('#archiveLiveNew').addEventListener('click',()=>{archiveOffset=0;archiveAsOf=0;$('#archiveLiveNew').hidden=true;loadView();});
window.archiveDataArrived=()=>{if(archiveOffset)$('#archiveLiveNew').hidden=false;};
async function loadHistoryLike(){
  archiveVisibility();
  if(currentView==='deleted'){
    $('#pagerTop').innerHTML='';const f=filters();currentRecords=await queryVisits({limit:renderLimit,q:f.q,from:f.from,to:f.to,deletedOnly:true});renderHistory(currentRecords);
    $('#toolbarMeta').textContent=`${fmtNum(currentRecords.length)} visitas borradas cargadas`;$('#archiveCounts').textContent='';$('#loadMoreWrap').style.display=currentRecords.length>=renderLimit?'flex':'none';return;
  }
  return loadTimeline();
}
$('#archiveRange').addEventListener('change',()=>{
  const value=$('#archiveRange').value,day=new Date();day.setHours(0,0,0,0);let from=null,to=null;
  if(value==='today'){from=day.getTime();to=from+86400000-1;}
  if(value==='yesterday'){to=day.getTime()-1;from=day.getTime()-86400000;}
  if(value==='last3'){from=day.getTime()-2*86400000;to=day.getTime()+86400000-1;}
  if(value==='last7'){from=day.getTime()-6*86400000;to=day.getTime()+86400000-1;}
  archiveHours=from==null?null:{from,to};$('#from').value=from==null?'':dateKey(from);$('#to').value=to==null?'':dateKey(to);archiveOffset=0;syncRangeButtons();loadView();
});
function syncRangeButtons(){const value=$('#archiveRange').value;$$('#rangeSeg .seg').forEach(b=>b.classList.toggle('active',b.dataset.range===value));}
$$('#rangeSeg .seg').forEach(b=>b.addEventListener('click',()=>{$('#archiveRange').value=b.dataset.range;$('#archiveRange').dispatchEvent(new Event('change'));}));
for(const id of ['#from','#to'])$(id).addEventListener('change',()=>{archiveHours=null;$('#archiveRange').value='all';syncRangeButtons();},{capture:true});
for(const nav of document.querySelectorAll('.navitem'))nav.addEventListener('click',archiveVisibility);
archiveVisibility();

// Device chips drive the hidden #webSource select that web-runtime.js owns.
function chooseSource(id){const select=$('#webSource');if(select.value===id)return;select.value=id;select.dispatchEvent(new Event('change'));renderDevices(lastDevices,lastNow);}
let lastDevices=[],lastNow=Date.now();
function renderDevices(devices,now){
  lastDevices=devices;lastNow=now;const source=window.webSource||'all',online=d=>now-d.last_seen<90000;
  const chips=[`<button class="chip${source==='all'?' active':''}" data-source="all">Todos</button>`,...devices.map(d=>`<button class="chip${source===d.id?' active':''}" data-source="${esc(d.id)}"><span class="devDot${online(d)?' on':''}"></span>${esc(d.label)}</button>`)].join('');
  if($('#deviceChips').innerHTML!==chips){$('#deviceChips').innerHTML=chips;$$('#deviceChips .chip').forEach(c=>c.addEventListener('click',()=>chooseSource(c.dataset.source)));}
  const side=devices.map(d=>`<button class="sideDevice${source===d.id?' active':''}" data-source="${esc(d.id)}" title="${online(d)?'Conectado ahora':'Última señal: '+esc(fmtFull(d.last_seen))}"><span class="devDot${online(d)?' on':''}"></span>${esc(d.label)}<small>${online(d)?'en línea':'hace '+esc(durationShort(now-d.last_seen))}</small></button>`).join('');
  if($('#sideDevices').innerHTML!==side){$('#sideDevices').innerHTML=side;$$('#sideDevices .sideDevice').forEach(c=>c.addEventListener('click',()=>chooseSource(source===c.dataset.source?'all':c.dataset.source)));}
}

// Header numbers: cheap counts every refresh, heavier ones at most once a minute or on new data.
let extraStats={key:'',at:0,revision:null,today:null,sites:null,sample:0};
async function refreshExtraStats(meta){
  const key=window.webSource||'all',stale=extraStats.key!==key||Date.now()-extraStats.at>60000||extraStats.revision!==meta.revision;
  if(!stale)return;
  extraStats={...extraStats,key,at:Date.now(),revision:meta.revision};
  const day=new Date();day.setHours(0,0,0,0);
  const query=new URLSearchParams({source:key,q:'',offset:'0',limit:'1',from:String(day.getTime()),to:String(day.getTime()+86400000-1)});
  const [today,sample]=await Promise.all([webJSON('/api/timeline?'+query).catch(()=>null),getAggregationSample(5000).catch(()=>null)]);
  if(today)extraStats.today=today.total;
  if(sample){extraStats.sites=new Set(sample.map(v=>hostOf(v.url)).filter(Boolean)).size;extraStats.sample=sample.length;}
}

// Keep the visible list usable while a transient network/server failure recovers.
var webViewAgain=false,webViewRetry=null;
async function refreshStats(){
  const meta=await getWebMeta();totalCount=meta.counts.visits;deletedCount=meta.counts.deleted||0;
  deviceLabels=Object.fromEntries(meta.devices.map(d=>[d.id,d.label]));
  renderDevices(meta.devices,meta.now);
  await refreshExtraStats(meta);
  const online=meta.devices.filter(d=>meta.now-d.last_seen<90000).length;
  $('#statToday').textContent=extraStats.today==null?'-':fmtNum(extraStats.today);
  $('#statTodaySub').textContent=`de ${fmtNum(totalCount)} visitas guardadas`;
  $('#statDevices').textContent=fmtNum(meta.devices.length);
  $('#statDevicesSub').textContent=online?`${fmtNum(online)} en línea ahora`:'ninguno en línea ahora';
  $('#statSites').textContent=extraStats.sites==null?'-':fmtNum(extraStats.sites);
  $('#statSitesSub').textContent=extraStats.sample>=5000?'en las últimas 5.000 visitas':'dominios distintos visitados';
  $('#statDeleted').textContent=fmtNum(deletedCount);
  $('#navCountAll').textContent=fmtNum(totalCount);$('#navCountDeleted').textContent=deletedCount?fmtNum(deletedCount):'';$('#navCountSites').textContent=extraStats.sites==null?'':fmtNum(extraStats.sites);
  $('#sideStats').innerHTML=`<b>${fmtNum(totalCount)}</b> visitas de Chrome<br><b class="danger">${fmtNum(deletedCount)}</b> borradas de Chrome<div class="okLine"><span class="devDot on"></span>Captura en tiempo real</div>`;
}
async function loadView({preserveScroll=false}={}){
  if(loading){webViewAgain=true;return;}
  clearTimeout(webViewRetry);webViewRetry=null;setLoading(true);
  const y=window.scrollY,content=$('#content'),previous=content.innerHTML;
  let failed=false;
  try{
    await Promise.all([refreshStats(),loadDeletedNotice()]);
    if(currentView==='sites')await loadSites();else await loadHistoryLike();
    if(preserveScroll)requestAnimationFrame(()=>window.scrollTo(0,y));
  }catch(error){
    failed=true;webError(error);
    if(previous&&!content.querySelector('.row,.siteRow'))content.innerHTML=previous;
    if(!previous)content.innerHTML='<div class="empty">La conexión se está recuperando. La lista volverá a cargarse automáticamente.</div>';
    $('#liveText').textContent='Reconectando…';
  }finally{
    setLoading(false);
    const again=webViewAgain;webViewAgain=false;
    if(failed||again)webViewRetry=setTimeout(()=>loadView({preserveScroll:true}),failed?3000:0);
  }
}

activeNav(currentView);
refreshPresenceToggle();fetchPresenceState();presenceTimer=setInterval(()=>{renderPresenceState();fetchPresenceState();},5000);loadView();
