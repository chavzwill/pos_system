(()=>{'use strict';
const STORE='tt-pos-sale-operation-v1';
const nativeFetch=window.fetch.bind(window);
const active=new Map();
function sameOriginTransactions(input,init){
  const raw=typeof input==='string'?input:(input&&input.url)||'';
  let url;try{url=new URL(raw,window.location.href)}catch(e){return false}
  const method=String(init?.method||(input&&input.method)||'GET').toUpperCase();
  return method==='POST'&&url.origin===window.location.origin&&url.pathname==='/api/transactions';
}
function bodyText(input,init){
  const body=init?.body;
  if(typeof body==='string')return body;
  if(body==null&&input instanceof Request)return null;
  return body==null?'':String(body);
}
function hashText(text){
  let h1=0x811c9dc5,h2=0x9e3779b9;
  for(let i=0;i<text.length;i++){
    const c=text.charCodeAt(i);h1=Math.imul(h1^c,0x01000193);h2=Math.imul(h2^c,0x85ebca6b);
  }
  return `${(h1>>>0).toString(16).padStart(8,'0')}${(h2>>>0).toString(16).padStart(8,'0')}:${text.length}`;
}
function newKey(){return `pos-${Date.now()}-${globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}`;}
function read(){try{return JSON.parse(sessionStorage.getItem(STORE)||'null')}catch(e){return null}}
function write(value){try{sessionStorage.setItem(STORE,JSON.stringify(value))}catch(e){}}
function clear(key){try{const current=read();if(!key||current?.key===key)sessionStorage.removeItem(STORE)}catch(e){}}
function operationFor(fingerprint){
  const current=read();
  if(current?.fingerprint===fingerprint&&current?.key)return current;
  const next={key:newKey(),fingerprint,created_at:new Date().toISOString()};write(next);return next;
}
function withHeader(input,init,key){
  const headers=new Headers(init?.headers||(input instanceof Request?input.headers:undefined));headers.set('Idempotency-Key',key);
  return {...(init||{}),headers};
}
function begin(key){const s=active.get(key)||{count:0,ambiguous:false,settled:false};s.count+=1;active.set(key,s);return s;}
function finish(key,{ambiguous=false,settled=false}={}){
  const s=active.get(key)||{count:1,ambiguous:false,settled:false};
  s.ambiguous=s.ambiguous||ambiguous;s.settled=s.settled||settled;s.count=Math.max(0,s.count-1);
  if(s.count===0){active.delete(key);if(s.settled&&!s.ambiguous)clear(key);}else active.set(key,s);
}
window.fetch=async function(input,init){
  if(!sameOriginTransactions(input,init))return nativeFetch(input,init);
  const text=bodyText(input,init);
  if(text==null)return nativeFetch(input,init);
  const op=operationFor(hashText(text));begin(op.key);
  try{
    const response=await nativeFetch(input,withHeader(input,init,op.key));
    if(response.ok)finish(op.key,{settled:true});
    else if(response.status===409||response.status>=500)finish(op.key,{ambiguous:true});
    else finish(op.key,{settled:true});
    return response;
  }catch(error){
    finish(op.key,{ambiguous:true});
    // Network ambiguity is exactly when the same operation identity must survive.
    throw error;
  }
};
window.TotalToolsSaleOperationJournal={storageKey:STORE,peek:read,clear};
})();
