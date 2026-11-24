
async function ensurePresenceAlarm(){}
async function publishPresence(){return new Promise(resolve=>chrome.runtime.sendMessage({type:'presence_refresh'},resolve));}
async function disablePresenceShare(){return new Promise(resolve=>chrome.runtime.sendMessage({type:'presence_disable'},resolve));}
// Runs only in the existing capture extension. The web UI reads durable copies on the VPS.

let webSyncBusy=false,webSyncAgain=false,webSyncTimer=null,webCommandsBusy=false;
let webPageBusy=false,webPageTimer=null;
let webStateBusy=false;
const webIconSent=new Map();
let webDeletionCheckBusy=false,webDeletionCheckAgain=false;
const WEB_STORES=['visits','events'];
function bridgeShouldSend(store,row){
  if(WEB_SYNC.device!=='vps')return true;
  if(store==='visits'&&row.chromeState==='deleted')return true;
  const event=Number(row.visitTime||row.eventTime||row.time||row.capturedAt||0);
  return event>=Date.now()-2*86400000;
}
const webDeltaKeys={visits:new Map()};
let webDeltaTimer=null,webDeltaBusy=false,webDeltaSequence=0;
function bridgeQueueRecord(store,key){
  webDeltaKeys[store].set(key,++webDeltaSequence);bridgeDeltaSchedule();
}
function bridgeDeltaSchedule(delay=150){
  if(!webDeltaTimer)webDeltaTimer=setTimeout(()=>{webDeltaTimer=null;bridgeDeltaFlush();},delay);
}
async function bridgeKeyRows(store,keys){
  const db=await openMirrorDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,'readonly'),object=tx.objectStore(store),rows=[];
    for(const key of keys){const request=object.get(key);request.onsuccess=()=>{if(request.result)rows.push(request.result);};}
    tx.oncomplete=()=>{db.close();resolve(rows);};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function bridgeDeltaFlush(){
  if(webDeltaBusy)return;webDeltaBusy=true;let retry=150;
  const selected={},stores={};
  try{
    for(const store of Object.keys(webDeltaKeys)){
      selected[store]=[...webDeltaKeys[store]].slice(0,40);
      if(selected[store].length)stores[store]=await bridgeKeyRows(store,selected[store].map(([key])=>key));
    }
    if(Object.keys(stores).length){
      await bridgeFetch('/sync',{label:WEB_SYNC.label,stores});
      // A write during this request remains queued until its own upload is acknowledged.
      for(const store of Object.keys(selected))for(const [key,version] of selected[store])if(webDeltaKeys[store].get(key)===version)webDeltaKeys[store].delete(key);
      await chrome.storage.local.set({webBridgeFastSuccess:Date.now(),webBridgeFastError:''});
    }
  }catch(error){retry=3000;await chrome.storage.local.set({webBridgeFastError:String(error.message||error)});}
  finally{webDeltaBusy=false;if(Object.values(webDeltaKeys).some(keys=>keys.size))bridgeDeltaSchedule(retry);}
}
// History onVisited is insufficient for visits that arrive later through Chrome Sync.
let webHistoryBusy=false;
const webHistorySignatures=new Map(),webHistoryVisits=new Set();
async function bridgeHistoryScan(){
  if(webHistoryBusy)return;webHistoryBusy=true;
  let added=0,latest=0;
  try{
    const now=Date.now(),cutoff=now-3*86400000;
    const items=await chrome.history.search({text:'',startTime:cutoff,maxResults:3000});
    for(const item of items){
      if(!/^https?:\/\//i.test(item.url||''))continue;
      latest=Math.max(latest,Number(item.lastVisitTime||0));
      const signature=[item.lastVisitTime,item.visitCount,item.typedCount,item.title].join('|'),previous=webHistorySignatures.get(item.url);
      if(previous?.signature===signature&&now-previous.checked<120000)continue;
      const visits=await chrome.history.getVisits({url:item.url});
      for(const visit of visits){
        if(Number(visit.visitTime||0)<cutoff)continue;
        const key=String(visit.visitId)+'|'+visit.visitTime+'|'+item.url+'|'+(item.title||'');
        if(webHistoryVisits.has(key))continue;
        await putVisit({visitTime:visit.visitTime,url:item.url,title:item.title||'',transition:visit.transition||'',referringVisitId:visit.referringVisitId??null,visitId:visit.visitId??null,chromeHistoryId:item.id,isLocal:visit.isLocal??null,source:'history-catchup'});
        webHistoryVisits.add(key);added++;
      }
      webHistorySignatures.set(item.url,{signature,checked:now});
    }
    await chrome.storage.local.set({webHistoryScanSuccess:Date.now(),webHistoryLatestVisit:latest,webHistoryScanAdded:added,webHistoryScanError:''});
    if(added)bridgeSchedule(300);
  }catch(error){await chrome.storage.local.set({webHistoryScanError:String(error.message||error)});}
  finally{webHistoryBusy=false;}
}
async function bridgeFetch(path,body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
  try{
  const response=await fetch(WEB_SYNC.endpoint+path,{
    signal:controller.signal,
    method:body?'POST':'GET',credentials:'omit',cache:'no-store',headers:{'Authorization':'Bearer '+WEB_SYNC.token,...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const text=await response.text();
  let result;try{result=JSON.parse(text);}catch{throw new Error('Servidor temporalmente ocupado (HTTP '+response.status+'). El envÃ­o se reintentarÃ¡.');}
  if(!response.ok)throw new Error(result.error||'Error HTTP '+response.status);return result;
  }catch(error){if(error.name==='AbortError')throw new Error('Tiempo de conexiÃ³n agotado. El envÃ­o se reintentarÃ¡.');throw error;}
  finally{clearTimeout(timer);}
}
async function bridgeStoreCount(storeName){
  const db=await openMirrorDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readonly'),request=tx.objectStore(storeName).count();let count=0;
    request.onsuccess=()=>{count=request.result;};
    tx.oncomplete=()=>{db.close();resolve(count);};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function bridgeChangesPage(storeName,indexName,since,after=null,limit=80){
  const db=await openMirrorDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readonly'),index=tx.objectStore(storeName).index(indexName),rows=[];let next=null,exhausted=false;
    const timer=setTimeout(()=>{try{tx.abort();}catch{}},20000);
    const request=index.openCursor(IDBKeyRange.lowerBound(after?after.key:Math.max(0,since-1000)));
    request.onsuccess=()=>{
      const cursor=request.result;
      if(!cursor){exhausted=true;return;}
      if(after&&indexedDB.cmp(cursor.key,after.key)===0&&indexedDB.cmp(cursor.primaryKey,after.primaryKey)<=0){
        if(indexedDB.cmp(cursor.primaryKey,after.primaryKey)<0&&cursor.continuePrimaryKey)cursor.continuePrimaryKey(after.key,after.primaryKey);
        else cursor.continue();
        return;
      }
      rows.push(cursor.value);next={key:cursor.key,primaryKey:cursor.primaryKey};
      if(rows.length<limit)cursor.continue();
    };
    tx.oncomplete=()=>{clearTimeout(timer);db.close();resolve({rows,next,done:exhausted});};
    tx.onerror=tx.onabort=()=>{clearTimeout(timer);db.close();reject(tx.error||new Error('Consulta local interrumpida: '+storeName));};
  });
}
async function* bridgeChangedBatches(storeName,since){
  const indexes=storeName==='visits'?['lastSeenAt','lastVerifiedAt']:['time'];
  const seen=new Set();
  for(const indexName of indexes){
    let after=null;
    while(true){
      const page=await bridgeChangesPage(storeName,indexName,since,after);
      const fresh=page.rows.filter(row=>{const key=String(row.fingerprint??row.id);if(seen.has(key))return false;seen.add(key);return bridgeShouldSend(storeName,row);});
      for(let i=0;i<fresh.length;i+=40)yield fresh.slice(i,i+40);
      if(page.done||!page.next)break;
      after=page.next;
    }
  }
}
async function bridgeRows(storeName){
  return new Promise((resolve,reject)=>{
    const opening=indexedDB.open('historial_espejo_db');
    const timer=setTimeout(()=>reject(new Error('La base local no responde: '+storeName)),20000);
    opening.onerror=()=>{clearTimeout(timer);reject(opening.error);};
    opening.onblocked=()=>{clearTimeout(timer);reject(new Error('Base local ocupada: '+storeName));};
    opening.onsuccess=()=>{
      const db=opening.result;
      try{
        const tx=db.transaction(storeName,'readonly'),request=tx.objectStore(storeName).getAll();let rows=[];
        request.onsuccess=()=>{rows=request.result;};
        tx.oncomplete=()=>{clearTimeout(timer);db.close();resolve(rows);};
        tx.onerror=()=>{clearTimeout(timer);db.close();reject(tx.error);};
      }catch(error){clearTimeout(timer);db.close();reject(error);}
    };
  });
}
async function bridgeReconcileHistory(){
  if(webDeletionCheckBusy){webDeletionCheckAgain=true;return false;}
  webDeletionCheckBusy=true;let failed=0,checked=0;
  try{
    const rows=await bridgeRows('visits');
    const urls=[...new Set(rows.filter(row=>row.chromeState!=='deleted'&&/^https?:\/\//i.test(row.url||'')).map(row=>row.url))];
    const started=Date.now();let next=0;
    const update=()=>chrome.storage.local.set({webDeletionCheck:{phase:'checking',started,checked,total:urls.length,failed}});
    await update();
    await Promise.all(Array.from({length:4},async()=>{
      while(next<urls.length){
        const url=urls[next++];
        try{await reconcileMirrorUrl(url,await chrome.history.getVisits({url}),Date.now());}catch{failed++;}
        checked++;if(checked%100===0)await update();
      }
    }));
    await chrome.storage.local.set({webDeletionCheck:{phase:failed?'partial':'complete',started,finished:Date.now(),checked,total:urls.length,failed}});
    await bridgeDeltaFlush();bridgeSchedule(300);return failed===0;
  }catch(error){await chrome.storage.local.set({webDeletionCheck:{phase:'error',error:String(error.message||error),checked,failed}});return false;}
  finally{webDeletionCheckBusy=false;if(webDeletionCheckAgain){webDeletionCheckAgain=false;setTimeout(bridgeReconcileHistory,500);}}
}
async function bridgeState(){
  return {local:{...await chrome.storage.local.get(['presenceShareEnabled','presenceDeviceName','presenceLocalState','mirrorDeviceId','webBridgePageError','webBridgePageSuccess','webHistoryScanSuccess','webHistoryLatestVisit','webHistoryScanAdded','webHistoryScanError','webBridgeLastSuccess','webBridgeLastError','webBridgeStage','webBridgeFastSuccess','webBridgeFastError','webDeletionCheck','webCollectorPagePulse','webCollectorPageBuild','webManagedCollectorError']),webBridgeVersion:'realtime-v15.3'},
    sync:await chrome.storage.sync.get(['sharedPresence'])};
}
async function bridgePagePulse(){
  if(webPageBusy)return;webPageBusy=true;
  try{
    const tabs=(await chrome.tabs.query({})).filter(tab=>/^https?:\/\//i.test(tab.url||''))
      .sort((a,b)=>Number(!!b.audible)-Number(!!a.audible)||Number(!!b.active)-Number(!!a.active)||Number(b.lastAccessed||0)-Number(a.lastAccessed||0)).slice(0,300);
    const pages=tabs.map(tab=>({url:tab.url,title:tab.title||'',audible:!!tab.audible&&!tab.mutedInfo?.muted}));
    await bridgeFetch('/sync',{label:WEB_SYNC.label,pages});
    let sent=0;
    for(const tab of tabs){
      if(sent>=12)break;
      const host=new URL(tab.url).hostname.toLowerCase().replace(/^www\./,'');
      const signature=tab.favIconUrl||host;
      if(webIconSent.get(host)===signature)continue;
      try{
        const url=new URL(chrome.runtime.getURL('/_favicon/'));
        url.searchParams.set('pageUrl',tab.url);url.searchParams.set('size','32');
        const response=await fetch(url.toString());
        if(!response.ok)continue;
        const bytes=new Uint8Array(await response.arrayBuffer());
        if(!bytes.length||bytes.length>131072)continue;
        let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
        await bridgeFetch('/sync',{label:WEB_SYNC.label,icons:[{host,data:btoa(binary)}]});
        webIconSent.set(host,signature);sent++;
      }catch{}
    }
    await chrome.storage.local.set({webBridgePageError:'',webBridgePageSuccess:Date.now()});
  }catch(error){await chrome.storage.local.set({webBridgePageError:String(error.message||error)});}finally{webPageBusy=false;}
}
function bridgePageSchedule(){clearTimeout(webPageTimer);webPageTimer=setTimeout(bridgePagePulse,700);}
async function bridgeUpload(force=false){
  if(webSyncBusy){webSyncAgain=true;return;}webSyncBusy=true;let retry=false;
  try{
    await bridgeFetch('/sync',{label:WEB_SYNC.label,state:await bridgeState()});
    const saved=(await chrome.storage.local.get('webBridgeCheckpoint')).webBridgeCheckpoint||{};
    const since=force?0:Number(saved[WEB_SYNC.device]||0),started=Date.now(),counts={};
    for(const store of WEB_STORES){
      await chrome.storage.local.set({webBridgeStage:'Leyendo '+store,webBridgeAttempt:Date.now()});
      if(WEB_SYNC.device==='vps'){
        counts[store]=await bridgeStoreCount(store);let sent=0;
        for await(const batch of bridgeChangedBatches(store,since)){
          await chrome.storage.local.set({webBridgeStage:'Enviando cambios de '+store+' '+sent});
          await bridgeFetch('/sync',{label:WEB_SYNC.label,stores:{[store]:batch}});sent+=batch.length;
        }
      }else{
        const all=await bridgeRows(store);counts[store]=all.length;
        const changed=all.filter(row=>bridgeShouldSend(store,row)&&(!since||Math.max(...['lastSeenAt','lastVerifiedAt','capturedAt','time'].map(key=>Number(row[key]||0)))>=since));
        for(let index=0;index<changed.length;index+=40){
          await chrome.storage.local.set({webBridgeStage:'Enviando '+store+' '+index+'/'+changed.length});
          await bridgeFetch('/sync',{label:WEB_SYNC.label,stores:{[store]:changed.slice(index,index+40)}});
        }
      }
    }
    await bridgeFetch('/sync',{label:WEB_SYNC.label,counts,state:await bridgeState()});
    await chrome.storage.local.set({webBridgeCheckpoint:{...saved,[WEB_SYNC.device]:started},webBridgeLastSuccess:Date.now(),webBridgeLastError:'',webBridgeStage:'Sincronizado'});
  }catch(error){
    retry=true;
    await chrome.storage.local.set({webBridgeLastError:String(error.message||error)});
  }finally{
    webSyncBusy=false;if(webSyncAgain||retry){webSyncAgain=false;bridgeSchedule(retry?3000:1500);}
  }
}
function bridgeSchedule(delay=2000){if(webSyncTimer)return;webSyncTimer=setTimeout(()=>{webSyncTimer=null;bridgeUpload();},delay);}
async function bridgeStatePulse(){
  if(webStateBusy)return;webStateBusy=true;
  try{await bridgeFetch('/sync',{label:WEB_SYNC.label,state:await bridgeState()});}catch{}finally{webStateBusy=false;}
}
async function bridgeEnsureCollectorPage(){
  if(WEB_SYNC.device!=='vps')return;
  try{
    const own=chrome.runtime.getURL('collector.html'),wanted=own+'?build=realtime-v15.3';
    const pages=(await chrome.tabs.query({})).filter(tab=>(tab.url||'').split(/[?#]/)[0]===own);
    let tab=pages.find(tab=>tab.url===wanted)||pages[0];
    const extras=pages.filter(page=>page.id!==tab?.id).map(page=>page.id);
    if(extras.length)await chrome.tabs.remove(extras);
    if(!tab)tab=await chrome.tabs.create({url:wanted,active:false});
    else if(tab.url!==wanted)await chrome.tabs.update(tab.id,{url:wanted});
    if(chrome.tabs.update)await chrome.tabs.update(tab.id,{autoDiscardable:false}).catch(()=>{});
    if(tab.discarded)await chrome.tabs.reload(tab.id);
    await chrome.storage.local.set({webManagedCollectorError:''});
  }catch(error){await chrome.storage.local.set({webManagedCollectorError:String(error.message||error)});}
}
async function bridgeManagedHeartbeat(){
  await bridgeEnsureCollectorPage();
  const state=await chrome.storage.local.get('webCollectorPagePulse');
  if(Date.now()-Number(state.webCollectorPagePulse||0)>45000){
    await Promise.allSettled([bridgeHistoryScan(),bridgeUpload(),bridgePoll(),bridgePagePulse()]);
  }
  await bridgeStatePulse();
}
async function bridgeCommand(command){
  if(command.type==='reconcile_history')await bridgeReconcileHistory();
  else if(command.type==='verify_urls'){
    for(const url of [...new Set(command.urls||[])].slice(0,1000)){
      if(!/^https?:\/\//i.test(url))continue;
      await reconcileMirrorUrl(url,await chrome.history.getVisits({url}),Date.now());
    }
  }else if(command.type==='import_chrome'){
    const items=await chrome.history.search({text:'',startTime:Date.now()-120*86400000,maxResults:100000});
    for(const item of items){
      if(!item.url||item.url.startsWith(chrome.runtime.getURL('')))continue;
      for(const visit of await chrome.history.getVisits({url:item.url}))await putVisit({
        visitTime:visit.visitTime,url:item.url,title:item.title||'',transition:visit.transition||'',
        referringVisitId:visit.referringVisitId??null,visitId:visit.visitId??null,chromeHistoryId:item.id,isLocal:visit.isLocal??null,source:'import'
      });
    }
    await putEvent({type:'manual_import',time:Date.now(),details:{urls:items.length,origin:'web'}});
  }else if(command.type==='presence_enable'){
    await chrome.storage.local.set({presenceShareEnabled:true,presenceDeviceName:String(command.deviceName||WEB_SYNC.label).slice(0,100)});
    await ensurePresenceAlarm();await publishPresence('web-enabled');
  }else if(command.type==='presence_disable')await disablePresenceShare();
  else throw new Error('Comando no compatible');
}
async function bridgePoll(){
  if(webCommandsBusy)return;webCommandsBusy=true;
  try{
    const response=await bridgeFetch('/commands');
    if(!response.known)await bridgeUpload(true);
    for(const job of response.jobs){
      try{
        await bridgeCommand(job.command);
        // Flush only after any upload already in progress has finished.
        while(webSyncBusy)await new Promise(resolve=>setTimeout(resolve,200));
        await bridgeUpload();
        await bridgeFetch('/result',{id:job.id,ok:true});
      }catch(error){await bridgeFetch('/result',{id:job.id,error:String(error.message||error)});}
    }
  }catch{}finally{webCommandsBusy=false;}
}
for(const name of ['putVisit','putEvent','markAllChromeDeleted','reconcileMirrorUrl']){
  const original=globalThis[name];
  if(typeof original==='function')globalThis[name]=async function(...args){
    const result=await original(...args);
    if(name==='putVisit')bridgeQueueRecord('visits',visitFingerprint(args[0]));
    else bridgeSchedule();
    return result;
  };
}
chrome.storage.onChanged.addListener(changes=>{
  if(['presenceShareEnabled','sharedPresence'].some(key=>changes[key]))bridgeSchedule();
});
chrome.alarms.create('historialWebBridge',{delayInMinutes:0.1,periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='historialWebBridge'){if(webManagedWorker){bridgeManagedHeartbeat();}else{bridgeHistoryScan();bridgeUpload();bridgePoll();bridgePagePulse();}}});
chrome.tabs.onUpdated.addListener((tabId,changes)=>{if('title' in changes||'url' in changes||'favIconUrl' in changes||'audible' in changes||'mutedInfo' in changes)bridgePageSchedule();});
chrome.tabs.onRemoved.addListener(bridgePageSchedule);
chrome.history.onVisitRemoved.addListener(removed=>{
  // Chrome can report a partial/range deletion without listing the affected URLs.
  if(!removed.allHistory&&!(removed.urls||[]).length)bridgeReconcileHistory();
});
const webManagedWorker=WEB_SYNC.device==='vps'&&typeof document==='undefined';
if(!webManagedWorker){
setInterval(()=>{if(WEB_SYNC.device==='vps')chrome.storage.local.set({webCollectorPagePulse:Date.now(),webCollectorPageBuild:'realtime-v15.3'});bridgePoll();bridgePagePulse();},10000);
setInterval(bridgeHistoryScan,3000);
}
setTimeout(async()=>{
  // Reinstall the saved service-worker scripts once when updating the managed VPS collector.
  if(WEB_SYNC.device==='vps'&&(await chrome.storage.local.get('webRuntimeReloadVersion')).webRuntimeReloadVersion!=='realtime-v15-3'){
    await chrome.storage.local.set({webRuntimeReloadVersion:'realtime-v15-3'});chrome.runtime.reload();return;
  }
  if(webManagedWorker){await bridgeManagedHeartbeat();return;}
  if(WEB_SYNC.device==='vps')await chrome.storage.local.set({webCollectorPagePulse:Date.now(),webCollectorPageBuild:'realtime-v15.3'});
  bridgeHistoryScan();bridgeUpload();bridgePoll();bridgePagePulse();
  if(WEB_SYNC.device==='laptop'&&(await chrome.storage.local.get('webDeletionRepairVersion')).webDeletionRepairVersion!=='audit-v9'){
    if(await bridgeReconcileHistory())await chrome.storage.local.set({webDeletionRepairVersion:'audit-v9'});
  }
},1000);
