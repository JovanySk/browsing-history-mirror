
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const PAGE_STEP=100;

let currentView="history", renderLimit=PAGE_STEP;
let currentRecords=[], totalCount=0, deletedCount=0, loading=false, pendingLiveChanges=0;
let searchTimer=null;
let presenceState=null, localDeviceId=null, presenceTimer=null;

function esc(s){return String(s??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));}
function hostOf(url){try{return new URL(url).hostname.replace(/^www\./,"")}catch{return""}}

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
  if(s<60)return`${s}s`;
  const m=Math.floor(s/60);
  if(m<60)return`${m}m ${s%60}s`;
  const h=Math.floor(m/60);
  return`${h}h ${m%60}m`;
}

function presenceFreshness(){
  if(!presenceState) return Infinity;
  return Date.now()-Number(presenceState.lastSeenAt||0);
}

function faviconUrl(url){return "/api/favicon?url="+encodeURIComponent(url)}
function ownUrl(url){try{return String(url||"").startsWith(chrome.runtime.getURL(""))}catch{return false}}
function fmtTime(ms){return new Date(ms).toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
function dateKey(ms){const d=new Date(ms);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function fmtDate(ms){const d=new Date(ms),t=new Date(),y=new Date();y.setDate(t.getDate()-1);const same=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();const long=d.toLocaleDateString("es-MX",{weekday:"long",day:"numeric",month:"long",year:"numeric"});if(same(d,t))return`Hoy - ${long}`;if(same(d,y))return`Ayer - ${long}`;return long}

function statusOf(v){if(v.chromeState==="deleted")return"deleted";if(v.chromeState==="present")return"present";return"unknown"}
function statusTag(v){const s=statusOf(v);if(s==="deleted")return`<span class="tag deleted"><span class="statusDot"></span>Borrado de Chrome</span>`;if(s==="present")return`<span class="tag present"><span class="statusDot"></span>En Chrome</span>`;return`<span class="tag unknown"><span class="statusDot"></span>Sin verificar</span>`}
function setLoading(on){loading=on;$("#loadingBar").classList.toggle("show",on)}
function filters(){return{q:$("#q").value.trim(),from:$("#from").value?new Date($("#from").value+"T00:00:00").getTime():-Infinity,to:$("#to").value?new Date($("#to").value+"T23:59:59.999").getTime():Infinity}}

function buildEntry(v){
  const host=hostOf(v.url);
  let tags="";
  if(presenceMatchesUrl(v.url)){
    tags+=`<span class="tag present" style="background:#21402e;border-color:#4e8b61;color:#c7f2d0;font-weight:700"><span class="statusDot"></span>Activo ahora</span>`;
  }
  if(v.playingAudio)tags+=`<span class="tag playing"><span aria-hidden="true">♫</span> Reproduciendo</span>`;
  tags+=statusTag(v);

  return`<div class="entry" data-fp="${esc(v.fingerprint)}">
  <div class="favicon"><img src="${esc(faviconUrl(v.url))}" alt=""></div><div class="time">${esc(fmtTime(v.visitTime))}</div>
  <div class="mainline"><span class="title">${esc(v.title||"(sin título)")}</span><div class="host">${esc(host)}</div></div>
  <div class="tags">${tags}<button class="more">⋮</button></div>
  <div class="details">
    <div class="detailrow"><span class="detailkey">Fecha</span><span>${esc(new Date(v.visitTime).toLocaleString())}</span></div>
    <div class="detailrow"><span class="detailkey">Estado</span><span>${statusOf(v)==="deleted"?"La copia sigue aquí, pero esta visita ya no aparece en Chrome.":statusOf(v)==="present"?"Esta visita sigue en Chrome.":"Todavía no se verificó."}</span></div>
    ${v.deletedAt?`<div class="detailrow"><span class="detailkey">Borrado</span><span>${esc(new Date(v.deletedAt).toLocaleString())}</span></div>`:""}
    <div class="detailrow"><span class="detailkey">URL</span><span class="detailurl">${esc(v.url)}</span></div>
    <button class="smallBtn openUrl" data-url="${esc(v.url)}">Abrir página</button><button class="smallBtn copyUrl" data-url="${esc(v.url)}">Copiar URL</button>
  </div></div>`
}
function bindEntries(){
  $$(".entry").forEach(el=>{const t=()=>el.classList.toggle("open");el.querySelector(".mainline")?.addEventListener("click",t);el.querySelector(".more")?.addEventListener("click",t)});
  $$(".openUrl").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();chrome.tabs.create({url:b.dataset.url})}));
  $$(".copyUrl").forEach(b=>b.addEventListener("click",async e=>{e.stopPropagation();await navigator.clipboard.writeText(b.dataset.url);const x=b.textContent;b.textContent="Copiado";setTimeout(()=>b.textContent=x,800)}));
  $$(".dayHeader").forEach(h=>h.addEventListener("click",()=>h.closest(".day").classList.toggle("collapsed")))
}
function renderHistory(records){
  if(!records.length){$("#content").innerHTML=`<div class="empty"><div class="emptyIcon">◷</div>No hay visitas para estos filtros.</div>`;return}
  const groups=new Map();for(const v of records){const k=dateKey(v.visitTime);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(v)}
  let html="";for(const items of groups.values()){html+=`<section class="day"><div class="dayHeader"><span class="arr">▼</span>${esc(fmtDate(items[0].visitTime))}<span class="dayCount">${items.length}</span></div><div class="entries">${items.map(buildEntry).join("")}</div></section>`}
  $("#content").innerHTML=html;bindEntries()
}
async function loadSites(){
  const arr=(await getAggregationSample(5000)).filter(v=>!ownUrl(v.url)),map=new Map();
  for(const v of arr){const h=hostOf(v.url)||"(sin dominio)",x=map.get(h)||{count:0,last:v,deleted:0};x.count++;if(statusOf(v)==="deleted")x.deleted++;if(v.visitTime>x.last.visitTime)x.last=v;map.set(h,x)}
  const sites=[...map.entries()].sort((a,b)=>b[1].count-a[1].count);$("#toolbarMeta").textContent=`Top ${sites.length} sitios`;$("#loadMoreWrap").style.display="none";
  $("#content").innerHTML=sites.map(([h,x])=>`<div class="siteCard"><div class="favicon"><img src="${esc(faviconUrl(x.last.url))}" alt=""></div><div><div class="cardTitle">${esc(h)}</div><div class="cardMeta">Última visita: ${esc(new Date(x.last.visitTime).toLocaleString())}</div></div><div class="cardRight">${x.count.toLocaleString()} visitas<br>${x.deleted?`<span style="color:#f28b82">${x.deleted} borradas</span>`:`<span style="color:#81c995">sin borrados detectados</span>`}</div></div>`).join("")||`<div class="empty">No hay sitios.</div>`
}
async function loadDeletedNotice(){
  const ev=(await getRecentEvents(60)).filter(e=>e.type==="chrome_history_deleted"),n=$("#notice");if(ev.length){n.classList.add("show");n.textContent=`Se detectaron ${ev.length} evento(s) de borrado. Último: ${new Date(ev[0].time).toLocaleString()}. El espejo conservó las copias.`}else n.classList.remove("show")
}
async function exportCSV(){setLoading(true);try{const arr=(await getAggregationSample(100000)).filter(v=>!ownUrl(v.url)).sort((a,b)=>a.visitTime-b.visitTime),q=v=>`"${String(v??"").replace(/"/g,'""')}"`,lines=[["fecha_hora","timestamp_ms","titulo","url","dominio","estado_chrome","borrado_en"].map(q).join(",")];for(const v of arr){lines.push([new Date(v.visitTime).toLocaleString(),v.visitTime,v.title||"",v.url||"",hostOf(v.url),statusOf(v),v.deletedAt?new Date(v.deletedAt).toLocaleString():""].map(q).join(","))}const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`historial_espejo_${dateKey(Date.now())}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}finally{setLoading(false)}}


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
  const status=$("#presenceStatus"), title=$("#presenceTitle"), sub=$("#presenceSub"),
        url=$("#presenceUrl"), device=$("#presenceDevice"),
        elapsed=$("#presenceElapsed"), signal=$("#presenceSignal");

  if(!presenceState){
    status.innerHTML='<span class="liveDot" style="background:#9aa0a6"></span> Sin señal';
    title.textContent="Esperando un dispositivo que comparta su pestaña activa…";
    sub.textContent='Activa “Emitir presencia” únicamente en el dispositivo que quieras compartir.';
    url.textContent="";
    device.textContent="—";
    elapsed.textContent="—";
    signal.textContent="—";
    return;
  }

  const age=presenceFreshness();
  const stale=age>90000;
  const sameDevice=localDeviceId && presenceState.deviceId===localDeviceId;
  const deviceLabel=presenceState.deviceName || `${presenceState.deviceType||""} ${presenceState.platform||""}`.trim() || "Dispositivo";

  if(stale){
    status.innerHTML='<span class="liveDot" style="background:#fdd663"></span> Sin señal reciente';
    title.textContent=presenceState.title || presenceState.host || "Última página conocida";
    sub.textContent=`No se puede confirmar que siga ahí. Última señal hace ${durationShort(age)}${sameDevice?" · este dispositivo":""}.`;
  }else if(presenceState.active){
    status.innerHTML='<span class="liveDot"></span> Activo ahora';
    title.textContent=presenceState.title || presenceState.host || "Página web";
    sub.textContent=`${presenceState.host||"Sitio web"} · ${sameDevice?"este dispositivo":"otro dispositivo"} · Chrome enfocado`;
  }else{
    status.innerHTML='<span class="liveDot" style="background:#fdd663"></span> Chrome no está activo';
    title.textContent=presenceState.title || presenceState.host || "Última página conocida";
    sub.textContent=`La última página quedó registrada, pero la ventana de Chrome no está enfocada${sameDevice?" · este dispositivo":""}.`;
  }

  url.textContent=presenceState.url||"";
  device.textContent=deviceLabel;
  elapsed.textContent=(presenceState.active&&presenceState.since)?durationShort(Date.now()-presenceState.since):"—";
  signal.textContent=durationShort(age);

  if(["history","deleted"].includes(currentView) && currentRecords.length){
    renderHistory(currentRecords);
  }
}

async function refreshPresenceToggle(){
  const info=await new Promise(resolve=>{
    chrome.runtime.sendMessage({type:"presence_get_local_info"},r=>resolve(r||{}));
  });
  localDeviceId=info.deviceId||null;
  const on=!!info.enabled;
  $("#presenceToggle").textContent=`Emitir presencia: ${on?"ON":"OFF"}`;
  $("#presenceToggle").style.borderColor=on?"#3f684d":"";
  $("#presenceToggle").style.color=on?"#b7e5c2":"";
  $("#presenceToggle").title=on
    ? `Este dispositivo está compartiendo su pestaña activa${info.deviceName?` como “${info.deviceName}”`:""}.`
    : "Comparte la pestaña web activa del dispositivo de captura seleccionado. Déjalo OFF en el equipo que solo recibe.";
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
      "Nombre para identificar el dispositivo de captura seleccionado.\\n\\nEjemplo: Mi laptop\\n\\nSolo actívalo en un dispositivo cuyo usuario sepa y acepte compartir su pestaña activa.",
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
function activeNav(v){$$(".navitem").forEach(n=>n.classList.toggle("active",n.dataset.view===v))}

chrome.runtime.onMessage.addListener(message=>{
  if(message?.type!=="mirror-change")return;
  if(message.kind==="delete"){loadView({preserveScroll:true});return}
  if(window.scrollY<350&&currentView==="history"&&!$("#q").value){renderLimit=PAGE_STEP;loadView()}else{pendingLiveChanges++;showSnackbar(`${pendingLiveChanges} nueva${pendingLiveChanges===1?"":"s"} visita${pendingLiveChanges===1?"":"s"}`)}
});


$("#verify").addEventListener("click",()=>verifyVisible({manual:true}));$("#import").addEventListener("click",importCurrentHistory);$("#export").addEventListener("click",exportCSV);
$("#loadMore").addEventListener("click",async()=>{renderLimit+=PAGE_STEP;await loadView({preserveScroll:true})});
$("#q").addEventListener("input",()=>{$("#clearSearch").style.display=$("#q").value?"block":"none";clearTimeout(searchTimer);searchTimer=setTimeout(()=>{renderLimit=PAGE_STEP;loadView()},180)});
$("#clearSearch").addEventListener("click",()=>{$("#q").value="";$("#clearSearch").style.display="none";renderLimit=PAGE_STEP;loadView();$("#q").focus()});
$("#from").addEventListener("change",()=>{renderLimit=PAGE_STEP;loadView()});$("#to").addEventListener("change",()=>{renderLimit=PAGE_STEP;loadView()});
$$(".navitem").forEach(n=>n.addEventListener("click",()=>{currentView=n.dataset.view;activeNav(currentView);renderLimit=PAGE_STEP;loadView()}));
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
function archiveVisibility(){$('#archiveControls').hidden=currentView!=='history';}
function archiveEntry(item){
  let tags=statusTag(item);
  if(item.playingAudio)tags+='<span class="tag playing">♫ Reproduciendo</span>';
  if(presenceMatchesUrl(item.url))tags+='<span class="tag present"><span class="statusDot"></span>Activo ahora</span>';
  const safeUrl=/^https?:\/\//i.test(item.url||'')?item.url:'';
  const title=item.title||'(sin título)';
  return `<article class="archiveEntry" data-key="${esc(item.id)}"><div class="favicon"><img src="${esc(faviconUrl(item.url||''))}" alt="" loading="lazy" referrerpolicy="no-referrer"></div><div class="archiveTime">${esc(item.eventTime?fmtTime(item.eventTime):'Sin hora')}</div><div class="archiveBody"><div class="archiveHeadline">${safeUrl?`<a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>`:esc(title)}</div><div class="archiveProvider">${esc(item.domain||'')}</div><div class="archiveTags">${tags}</div><details class="archiveDetails"><summary>Ver detalles</summary><dl><dt>Fecha de visita</dt><dd>${item.eventTime?esc(new Date(item.eventTime).toLocaleString('es-MX')):'—'}</dd>${item.captureDevice?`<dt>Dispositivo de captura</dt><dd>${esc(item.captureDevice)}</dd>`:''}${item.deletedAt?`<dt>Borrado de Chrome</dt><dd>${esc(new Date(item.deletedAt).toLocaleString('es-MX'))}</dd>`:''}${safeUrl?`<dt>Dirección</dt><dd class="detailurl">${esc(safeUrl)}</dd>`:''}<dt>Copiado al espejo</dt><dd>${item.capturedAt?esc(new Date(item.capturedAt).toLocaleString('es-MX')):'—'}</dd></dl></details></div></article>`;
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
  $('#archiveCounts').textContent=`${data.chromeCount.toLocaleString('es-MX')} visitas de Chrome en el índice${data.indexing?' · preparando el índice completo…':''}`;
  $('#toolbarMeta').textContent=`${data.total?archiveOffset+1:0}–${Math.min(archiveOffset+100,data.total)} de ${data.total.toLocaleString('es-MX')} visitas`;
  $('#loadMoreWrap').style.display='none';
  currentRecords=data.entries;
  const pagination=archivePager(data);
  let output=pagination,lastDay='';
  for(const item of data.entries){
    const day=item.eventTime?dateKey(item.eventTime):'undated';
    if(day!==lastDay){if(lastDay)output+='</div></section>';output+=`<section class="day"><div class="dayHeader">${day==='undated'?'Sin fecha':esc(fmtDate(item.eventTime))}</div><div class="entries">`;lastDay=day;}
    output+=archiveEntry(item);
  }
  if(lastDay)output+='</div></section>';
  if(!data.entries.length)output='<div class="empty">No hay visitas para estos filtros.</div>';
  output+=pagination;
  const expanded=new Set([...document.querySelectorAll('.archiveEntry details[open]')].map(detail=>detail.closest('.archiveEntry').dataset.key));
  $('#content').innerHTML=output;
  for(const article of document.querySelectorAll('.archiveEntry'))if(expanded.has(article.dataset.key))article.querySelector('details').open=true;
  for(const button of document.querySelectorAll('[data-archive-page]'))button.addEventListener('click',async()=>{if(!archiveAsOf)archiveAsOf=Date.now();archiveOffset=Number(button.dataset.archivePage);if(!archiveOffset)archiveAsOf=0;await loadTimeline();$('#toolbar').scrollIntoView({block:'start'});});
}
function archivePager(data){
  return `<div class="pagination">${archiveOffset?`<button class="pillBtn" data-archive-page="${Math.max(0,archiveOffset-100)}">← 100 más recientes</button>`:''}<span>Página ${Math.floor(archiveOffset/100)+1} de ${Math.max(1,Math.ceil(data.total/100))} · ${data.total.toLocaleString('es-MX')} registros</span>${data.hasMore?`<button class="pillBtn" data-archive-page="${archiveOffset+100}">100 más antiguos →</button>`:''}</div>`;
}
$('#archiveLiveNew').addEventListener('click',()=>{archiveOffset=0;archiveAsOf=0;$('#archiveLiveNew').hidden=true;loadView();});
window.archiveDataArrived=()=>{if(archiveOffset)$('#archiveLiveNew').hidden=false;};
async function loadHistoryLike(){
  archiveVisibility();
  if(currentView==='deleted'){
    const f=filters();currentRecords=await queryVisits({limit:renderLimit,q:f.q,from:f.from,to:f.to,deletedOnly:true});renderHistory(currentRecords);
    $('#toolbarMeta').textContent=`${currentRecords.length} visitas borradas cargadas`;$('#loadMoreWrap').style.display=currentRecords.length>=renderLimit?'flex':'none';return;
  }
  return loadTimeline();
}
$('#archiveRange').addEventListener('change',()=>{
  const value=$('#archiveRange').value,day=new Date();day.setHours(0,0,0,0);let from=null,to=null;
  if(value==='today'){from=day.getTime();to=from+86400000-1;}
  if(value==='yesterday'){to=day.getTime()-1;from=day.getTime()-86400000;}
  if(value==='last3'){from=day.getTime()-2*86400000;to=day.getTime()+86400000-1;}
  if(value==='last7'){from=day.getTime()-6*86400000;to=day.getTime()+86400000-1;}
  archiveHours=from==null?null:{from,to};$('#from').value=from==null?'':dateKey(from);$('#to').value=to==null?'':dateKey(to);archiveOffset=0;loadView();
});
for(const id of ['#from','#to'])$(id).addEventListener('change',()=>{archiveHours=null;$('#archiveRange').value='all';},{capture:true});
for(const nav of document.querySelectorAll('.navitem'))nav.addEventListener('click',archiveVisibility);
archiveVisibility();

// Keep the visible list usable while a transient network/server failure recovers.
var webViewAgain=false,webViewRetry=null;
async function refreshStats(){
  const meta=await getWebMeta();totalCount=meta.counts.visits;deletedCount=meta.counts.deleted||0;
  $('#sideStats').innerHTML=`<b>${totalCount.toLocaleString('es-MX')}</b> visitas de Chrome<br><b style="color:#f28b82">${deletedCount.toLocaleString('es-MX')}</b> borradas de Chrome<br><span style="color:#81c995">●</span> captura en tiempo real`;
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
    if(previous&&!content.querySelector('.archiveEntry,.entry,.siteCard'))content.innerHTML=previous;
    if(!previous)content.innerHTML='<div class="empty">La conexión se está recuperando. La lista volverá a cargarse automáticamente.</div>';
    $('#liveText').textContent='Reconectando…';
  }finally{
    setLoading(false);
    const again=webViewAgain;webViewAgain=false;
    if(failed||again)webViewRetry=setTimeout(()=>loadView({preserveScroll:true}),failed?3000:0);
  }
}

refreshPresenceToggle();fetchPresenceState();presenceTimer=setInterval(()=>{renderPresenceState();fetchPresenceState();},5000);loadView();
