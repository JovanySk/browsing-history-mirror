const VISITS_STORE='visits',EVENTS_STORE='events';
async function remoteDB(op,args={}){
  const body=await webJSON('/api/db?source='+encodeURIComponent(window.webSource||'all'),{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,args})
  });
  return body.result;
}
async function queryVisits(options={}){return remoteDB('queryVisits',options);}
async function countStore(store,index=null,key=null){return remoteDB('countStore',{store,index,key});}
async function getRecentEvents(limit=50){return remoteDB('getRecentEvents',{limit});}
async function getAggregationSample(limit=5000){return remoteDB('getAggregationSample',{limit});}
