(()=>{'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url){
 const r=await fetch(url,{credentials:'same-origin'});
 const d=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(d.error||'Request failed');
 return d;
}
function close(){document.getElementById('tt-customer-pickup-modal')?.remove();}
function shell(){
 close();
 const el=document.createElement('div');
 el.id='tt-customer-pickup-modal';
 el.className='tt-ea-modal';
 el.innerHTML='<div class="tt-ea-backdrop" data-close></div><section><header><div><small>Employee tools</small><h2>Customer Pickup Desk</h2><p>Everything already ready for a customer handoff, in one queue.</p></div><button data-close>Close</button></header><main><div class="tt-ea-empty">Checking what is ready...</div></main></section>';
 document.body.appendChild(el);
 el.querySelectorAll('[data-close]').forEach(x=>x.onclick=close);
 return el.querySelector('main');
}
function waitText(minutes){
 if(minutes==null)return 'Ready';
 if(minutes<60)return `Ready ${minutes} min`;
 const hours=Math.floor(minutes/60);
 if(hours<24)return `Ready ${hours} hr${hours===1?'':'s'}`;
 const days=Math.floor(hours/24);
 return `Ready ${days} day${days===1?'':'s'}`;
}
async function openPickupDesk(){
 const m=shell();
 try{
  const d=await api('/api/employee-assist/customer-pickups');
  const rows=d.items||[],s=d.summary||{};
  const cards=rows.length?rows.map(r=>`<article class="tt-ea-handover" data-customer-pickups><div><span>${esc(r.record_type)}</span><strong>${esc(r.customer_name)} · ${esc(r.reference)}</strong><p>${esc(r.next_action||'Open the record to complete handoff')}</p><small>${esc(r.phone||'No phone')} · ${esc(r.branch_name||'Current branch')} · ${esc(waitText(r.age_minutes))}</small></div><button data-pickup-id="${esc(r.record_id)}" data-pickup-type="${esc(r.record_type)}" data-pickup-action="${esc(r.action)}">Open</button></article>`).join(''):'<div class="tt-ea-empty">Nothing is waiting for customer pickup right now.</div>';
  m.innerHTML=`<div class="tt-ea-shift-summary"><strong>${s.total||0} customer pickup${Number(s.total||0)===1?'':'s'} ready</strong><p>Open the exact record to complete payment, signatures, security checks or handoff in the normal workflow.</p><small>${s.repairs||0} repair · ${s.rentals||0} rental</small></div><div>${cards}</div>`;
  m.querySelectorAll('[data-pickup-id]').forEach(b=>b.onclick=()=>{
   close();
   window.TotalToolsEmployeeAssist?.openContext({action:b.dataset.pickupAction,record_id:b.dataset.pickupId,type:b.dataset.pickupType});
  });
 }catch(e){m.innerHTML=`<div class="tt-ea-empty">${esc(e.message)}</div>`;}
}
function ensure(){
 const box=document.getElementById('tt-employee-assist-tools');
 if(!box||box.querySelector('[data-customer-pickups]'))return;
 const b=document.createElement('button');
 b.textContent='Pickups';
 b.setAttribute('data-customer-pickups','');
 b.onclick=openPickupDesk;
 box.insertBefore(b,box.querySelector('[data-ea-end-shift]')||null);
}
new MutationObserver(ensure).observe(document.documentElement,{subtree:true,childList:true});
ensure();
window.TotalToolsCustomerPickupDesk={open:openPickupDesk};
})();
