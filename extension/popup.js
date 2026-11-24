
document.getElementById("open").addEventListener("click",()=>chrome.runtime.openOptionsPage());

(async()=>{
  const el=document.getElementById("presenceValue");
  if(!el)return;
  try{
    const s=(await chrome.storage.sync.get("sharedPresence")).sharedPresence||null;
    if(!s){
      el.textContent="Sin señal";
      return;
    }
    const age=Date.now()-Number(s.lastSeenAt||0);
    if(age>90000){
      el.textContent=`Última señal hace ${Math.floor(age/1000)} s`;
      return;
    }
    const host=s.host||"sitio web";
    const dev=s.deviceName||s.deviceType||"dispositivo";
    el.textContent=s.active?`${host} · ${dev} · activo ahora`:`${host} · ${dev} · Chrome no enfocado`;
  }catch{
    el.textContent="Sin señal";
  }
})();
