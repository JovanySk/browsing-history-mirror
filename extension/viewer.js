
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

function faviconUrl(url){return chrome.runtime.getURL("/_favicon/")+"?pageUrl="+encodeURIComponent(url)+"&size=32"}
function ownUrl(url){try{return String(url||"").startsWith(chrome.runtime.getURL(""))}catch{return false}}
function fmtTime(ms){return new Date(ms).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
function dateKey(ms){const d=new Date(ms);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function fmtDate(ms){const d=new Date(ms),t=new Date(),y=new Date();y.setDate(t.getDate()-1);const same=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();const long=d.toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long",year:"numeric"});if(same(d,t))return`Hoy - ${long}`;if(same(d,y))return`Ayer - ${long}`;return long}

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
async function loadHistoryLike(){
  const f=filters();const records=await queryVisits({limit:renderLimit,q:f.q,from:f.from,to:f.to,deletedOnly:currentView==="deleted"});
  currentRecords=records;renderHistory(records);$("#toolbarMeta").textContent=`${records.length.toLocaleString()} cargadas · ${totalCount.toLocaleString()} guardadas`;$("#loadMoreWrap").style.display=records.length>=renderLimit?"flex":"none"
}

async function loadSites(){
  const arr=(await getAggregationSample(5000)).filter(v=>!ownUrl(v.url)),map=new Map();
  for(const v of arr){const h=hostOf(v.url)||"(sin dominio)",x=map.get(h)||{count:0,last:v,deleted:0};x.count++;if(statusOf(v)==="deleted")x.deleted++;if(v.visitTime>x.last.visitTime)x.last=v;map.set(h,x)}
  const sites=[...map.entries()].sort((a,b)=>b[1].count-a[1].count);$("#toolbarMeta").textContent=`Top ${sites.length} sitios`;$("#loadMoreWrap").style.display="none";
  $("#content").innerHTML=sites.map(([h,x])=>`<div class="siteCard"><div class="favicon"><img src="${esc(faviconUrl(x.last.url))}" alt=""></div><div><div class="cardTitle">${esc(h)}</div><div class="cardMeta">Última visita: ${esc(new Date(x.last.visitTime).toLocaleString())}</div></div><div class="cardRight">${x.count.toLocaleString()} visitas<br>${x.deleted?`<span style="color:#f28b82">${x.deleted} borradas</span>`:`<span style="color:#81c995">sin borrados detectados</span>`}</div></div>`).join("")||`<div class="empty">No hay sitios.</div>`
}
async function refreshStats(){
  totalCount=await countStore(VISITS_STORE);deletedCount=await countStore(VISITS_STORE,"chromeState","deleted");
  $("#sideStats").innerHTML=`<b>${totalCount.toLocaleString()}</b> visitas de Chrome<br><b style="color:#f28b82">${deletedCount.toLocaleString()}</b> borradas de Chrome<br><span style="color:#81c995">●</span> captura en tiempo real`
}
async function loadDeletedNotice(){
  const ev=(await getRecentEvents(60)).filter(e=>e.type==="chrome_history_deleted"),n=$("#notice");if(ev.length){n.classList.add("show");n.textContent=`Se detectaron ${ev.length} evento(s) de borrado. Último: ${new Date(ev[0].time).toLocaleString()}. El espejo conservó las copias.`}else n.classList.remove("show")
}
async function loadView({preserveScroll=false}={}){
  if(loading)return;setLoading(true);const y=window.scrollY;
  try{await refreshStats();await loadDeletedNotice();if(currentView==="sites")await loadSites();else await loadHistoryLike();if(preserveScroll)requestAnimationFrame(()=>window.scrollTo(0,y))}finally{setLoading(false)}
  if(["history","deleted"].includes(currentView))autoVerifyVisible()
}
async function verifyUrls(urls){const unique=[...new Set(urls.filter(Boolean))];if(!unique.length)return;$("#liveText").textContent="Verificando…";let i=0;async function worker(){while(i<unique.length){const url=unique[i++];try{await reconcileMirrorUrl(url,await chrome.history.getVisits({url}),Date.now())}catch{}}}await Promise.all(Array.from({length:Math.min(8,unique.length)},worker));$("#liveText").textContent="En vivo"}
async function verifyVisible({manual=false}={}){if(!currentRecords.length)return;if(manual)setLoading(true);try{await verifyUrls(currentRecords.map(v=>v.url));await loadView({preserveScroll:true})}finally{if(manual)setLoading(false)}}
let verifyToken=0;function autoVerifyVisible(){if(!currentRecords.length)return;const token=++verifyToken;setTimeout(async()=>{if(token!==verifyToken)return;await verifyUrls(currentRecords.slice(0,50).map(v=>v.url));if(token===verifyToken){const y=window.scrollY;await loadHistoryLike();window.scrollTo(0,y);await refreshStats()}},450)}
async function importCurrentHistory(){const btn=$("#import");btn.disabled=true;setLoading(true);$("#liveText").textContent="Importando…";try{const items=await chrome.history.search({text:"",startTime:Date.now()-120*86400000,maxResults:100000});let n=0;for(const item of items){if(ownUrl(item.url))continue;const visits=await chrome.history.getVisits({url:item.url});for(const v of visits)await putVisit({visitTime:v.visitTime,url:item.url,title:item.title||"",transition:v.transition||"",referringVisitId:v.referringVisitId??null,visitId:v.visitId??null,chromeHistoryId:item.id,source:"import"});if(++n%30===0)await new Promise(r=>setTimeout(r,0))}await putEvent({type:"manual_import",time:Date.now(),details:{urls:items.length}});renderLimit=PAGE_STEP;await loadView()}catch(e){alert("No se pudo importar: "+(e.message||e))}finally{$("#liveText").textContent="En vivo";setLoading(false);btn.disabled=false}}
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
    : "Comparte la pestaña web activa de ESTE dispositivo. Déjalo OFF en el equipo que solo recibe.";
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
      "Nombre para identificar ESTE dispositivo.\\n\\nEjemplo: Mi laptop\\n\\nSolo actívalo en un dispositivo cuyo usuario sepa y acepte compartir su pestaña activa.",
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

refreshPresenceToggle();fetchPresenceState();presenceTimer=setInterval(()=>{renderPresenceState();fetchPresenceState();},5000);loadView();
