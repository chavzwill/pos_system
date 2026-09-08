(()=>{'use strict';
const root=()=>document.getElementById('shell-root');
const LOGIN_ENDPOINT='/api/employees/login';
const DIAGNOSTICS_ENDPOINT='/client-diagnostics';
let fatalShown=false;

function requestIdFrom(response,data){return response?.headers?.get('x-request-id')||data?.request_id||''}
function humanError(status,data,response){
  const base=String(data?.error||'').trim();
  if(status===400)return base||'Check the information entered and try again.';
  if(status===401)return base||'The username or password is incorrect.';
  if(status===403){
    if(data?.code==='PASSWORD_CHANGE_REQUIRED')return 'Your password must be changed before the POS can open.';
    return base||'You are signed in, but this account is not allowed to perform that action.';
  }
  if(status===409)return base||'Another operation changed this record first. Refresh and try again.';
  if(status===429){const retry=response?.headers?.get('Retry-After');return `${base||'Too many attempts. Please wait before trying again.'}${retry?` Try again in about ${retry} seconds.`:''}`}
  if(status>=500)return `${base||'The POS service could not complete the request.'} Please try again. If it continues, give support the request reference below.`;
  return base||`The request could not be completed (${status}).`;
}
async function safeRequest(url,options={}){
  const timeout=Number(options.timeout||15000),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch(url,{credentials:'same-origin',...options,signal:controller.signal,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(options.headers||{})}});
    const text=await response.text();let data={};
    if(text){try{data=JSON.parse(text)}catch(_){data={error:response.ok?'Unexpected server response':'The server returned an unreadable response.'}}}
    if(!response.ok){const e=new Error(humanError(response.status,data,response));e.status=response.status;e.code=data?.code||'';e.requestId=requestIdFrom(response,data);e.retryAfter=response.headers.get('Retry-After')||'';e.data=data;throw e}
    return {data,response};
  }catch(e){
    if(e?.name==='AbortError'){const x=new Error('The request timed out. Check the connection and try again.');x.code='TIMEOUT';throw x}
    if(e instanceof TypeError){const x=new Error('The POS could not reach the server. Check the connection and try again.');x.code='NETWORK';throw x}
    throw e;
  }finally{clearTimeout(timer)}
}
window.TotalToolsSafeRequest=safeRequest;

function report(kind,detail){
  const payload=JSON.stringify({kind:String(kind||'client_error').slice(0,80),detail:String(detail||'').slice(0,4000),href:location.href,ua:navigator.userAgent,ts:new Date().toISOString()});
  try{if(navigator.sendBeacon){navigator.sendBeacon(DIAGNOSTICS_ENDPOINT,new Blob([payload],{type:'application/json'}));return}}catch(_){}
  fetch(DIAGNOSTICS_ENDPOINT,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:payload,keepalive:true}).catch(()=>{});
}
function referenceText(error){return error?.requestId?`Reference: ${error.requestId}`:''}
function setInlineError(form,message,error){
  const box=form?.querySelector('#shell-login-error,.tt-auth-error');if(!box)return;
  box.textContent='';box.setAttribute('role','alert');box.setAttribute('aria-live','assertive');
  const msg=document.createElement('div');msg.textContent=message;box.appendChild(msg);
  const ref=referenceText(error);if(ref){const small=document.createElement('small');small.textContent=ref;box.appendChild(small)}
}
function passwordChangeView(employee){
  const r=root();if(!r)return;
  r.className='';
  const name=[employee?.first_name,employee?.last_name].filter(Boolean).join(' ')||employee?.username||'Employee';
  r.innerHTML=`<section class="shell-login"><div class="shell-login__brand"><div><div class="shell-mark">TT</div><h1>Total Tools Operations</h1><p>Your account is authenticated, but a secure password change is required before operational workspaces can open.</p></div><small>Credential protection · Session reset · RBAC preserved</small></div><div class="shell-login__panel"><form class="shell-login__card tt-password-change" id="tt-password-change"><span class="tt-auth-eyebrow">Password update required</span><h2>Set a new password</h2><p>${escapeHtml(name)}, create a password with at least 12 characters, including uppercase, lowercase, a number and a symbol.</p><label>New password<input name="password" type="password" autocomplete="new-password" minlength="12" required></label><label>Confirm new password<input name="confirm_password" type="password" autocomplete="new-password" minlength="12" required></label><button type="submit">Update password</button><button type="button" class="secondary" data-auth-signout>Sign out instead</button><div class="tt-auth-error"></div></form></div></section>`;
  const form=document.getElementById('tt-password-change');
  form?.addEventListener('submit',e=>changePassword(e,employee));
  form?.querySelector('[data-auth-signout]')?.addEventListener('click',signOut);
  requestAnimationFrame(()=>form?.querySelector('input')?.focus());
}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function strongEnough(v){const p=String(v||'');return p.length>=12&&/[a-z]/.test(p)&&/[A-Z]/.test(p)&&/\d/.test(p)&&/[^A-Za-z0-9]/.test(p)}
async function changePassword(event,employee){
  event.preventDefault();event.stopImmediatePropagation();
  const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),fd=new FormData(form),password=String(fd.get('password')||''),confirmPassword=String(fd.get('confirm_password')||'');
  if(!strongEnough(password))return setInlineError(form,'Password must be at least 12 characters and include lowercase, uppercase, a number, and a symbol.');
  if(password!==confirmPassword)return setInlineError(form,'The two password entries do not match.');
  button.disabled=true;button.textContent='Updating…';setInlineError(form,'');
  try{
    await safeRequest(`/api/employees/${encodeURIComponent(employee.id)}/change-password`,{method:'PUT',body:JSON.stringify({password,current_password:''})});
    report('password_change_completed','Required password change completed; reauthentication requested.');
    location.reload();
  }catch(error){
    report('password_change_failed',`${error?.code||error?.status||''} ${error?.message||error}`);
    setInlineError(form,error.message||'The password could not be changed.',error);button.disabled=false;button.textContent='Update password';
  }
}
async function signOut(){
  try{await safeRequest('/api/employees/logout',{method:'POST',body:'{}',timeout:8000})}catch(_){}
  location.reload();
}
async function interceptLogin(event){
  const form=event.target;if(!(form instanceof HTMLFormElement)||form.id!=='shell-login'||form.dataset.ttAuthBypass==='1')return;
  event.preventDefault();event.stopImmediatePropagation();
  if(form.dataset.ttAuthBusy==='1')return;
  const fd=new FormData(form),username=String(fd.get('username')||'').trim(),password=String(fd.get('password')||'');
  if(!username||!password){setInlineError(form,'Enter both your username and password.');(username?form.querySelector('[name="password"]'):form.querySelector('[name="username"]'))?.focus();return}
  const button=form.querySelector('button[type="submit"],button:not([type])');form.dataset.ttAuthBusy='1';if(button){button.disabled=true;button.textContent='Signing in…'}setInlineError(form,'');
  try{
    const {data}=await safeRequest(LOGIN_ENDPOINT,{method:'POST',body:JSON.stringify({username,password}),timeout:15000});
    if(Number(data?.must_change_password)===1){delete form.dataset.ttAuthBusy;passwordChangeView(data);return}
    report('login_success','Employee login succeeded; reloading authenticated shell.');
    // Do not hot-swap the entire authenticated application from inside the login submit stack.
    // A clean navigation guarantees all deferred runtimes initialize against the authenticated DOM once.
    location.reload();
  }catch(error){
    report('login_failed',`${error?.code||error?.status||''} ${error?.message||error}`);
    setInlineError(form,error.message||'Sign in failed.',error);delete form.dataset.ttAuthBusy;if(button){button.disabled=false;button.textContent='Sign in'}
  }
}
document.addEventListener('submit',interceptLogin,true);

