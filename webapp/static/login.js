async function connectBrowser(path,body){
  const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'No se pudo conectar');
  location.replace('/');
}
async function initializeAccess(){
  const token=new URLSearchParams(location.hash.slice(1)).get('acceso');
  if(token){history.replaceState(null,'','/');try{await connectBrowser('/auth/activate',{token});return;}catch(error){document.querySelector('#error').textContent=error.message;}}
  else{try{const response=await fetch('/auth/status',{credentials:'same-origin'});if(response.ok){location.replace('/');return;}}catch{}}
  document.querySelector('#status').textContent='Conecta este navegador una sola vez. Después entrarás directamente al panel.';
  document.querySelector('#login').hidden=false;
}
document.querySelector('#login').addEventListener('submit',async event=>{
  event.preventDefault();const button=document.querySelector('#enter');button.disabled=true;document.querySelector('#error').textContent='';
  try{await connectBrowser('/auth/login',{password:document.querySelector('#password').value});}catch(error){document.querySelector('#error').textContent=error.message;button.disabled=false;}
});
initializeAccess();
