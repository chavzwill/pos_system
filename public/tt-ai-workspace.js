(()=>{'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={messages:[],busy:false,context:null};
async function api(url,opts={}){const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(d.error||'Request failed');e.code=d.code||d.error||null;e.status=r.status;throw e;}return d;}
function close(){document.getElementById('tt-ai-workspace')?.remove();}
function icon(){return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.64 5.64l2.12 2.12M16.24 16.24l2.12 2.12M18.36 5.64l-2.12 2.12M7.76 16.24l-2.12 2.12M12 8.5A3.5 3.5 0 1 1 12 15.5 3.5 3.5 0 0 1 12 8.5Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';}

function normalizedAnswer(result){
  if(typeof result?.answer==='string')return {text:result.answer,data:null};
  if(result?.answer&&typeof result.answer==='object')return {text:String(result.answer.text||''),data:result.answer.data||null};
  return {text:'No answer returned.',data:null};
}
function cardsFrom(result){
  if(Array.isArray(result?.cards))return result.cards;
  const answer=normalizedAnswer(result);
  const data=answer.data;
  const items=Array.isArray(data?.items)?data.items:(data&&data.id?[data]:[]);
  return items.slice(0,8).map(item=>{
    const isAsset=Boolean(item.asset_number||item.serial_number||item.allocations||item.maintenance);
    const facts=[];
    if(item.sku)facts.push({label:'SKU',value:item.sku});
    if(item.serial_number)facts.push({label:'Serial',value:item.serial_number});
    if(item.asset_number)facts.push({label:'Asset',value:item.asset_number});
    if(item.stock_qty!==undefined&&item.stock_qty!==null)facts.push({label:'Branch stock',value:item.stock_qty});
    if(item.price!==undefined&&item.price!==null)facts.push({label:'Price',value:Number.isFinite(Number(item.price))?Number(item.price).toLocaleString(undefined,{style:'currency',currency:'JMD'}):item.price});
    if(item.status)facts.push({label:'Status',value:item.status});
    if(Array.isArray(item.allocations))facts.push({label:'Allocations',value:item.allocations.length});
    if(Array.isArray(item.maintenance))facts.push({label:'Maintenance',value:item.maintenance.length});
    return {
      type:isAsset?'rental_asset':'product',
      source:item.source||'POS',
      title:item.name||item.product_name||item.asset_number||('Record '+(item.id??'')),
      subtitle:[item.brand,item.category,item.branch_name].filter(Boolean).join(' · '),
      facts,
    };
  });
}
function evidenceFrom(result){
  const source=Array.isArray(result?.evidence)?result.evidence:(Array.isArray(result?.citations)?result.citations:[]);
  return source.map(e=>({
    source:e.source||'unknown',
    tool:e.tool||'evidence',
    observedAt:e.observedAt||null,
  }));
}
function card(c){return `<article class="tt-ai-card"><div class="tt-ai-card__head"><span class="tt-ai-card__type">${esc(c.type==='rental_asset'?'Fleet asset':'Product')}</span><span class="tt-ai-card__source">${esc(c.source||'POS')}</span></div><strong>${esc(c.title||'Record')}</strong>${c.subtitle?`<p>${esc(c.subtitle)}</p>`:''}<dl>${(c.facts||[]).map(f=>`<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl></article>`;}
function renderMessage(m){
  if(m.role==='user')return `<div class="tt-ai-msg tt-ai-msg--user"><div>${esc(m.text)}</div></div>`;
  if(m.error)return `<div class="tt-ai-msg tt-ai-msg--assistant"><div class="tt-ai-answer tt-ai-answer--error"><span>Unable to answer</span><p>${esc(m.text)}</p></div></div>`;
  const r=m.result||{},answer=normalizedAnswer(r),cards=cardsFrom(r),evidence=evidenceFrom(r);
  return `<div class="tt-ai-msg tt-ai-msg--assistant"><div class="tt-ai-answer"><div class="tt-ai-answer__meta"><span class="tt-ai-kind tt-ai-kind--${esc(r.kind||'unknown')}">${esc(r.kind||'unknown')}</span><span>Evidence-first · Read only</span></div><p class="tt-ai-answer__text">${esc(answer.text)}</p>${cards.length?`<div class="tt-ai-cards">${cards.map(card).join('')}</div>`:''}${evidence.length?`<details><summary>Evidence used</summary><div class="tt-ai-evidence">${evidence.map(e=>`<span>${esc(e.source)} · ${esc(e.tool)}${e.observedAt?' · '+esc(new Date(e.observedAt).toLocaleString()):''}</span>`).join('')}</div></details>`:''}${r.limitations?.length?`<div class="tt-ai-limit">${r.limitations.map(x=>esc(x)).join(' · ')}</div>`:''}</div></div>`;
}
function render(){const root=document.getElementById('tt-ai-thread');if(!root)return;root.innerHTML=state.messages.length?state.messages.map(renderMessage).join(''):'<div class="tt-ai-empty"><div class="tt-ai-empty__mark">'+icon()+'</div><strong>Ask Total Tools, not the internet.</strong><p>TT AI checks the company records your role is allowed to see. If the evidence is missing, it says so instead of filling the gap.</p></div>';root.scrollTop=root.scrollHeight;}
function setComposer(enabled,reason=''){const input=document.getElementById('tt-ai-input'),btn=document.getElementById('tt-ai-send'),note=document.getElementById('tt-ai-composer-note');if(input){input.disabled=!enabled;input.placeholder=enabled?'Example: Do we have Bosch grinders in stock?':'TT AI service is not connected in this environment.';}if(btn){btn.disabled=!enabled||state.busy;}if(note&&reason)note.textContent=reason;}
async function send(text){
  const q=String(text||'').trim();if(q.length<2||state.busy)return;
  if(state.context?.capabilities?.query===false){setComposer(false,'The standalone TT AI service is not configured for this environment.');return;}
  state.messages.push({role:'user',text:q});state.busy=true;render();
  const input=document.getElementById('tt-ai-input'),btn=document.getElementById('tt-ai-send');
  if(input)input.value='';if(btn){btn.disabled=true;btn.textContent='Checking…';}
  try{const result=await api('/api/tt-ai/query',{method:'POST',body:JSON.stringify({message:q})});state.messages.push({role:'assistant',result});}
  catch(e){let text=e.message;if(e.code==='TT_AI_SERVICE_NOT_CONFIGURED')text='TT AI is installed, but this environment has not connected the standalone AI service yet.';else if(e.code==='TT_AI_PERMISSION_DENIED')text='Your current Total Tools permissions do not allow that lookup.';else if(e.status>=500)text='TT AI could not complete the company-data check. No answer was fabricated.';state.messages.push({role:'assistant',error:true,text});}
  finally{state.busy=false;if(btn){btn.textContent='Ask';btn.disabled=state.context?.capabilities?.query===false;}render();input?.focus();}
}
async function open(){
  close();let context=null;try{context=await api('/api/tt-ai/context');}catch(_){}state.context=context;
  const enabled=context?.capabilities?.query!==false;
  const el=document.createElement('section');el.id='tt-ai-workspace';el.className='tt-ai-workspace';
  el.innerHTML=`<div class="tt-ai-backdrop" data-close></div><div class="tt-ai-panel" role="dialog" aria-modal="true" aria-label="Ask TT AI"><header><div class="tt-ai-brand"><div class="tt-ai-mark">${icon()}</div><div><span>Total Tools Intelligence</span><h2>Ask TT AI</h2></div></div><div class="tt-ai-head-actions"><span class="tt-ai-readonly">Read only</span><button data-close aria-label="Close TT AI">Close</button></div></header><div class="tt-ai-status"><span class="tt-ai-dot ${enabled?'':'is-offline'}"></span><strong>${enabled?'Verified company data':'Service not connected'}</strong><span>${context?.branch_id?'Branch '+esc(context.branch_id)+' · ':''}No operational changes can be made from this workspace.</span></div><main id="tt-ai-thread"></main><div class="tt-ai-suggestions"><button data-q="Do we have Bosch grinders in stock?">Check branch stock</button><button data-q="Find rental generators">Find rental equipment</button><button data-q="Check serial GX1-00088">Check serial / asset</button></div><form id="tt-ai-form"><label for="tt-ai-input">Ask about products, stock, rental machines or exact fleet assets</label><div><textarea id="tt-ai-input" rows="2" maxlength="2000" placeholder="Example: Do we have Bosch grinders in stock?"></textarea><button id="tt-ai-send">Ask</button></div><small id="tt-ai-composer-note">TT AI distinguishes verified company evidence from unknown information. It cannot change stock, prices, rentals or other operational records.</small></form></div>`;
  document.body.appendChild(el);
  el.querySelectorAll('[data-close]').forEach(x=>x.onclick=close);
  el.querySelectorAll('[data-q]').forEach(x=>x.onclick=()=>{const input=el.querySelector('#tt-ai-input');if(!input.disabled){input.value=x.dataset.q;input.focus();}});
  el.querySelector('#tt-ai-form').onsubmit=e=>{e.preventDefault();send(el.querySelector('#tt-ai-input').value);};
  el.querySelector('#tt-ai-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send(e.currentTarget.value);}};
  render();
  setComposer(enabled,enabled?'TT AI distinguishes verified company evidence from unknown information. It cannot change stock, prices, rentals or other operational records.':'The standalone TT AI service is not configured for this environment.');
  if(enabled)el.querySelector('#tt-ai-input').focus();
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('tt-ai-workspace'))close();});
window.TotalToolsTTAI={open,close,ask:send};
})();