function nonFatalNotice(message,detail){
  const api=window.TotalToolsPremiumUI;if(api?.notify)return api.notify(message,{tone:'error',persist:true});
  let host=document.getElementById('tt-runtime-error-banner');if(!host){host=document.createElement('div');host.id='tt-runtime-error-banner';host.className='tt-runtime-error-banner';document.body.appendChild(host)}
  host.innerHTML='';const strong=document.createElement('strong');strong.textContent='Something did not finish loading.';const span=document.createElement('span');span.textContent=message;const button=document.createElement('button');button.type='button';button.textContent='Reload';button.onclick=()=>location.reload();host.append(strong,span,button);if(detail)host.title=String(detail).slice(0,500);
}
function fatalRecovery(message,detail){
  if(fatalShown)return;fatalShown=true;const r=root();if(!r)return;
  r.className='';r.innerHTML=`<section class="tt-shell-recovery" role="alert"><div class="shell-mark">TT</div><span class="tt-auth-eyebrow">POS recovery</span><h1>The workspace could not finish opening.</h1><p></p><div><button type="button" data-retry>Retry</button><button type="button" class="secondary" data-signout>Sign out</button></div><small></small></section>`;
  r.querySelector('p').textContent=message||'A client-side error interrupted startup. Your transaction data was not intentionally changed by this recovery screen.';
  r.querySelector('small').textContent=detail?String(detail).slice(0,500):'';
  r.querySelector('[data-retry]').onclick=()=>location.reload();r.querySelector('[data-signout]').onclick=signOut;
}
function shellNotReady(){const r=root();return !r||r.classList.contains('shell-loading')||(!r.classList.contains('shell-app')&&!document.getElementById('shell-login')&&!document.getElementById('tt-password-change'))}
window.addEventListener('error',event=>{
  const detail=event?.error?.stack||event?.message||'Unknown client error';report('window_error',detail);
  if(shellNotReady())fatalRecovery('The POS encountered an error while starting. Retry the workspace or sign out safely.',detail);else nonFatalNotice('The current action may not have completed. Reload before retrying a financial, inventory, rental, repair or dispatch action.',detail);
},true);
window.addEventListener('unhandledrejection',event=>{
  const reason=event?.reason,detail=reason?.stack||reason?.message||String(reason||'Unhandled promise rejection');report('unhandled_rejection',detail);
  if(shellNotReady())fatalRecovery('The POS encountered an unexpected startup failure. Retry the workspace or sign out safely.',detail);else nonFatalNotice('A background operation failed. Verify the current record before repeating the action.',detail);
});
setTimeout(()=>{const r=root();if(r?.classList.contains('shell-loading')){report('shell_boot_timeout','Fast shell remained in loading state for more than 15 seconds.');fatalRecovery('The POS took too long to start. Check the connection and retry.','Startup timeout after 15 seconds.')}},15000);
})();
