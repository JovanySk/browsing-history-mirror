window.webSource=localStorage.getItem('historialWebSource')||'all';
if(location.hash.startsWith('#acceso='))history.replaceState(null,'',location.pathname+location.search);
let webState={local:{},sync:{}},storageListeners=[],messageListeners=[],lastMeta=-1,lastViewRefresh=0,webHeartbeatBusy=false,webHeartbeatAgain=false,webLiveTimer=null,webMeta=null,webMetaAt=0,webMetaRequest=null;
async function webJSON(url,options={}){
  const {timeoutMs=12000,...request}=options,controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{...request,signal:controller.signal,cache:'no-store'});
    const text=await response.text();let body;
    try{body=JSON.parse(text);}catch{throw new Error('El servidor está temporalmente ocupado. Reintentando automáticamente…');}
    if(response.status===401&&body.loginRequired){location.replace('/');throw new Error('La sesión necesita volver a conectarse.');}
    if(!response.ok)throw new Error(body.error||'No se pudo conectar con el servidor');
    return body;
  }catch(error){
    if(error.name==='AbortError')throw new Error('La consulta tardó demasiado. Reintentando automáticamente…');
    throw error;
  }finally{clearTimeout(timer);}
}
function sourceQuery(){return '?source='+encodeURIComponent(window.webSource);}
async function getWebMeta(){
  const source=window.webSource;
  if(webMeta&&webMeta.source===source&&Date.now()-webMetaAt<1500)return webMeta;
  if(webMetaRequest?.source===source)return webMetaRequest.promise;
  const request={source,promise:null};
  request.promise=webJSON('/api/meta'+sourceQuery()).then(meta=>{webMeta={...meta,source};webMetaAt=Date.now();return webMeta;}).finally(()=>{if(webMetaRequest===request)webMetaRequest=null;});
  webMetaRequest=request;return request.promise;
}
function webError(error){
  const element=document.querySelector('#webStatus');
  if(element){element.textContent=error.message||String(error);element.classList.add('error');}
}
async function refreshWebState(){
  const next=await webJSON('/api/state'+sourceQuery());
  const previous=webState;webState=next;
  for(const area of ['local','sync']){
    const changes={};
    for(const key of new Set([...Object.keys(previous[area]||{}),...Object.keys(next[area]||{})])){
      if(JSON.stringify(previous[area]?.[key])!==JSON.stringify(next[area]?.[key]))changes[key]={oldValue:previous[area]?.[key],newValue:next[area]?.[key]};
    }
    if(Object.keys(changes).length)for(const listener of storageListeners)listener(changes,area);
  }
  webState=next;
  return next;
}
async function webCommand(command){
  const job=await webJSON('/api/commands'+sourceQuery(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});
  document.querySelector('#webStatus').textContent='Aplicando en '+job.device+'…';
  for(let attempt=0;attempt<90;attempt++){
    await new Promise(resolve=>setTimeout(resolve,1000));
    const result=await webJSON('/api/jobs/'+job.id);
    if(result.status==='error')throw new Error(result.result.error||'El dispositivo no pudo completar la operación');
    if(result.status==='done'){await refreshWebState();return result.result;}
  }
  throw new Error('La operación sigue pendiente en '+job.device+'. Revisa que Chrome esté conectado.');
}
function storageArea(area){return {
  async get(keys){
    await refreshWebState();const data=webState[area]||{};
    if(keys==null)return data;
    const list=typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys);
    return Object.fromEntries(list.map(key=>[key,data[key]??(typeof keys==='object'&&!Array.isArray(keys)?keys[key]:undefined)]));
  },
  async set(){}
};}
window.chrome={
  tabs:{create({url}){try{const u=new URL(url);if(['http:','https:'].includes(u.protocol))window.open(u.href,'_blank','noopener,noreferrer');}catch{}}},
  storage:{local:storageArea('local'),sync:storageArea('sync'),onChanged:{addListener(callback){storageListeners.push(callback);}}},
  runtime:{
    lastError:null,getURL(path){return path.startsWith('/_favicon')?'/api/favicon':'chrome-extension://';},
    onMessage:{addListener(callback){messageListeners.push(callback);}},
    sendMessage(message,callback=()=>{}){
      (async()=>{
        if(message.type==='presence_get_local_info'){
          await refreshWebState();
          return {ok:true,deviceId:webState.local?.mirrorDeviceId,enabled:!!webState.local?.presenceShareEnabled,deviceName:webState.local?.presenceDeviceName||webState.device?.label,deviceType:'Computadora',platform:webState.device?.id==='vps'?'VPS':'Windows'};
        }
        if(['presence_enable','presence_disable'].includes(message.type))return webCommand(message);
        return {ok:true};
      })().then(callback).catch(error=>{webError(error);callback({ok:false,error:error.message});});
    }
  }
};
async function webHeartbeat(force=false){
  if(webHeartbeatBusy){if(force)webHeartbeatAgain=true;return;}
  webHeartbeatBusy=true;
  try{
    const meta=await getWebMeta();
    const selector=document.querySelector('#webSource');
    const choices=[['all','Todos los dispositivos'],...meta.devices.map(d=>[d.id,d.label])];
    if(selector.options.length!==choices.length||choices.some((x,i)=>selector.options[i]?.value!==x[0])){
      selector.replaceChildren(...choices.map(([value,label])=>{const option=document.createElement('option');option.value=value;option.textContent=label;return option;}));
      if(!choices.some(x=>x[0]===window.webSource))window.webSource='all';
      selector.value=window.webSource;
    }
    const status=document.querySelector('#webStatus');status.classList.remove('error');
    if(!meta.lastUpdated)status.textContent='Esperando la primera sincronización de tus datos…';
    else{
      const age=Math.max(0,Math.round((meta.now-meta.lastUpdated)/1000));
      status.textContent=age<90?'Conector conectado · última señal '+new Date(meta.lastUpdated).toLocaleTimeString('es-MX'):'Datos guardados · última conexión '+new Date(meta.lastUpdated).toLocaleString('es-MX');
    }
    document.querySelector('#webMobileStats').textContent=meta.counts.visits.toLocaleString('es-MX')+' visitas';
    await refreshWebState();
    if(force||meta.revision!==lastMeta||Date.now()-lastViewRefresh>2000){lastMeta=meta.revision;lastViewRefresh=Date.now();if(typeof loadView==='function')await loadView({preserveScroll:true});}
    if(typeof refreshPresenceToggle==='function')await refreshPresenceToggle();
    const pill=document.querySelector('#liveText');
    if(pill)pill.textContent=meta.now-meta.lastUpdated<90000?'Conectado':'Guardado';
  }catch(error){webError(error);const pill=document.querySelector('#liveText');if(pill)pill.textContent='Sin conexión';}
  finally{webHeartbeatBusy=false;if(webHeartbeatAgain){webHeartbeatAgain=false;queueLiveRefresh();}}
}
function queueLiveRefresh(){
  if(webLiveTimer)return;
  webLiveTimer=setTimeout(()=>{webLiveTimer=null;webHeartbeat(true);},150);
}
document.addEventListener('DOMContentLoaded',()=>{
  const selector=document.querySelector('#webSource');
  selector.addEventListener('change',async()=>{window.webSource=selector.value;localStorage.setItem('historialWebSource',selector.value);renderLimit=PAGE_STEP;await webHeartbeat(true);});
  const mobile=document.querySelector('#mobileNav');
  mobile.addEventListener('change',()=>document.querySelector('.navitem[data-view="'+mobile.value+'"]').click());
  document.querySelectorAll('.navitem').forEach(item=>{item.tabIndex=0;item.setAttribute('role','button');item.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();item.click();}});item.addEventListener('click',()=>{mobile.value=item.dataset.view;});});
  webHeartbeat(true);setInterval(()=>webHeartbeat(),2000);
  // The persistent session also protects this stream; no history is placed in the URL.
  if(typeof EventSource==='function'){
    const changes=new EventSource('/api/live');
    changes.addEventListener('changed',()=>{window.archiveDataArrived?.();queueLiveRefresh();});
    window.addEventListener('pagehide',()=>changes.close(),{once:true});
  }
});
