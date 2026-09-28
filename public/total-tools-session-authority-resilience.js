(()=>{'use strict';
const nativeFetch=window.fetch.bind(window);
let sessionExpiredShown=false;
let authorityNoticeKey='';
function root(){return document.getElementById('shell-root')}
function isAuthenticatedUi(){const r=root();return !!r?.classList.contains('shell-app')||!!document.querySelector('[id^="tt-"][class*="workspace"],#tt-logistics-intelligence')}
function requestPath(input){try{const raw=typeof input==='string'?input:input?.url;return new URL(raw,location.href).pathname}catch(_){return ''}}
function ignoredAuthPath(path){return path==='/api/employees/login'||path==='/api/employees/logout'||path==='/client-diagnostics'}
function notify(message){const ui=window.TotalToolsPremiumUI;if(ui?.notify)return ui.notify(message,{tone:'error',persist:true});let host=document.getElementById('tt-authority-notice');if(!host){host=document.createElement('div');host.id='tt-authority-notice';host.className='tt-runtime-error-banner';document.body.appendChild(host)}host.innerHTML='';const strong=document.createElement('strong');strong.textContent='Access changed';const span=document.createElement('span');span.textContent=message;const button=document.createElement('button');button.type='button';button.textContent='Reload permissions';button.onclick=()=>location.reload();host.append(strong,span,button)}
function report(kind,detail){try{const payload=JSON.stringify({kind,detail:String(detail||'').slice(0,4000),href:location.href,ua:navigator.userAgent,ts:new Date().toISOString()});nativeFetch('/client-diagnostics',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:payload,keepalive:true}).catch(()=>{})}catch(_){}}
function sessionExpired(requestId){if(sessionExpiredShown)return;sessionExpiredShown=true;report('session_expired_in_open_workspace',requestId||'no request id');const r=root();const host=document.createElement('div');host.id='tt-session-expired';host.className='tt-session-expired';host.innerHTML=`<div class="tt-session-expired__backdrop"></div><section class="tt-session-expired__card" role="alertdialog" aria-modal="true" aria-labelledby="tt-session-expired-title"><span>Session ended</span><h2 id="tt-session-expired-title">Sign in again to continue.</h2><p>Your session is no longer valid. The server rejected the current request before normal POS authorization, so do not repeat a financial or inventory action until you have signed in again.</p><div><button type="button" data-signin>Return to sign in</button></div><small></small></section>`;const ref=host.querySelector('small');if(requestId)ref.textContent=`Reference: ${requestId}`;document.body.appendChild(host);host.querySelector('[data-signin]').onclick=()=>location.reload();requestAnimationFrame(()=>host.querySelector('[data-signin]')?.focus());if(r)r.setAttribute('aria-hidden','true')}
async function inspect(response,path){if(!path.startsWith('/api/')||ignoredAuthPath(path))return;let data={};try{data=await response.clone().json()}catch(_){}
const requestId=response.headers.get('x-request-id')||data?.request_id||'';
if(response.status===401&&isAuthenticatedUi()){sessionExpired(requestId);return}
if(response.status!==403)return;
if(data?.code==='PASSWORD_CHANGE_REQUIRED'&&isAuthenticatedUi()){sessionExpired(requestId);return}
const control=String(data?.control||'');
if(control==='multi_branch_integrity'){
  const key=`branch:${data?.error||''}`;if(authorityNoticeKey===key)return;authorityNoticeKey=key;report('branch_authority_changed',`${data?.error||''} ${requestId}`);notify(`${data?.error||'Your branch assignment no longer permits this operation.'} Your current entries have not been intentionally cleared. Reload permissions before trying again.`);return
}
if(control==='rbac'||control.startsWith('dispatch_rbac')){
  const key=`rbac:${data?.error||''}`;if(authorityNoticeKey===key)return;authorityNoticeKey=key;report('permission_authority_changed',`${data?.error||''} ${requestId}`);notify(`${data?.error||'Your permissions no longer allow this operation.'} If your role was just changed, reload permissions before continuing.`)
}}
window.fetch=async function(input,init){const path=requestPath(input);let response;try{response=await nativeFetch(input,init)}catch(error){throw error}inspect(response,path).catch(()=>{});return response};
window.addEventListener('pageshow',event=>{if(event.persisted&&isAuthenticatedUi())nativeFetch('/api/workspace-profile/me',{credentials:'same-origin'}).then(r=>inspect(r,'/api/workspace-profile/me')).catch(()=>{})});
})();