(() => {
  const css = `#shwAccount{display:inline-flex;flex:0 0 auto;position:relative;z-index:10001;font-family:inherit;margin:6px 0 0 6px;min-width:max-content}#shwAccount button{border:1px solid rgba(255,255,255,.16);background:#102033;color:#fff;border-radius:11px;padding:9px 12px;font-weight:800;cursor:pointer;box-shadow:0 8px 24px #0005;white-space:nowrap;min-width:max-content}.shwPop{position:fixed;left:50%;top:50%;right:auto;transform:translate(-50%,-50%);width:min(420px,calc(100vw - 32px));max-width:calc(100vw - 32px);box-sizing:border-box;background:#0c1622;border:1px solid #31465e;border-radius:18px;padding:22px;box-shadow:0 22px 70px #000b;color:#fff;z-index:100000;max-height:calc(100vh - 32px);overflow:auto;text-align:left}.shwPop h3{margin:0 0 16px;text-align:center;font-size:20px}.shwPop input{display:block;width:100%;box-sizing:border-box;margin:9px 0;padding:12px;border-radius:10px;border:1px solid #2a3d54;background:#07111b;color:#fff;font:inherit;outline:none}.shwPop input:focus{border-color:#39df92}.shwPop .shwActions{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}.shwPop .shwActions button{flex:1 1 150px;min-width:0;white-space:normal}.shwPop .shwPrimary{background:linear-gradient(135deg,#39df92,#2bbfba);color:#03130c;border:0}.shwPop .shwMsg{font-size:13px;line-height:1.5;color:#a9bacd;margin-top:10px}.shwPro{color:#7dffb0!important}.shwAccountClose{position:absolute;right:12px;top:10px;background:transparent!important;border:0!important;box-shadow:none!important;font-size:22px;padding:2px 6px!important;min-width:0!important}.shwPop>div:first-of-type{overflow-wrap:anywhere}@media(max-width:520px){#shwAccount{margin-left:4px}#shwAccount button{padding:8px 9px;font-size:13px}.shwPop{width:calc(100vw - 24px);max-width:calc(100vw - 24px);padding:18px}.shwPop .shwActions{flex-direction:column}.shwPop .shwActions button{width:100%;flex-basis:auto}}`;
  const style=document.createElement('style'); style.textContent=css; document.head.appendChild(style);
  const root=document.createElement('div'); root.id='shwAccount'; const proBtn=document.getElementById('proBtn'); if(proBtn && proBtn.parentElement) proBtn.insertAdjacentElement('afterend',root); else {root.style.position='fixed';root.style.top='14px';root.style.right='14px';document.body.appendChild(root);}
  let state={loggedIn:false,isPro:false,email:''};
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function me(){try{const r=await fetch('/api/auth/me',{credentials:'same-origin'});state=await r.json();render();}catch{}}
  function render(){
    if(state.loggedIn){root.innerHTML=`<button id="shwAccountBtn" class="topBtn ${state.isPro?'shwPro':''}">${state.isPro?'👑 PRO · ': '👤 '} ${esc(state.email)}</button>`;}
    else root.innerHTML='<button id="shwAccountBtn" class="topBtn">👤 Iniciar sesión</button>';
    root.querySelector('#shwAccountBtn').onclick=()=>openPanel();
  }
  function openPanel(){
    const panel=document.createElement('div'); panel.className='shwPop';
    if(state.loggedIn){panel.innerHTML=`<button class="shwAccountClose" id="shwClose">×</button><h3>👤 Mi cuenta</h3><div>${esc(state.email)}</div><p class="shwMsg">Estado: <b>${state.isPro?'PRO activo':'Cuenta gratuita'}</b></p>${state.isPro?'<p class="shwMsg">Tu PRO queda guardado en tu cuenta y puede recuperarse desde otro celular iniciando sesión.</p>':'<p class="shwMsg">Comprá PRO desde la sección PRO para asociarlo a esta cuenta.</p>'}<div class="shwActions"><button id="shwLogout">Cerrar sesión</button></div>`;
      panel.querySelector('#shwLogout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST'});state={loggedIn:false,isPro:false,email:''};panel.remove();render();};
    } else {panel.innerHTML=`<button class="shwAccountClose" id="shwClose">×</button><h3 id="shwTitle">👤 Iniciar sesión</h3><input id="shwEmail" type="email" autocomplete="email" placeholder="Email"><input id="shwPass" type="password" autocomplete="current-password" placeholder="Contraseña"><div class="shwActions"><button class="shwPrimary" id="shwSubmit">Iniciar sesión</button><button id="shwToggle">Crear cuenta</button></div><div class="shwMsg" id="shwMsg"></div>`;
      let register=false;
      const title=panel.querySelector('#shwTitle'), submit=panel.querySelector('#shwSubmit'), toggle=panel.querySelector('#shwToggle'), msg=panel.querySelector('#shwMsg');
      toggle.onclick=()=>{register=!register;title.textContent=register?'👤 Crear cuenta':'👤 Iniciar sesión';submit.textContent=register?'Crear cuenta':'Iniciar sesión';toggle.textContent=register?'Ya tengo cuenta':'Crear cuenta';};
      submit.onclick=async()=>{msg.textContent='Procesando…';const email=panel.querySelector('#shwEmail').value, password=panel.querySelector('#shwPass').value;const url=register?'/api/auth/register':'/api/auth/login';try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({email,password})});const d=await r.json();if(!r.ok){msg.textContent=d.error||'No se pudo completar.';return}await me();panel.remove();}catch{msg.textContent='No se pudo conectar con el servidor.'}};
    }
    panel.querySelector('#shwClose').onclick=()=>panel.remove(); root.appendChild(panel);
  }
  document.addEventListener('click',async e=>{
    const b=e.target.closest('#buyProMonthly,#buyProQuarterly,#buyProAnnual,#hw74Monthly,#hw74Quarterly,#hw74Annual');
    if(!b)return;
    e.preventDefault(); e.stopImmediatePropagation();
    if(!state.loggedIn){openPanel();return;}
    const plan=b.id.toLowerCase().includes('quarter')?'quarterly':b.id.toLowerCase().includes('annual')?'annual':'monthly';
    b.disabled=true; const old=b.textContent; b.textContent='CARGANDO…';
    try{const r=await fetch('/api/create-preference',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({plan})});const d=await r.json();if(r.status===401){openPanel();return}if(!r.ok)throw new Error(d.error||'No se pudo crear el pago');location.href=d.init_point;}catch(err){alert(err.message);b.disabled=false;b.textContent=old;}
  },true);
  me();
})();
