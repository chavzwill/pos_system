(()=>{'use strict';
const nativeFetch=window.fetch.bind(window);
function activeHoldId(){
  const ws=document.getElementById('tt-held-sales');
  if(!ws)return null;
  const selected=ws.querySelector('[data-hold].is-selected')||ws.querySelector('[data-hold]');
  const id=Number(selected?.dataset?.hold||0);
  return id||null;
}
window.fetch=async function(input,init){
  const url=typeof input==='string'?input:(input&&input.url)||'';
  const method=String(init?.method||(input&&input.method)||'GET').toUpperCase();
  if(method==='POST'&&/\/api\/transactions(?:\?|$)/.test(url)&&document.getElementById('tt-held-sales')){
    try{
      const body=typeof init?.body==='string'?JSON.parse(init.body):null;
      const holdId=activeHoldId();
      if(body&&holdId&&/^Recalled from\s+/i.test(String(body.notes||''))){
        body.source_hold_id=holdId;
        init={...(init||{}),body:JSON.stringify(body)};
      }
    }catch(_){ }
  }
  return nativeFetch(input,init);
};
})();
