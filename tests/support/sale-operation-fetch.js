'use strict';
const crypto=require('crypto');

const nativeFetch=globalThis.fetch?.bind(globalThis);
if(nativeFetch&&!globalThis.__TT_TEST_SALE_OPERATION_FETCH__){
  globalThis.__TT_TEST_SALE_OPERATION_FETCH__=true;
  globalThis.fetch=async function(input,init={}){
    const raw=typeof input==='string'||input instanceof URL?String(input):(input&&input.url)||'';
    let url=null;try{url=new URL(raw,'http://localhost:3001');}catch(e){}
    const method=String(init?.method||(input&&input.method)||'GET').toUpperCase();
    if(url&&url.pathname==='/api/transactions'&&method==='POST'){
      const headers=new Headers(init?.headers||(input instanceof Request?input.headers:undefined));
      const bypass=headers.get('X-Test-No-Idempotency')==='1';
      headers.delete('X-Test-No-Idempotency');
      if(!bypass&&!headers.has('Idempotency-Key')&&!headers.has('X-Idempotency-Key')){
        headers.set('Idempotency-Key',`ci-sale-${Date.now()}-${crypto.randomUUID()}`);
      }
      return nativeFetch(input,{...(init||{}),headers});
    }
    return nativeFetch(input,init);
  };
}
