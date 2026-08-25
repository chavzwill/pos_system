(()=>{'use strict';
let branches=[],profile=null,loading=null;
const nativeFetch=window.fetch.bind(window);
const root=()=>document.getElementById('tt-purchasing-workspace');
const composer=()=>root()?.querySelector('.tt-purch__composer');
const form=()=>composer()?.querySelector('#tt-purch-compose-form');
const isPoComposer=()=>/create purchase order/i.test(composer()?.querySelector('#tt-purch-compose-title')?.textContent||'');
async function json(url){const r=await nativeFetch(url,{credentials:'same-origin'});if(!r.ok)throw new Error(`Request failed (${r.status})`);return r.json();}
async function loadContext(){if(loading)return loading;loading=(async()=>{try{profile=await json('/api/workspace-profile/me');}catch(_){profile=null;}try{const data=await json('/api/branches?active=true');branches=Array.isArray(data)?data:(Array.isArray(data?.branches)?data.branches:[]);}catch(_){branches=[];}return{profile,branches};})().finally(()=>{loading=null;});return loading;}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function selectedBranch(){const sel=form()?.querySelector('select[name="branch_id"]');return sel?.value||'';}
function defaultBranch(){return String(profile?.employee?.default_branch_id||'');}
function inject(){const f=form();if(!f||!isPoComposer()||f.querySelector('select[name="branch_id"]'))return;const grid=f.querySelector('.tt-purch__compose-grid');if(!grid)return;const label=document.createElement('label');label.setAttribute('data-po-branch-field','true');label.innerHTML=`Receiving branch<select name="branch_id" required aria-label="Receiving branch"><option value="">Select receiving branch</option>${branches.filter(b=>b.active!==0&&b.active!==false).map(b=>`<option value="${esc(b.id)}">${esc(b.name||b.branch_name||`Branch ${b.id}`)}</option>`).join('')}</select>`;grid.insertBefore(label,grid.children[1]||null);const sel=label.querySelector('select');const preferred=defaultBranch();if(preferred&&[...sel.options].some(o=>String(o.value)===preferred))sel.value=preferred;sel.addEventListener('change',()=>window.TotalToolsGuidedModeCompletion?.recheck?.());window.TotalToolsGuidedModeCompletion?.recheck?.();}
async function ensure(){if(!isPoComposer())return;if(!branches.length&&!profile)await loadContext();inject();}
window.fetch=async function(input,init){const url=typeof input==='string'?input:(input&&input.url)||'';const method=String(init?.method||(input&&input.method)||'GET').toUpperCase();if(method==='POST'&&/\/api\/purchase-orders(?:\?|$)/.test(url)){
  try{let body=init?.body;if(typeof body==='string'){const payload=JSON.parse(body);if(!payload.branch_id){const branch=selectedBranch()||defaultBranch();if(branch)payload.branch_id=Number(branch)||branch;}init={...(init||{}),body:JSON.stringify(payload)};}}
  catch(_){ }
}
return nativeFetch(input,init);};
const obs=new MutationObserver(()=>{if(isPoComposer())ensure();});obs.observe(document.body,{subtree:true,childList:true});
document.addEventListener('click',e=>{if(e.target.closest?.('#tt-purch-new-po,[data-guide-next],[data-task]'))setTimeout(ensure,40);},true);
loadContext().then(inject);
window.TotalToolsPurchaseOrderBranchContext={ensure,selectedBranch};
})();