'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const calls = [];
const actualLoad = Module._load;
Module._load = function(request,parent,isMain) {
  const origin=String(parent?.filename||'').replace(/\\/g,'/');
  if (origin.endsWith('/lib/tt-ai-assertion.js') && request === './permissions') {
    return { can:(permissions,key)=>permissions?.[key] === true };
  }
  if (origin.endsWith('/lib/tt-ai-client.js') && request === './tt-ai-read-tools') {
    return {executeTTAIReadTool:async(tool,input,employee)=>{
      calls.push({tool,input,employeeId:employee.id});
      return {source:'pos',branch_id:String(input.branchId),items:[{
        id:17,name:'Grinder',sku:'GR-17',stock_qty:2,
      }]};
    }};
  }
  return actualLoad.call(this,request,parent,isMain);
};
let queryTTAI, configuration, requestTTAIAdmin;
try { ({queryTTAI,configuration,requestTTAIAdmin}=require('../lib/tt-ai-client')); }
finally { Module._load=actualLoad; }

const { privateKey, publicKey }=crypto.generateKeyPairSync('ed25519');
const privatePem=privateKey.export({type:'pkcs8',format:'pem'});
const employee={id:42,default_branch_id:2,permissions:{inventory:true}};
const requestId='tt-ai-integration-001';
const previousUrl=process.env.TT_AI_SERVICE_URL;
const previousKey=process.env.TT_AI_SIGNING_PRIVATE_KEY;

async function scenario(responses, expected) {
  const oldFetch=global.fetch;
  const bodies=[],tokens=[];
  calls.length=0;
  process.env.TT_AI_SERVICE_URL='http://127.0.0.1:8787';
  process.env.TT_AI_SIGNING_PRIVATE_KEY=privatePem;
  global.fetch=async(url,options)=>{
    assert.equal(String(url),'http://127.0.0.1:8787/v1/query');
    assert.equal(options.method,'POST');
    bodies.push(JSON.parse(options.body));
    const token=options.headers.authorization.replace(/^Bearer /,'');
    tokens.push(token);
    const [version,payload,signature]=token.split('.');
    assert.equal(version,'v2');
    assert.equal(crypto.verify(
      null,Buffer.from(version+'.'+payload,'utf8'),publicKey,
      Buffer.from(signature,'base64url'),
    ),true);
    const claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    assert.equal(claims.request_id,requestId);
    assert.equal(claims.branch_id,'2');
    const next=responses[bodies.length-1];
    assert.ok(next,'Unexpected extra HTTP request');
    return {ok:true,json:async()=>next};
  };
  try {
    const result=await queryTTAI({employee,message:'Do we have grinders in stock?',requestId});
    if (expected) assert.equal(result.phase,expected);
    return {result,bodies,tokens,readCalls:[...calls]};
  } finally {
    global.fetch=oldFetch;
    if(previousUrl===undefined)delete process.env.TT_AI_SERVICE_URL;
    else process.env.TT_AI_SERVICE_URL=previousUrl;
    if(previousKey===undefined)delete process.env.TT_AI_SIGNING_PRIVATE_KEY;
    else process.env.TT_AI_SIGNING_PRIVATE_KEY=previousKey;
  }
}
function plan(tool='pos.products.search',branchId='2') {
  return {phase:'needs_evidence',request_id:requestId,plan:[{
    tool,source:'pos',input:{query:'grinders',branchId,limit:10},
  }]};
}
function answer(id=requestId,phase='complete') {
  return {phase,request_id:id,kind:'verified',answer:{text:'Grinder: stock 2',data:null},evidence:[]};
}

test('real Ed25519 signer, fresh nonce and two-phase query with POS fixture',async()=>{
  const {result,bodies,tokens,readCalls}=await scenario([plan(),answer()],'complete');
  assert.equal(result.kind,'verified');
  assert.equal(bodies.length,2);
  assert.equal(bodies[0].evidence,undefined);
  assert.equal(bodies[1].evidence[0].tool,'pos.products.search');
  assert.equal(bodies[1].evidence[0].data.branch_id,'2');
  assert.equal(readCalls.length,1);
  assert.notEqual(tokens[0],tokens[1]);
});

test('cross-branch plan rejected before any POS database read',async()=>{
  await assert.rejects(scenario([plan('pos.products.search','3')]),/another branch/);
  assert.equal(calls.length,0);
});
test('mutation or unknown plan tool rejected before any POS read',async()=>{
  await assert.rejects(scenario([plan('pos.products.delete')]),/unsupported read tool/);
  assert.equal(calls.length,0);
});
test('mismatched reply request ID rejected before POS read',async()=>{
  await assert.rejects(scenario([{...plan(),request_id:'other-request'}]),/inconsistent query reply/);
  assert.equal(calls.length,0);
});
test('empty plan rejected as invalid',async()=>{
  await assert.rejects(scenario([{...plan(),plan:[]}]),/empty or invalid evidence plan/);
  assert.equal(calls.length,0);
});
test('second response must match ID and finish the query',async()=>{
  await assert.rejects(scenario([plan(),answer('wrong-request')]),/inconsistent query reply/);
  await assert.rejects(scenario([plan(),answer(requestId,'needs_evidence')]),/inconsistent query reply/);
});

test('TT AI service configuration allows only clean HTTPS origins',()=>{
  const originalUrl=process.env.TT_AI_SERVICE_URL;
  const originalEnv=process.env.NODE_ENV;
  try {
    process.env.NODE_ENV='production';
    for(const bad of [
      'https://user:pass@tt-ai.example.test',
      'https://tt-ai.example.test/other-service',
      'https://tt-ai.example.test/?token=secret',
      'https://tt-ai.example.test/#fragment',
      'http://tt-ai.example.test',
      'http://localhost:8787',
      'file:///tmp/tt-ai',
    ]) {
      process.env.TT_AI_SERVICE_URL=bad;
      assert.throws(()=>configuration(),e=>[
        'TT_AI_SERVICE_URL_INVALID','TT_AI_SERVICE_HTTPS_REQUIRED',
      ].includes(e.code),bad);
    }
    process.env.TT_AI_SERVICE_URL='https://tt-ai.example.test:8443/';
    assert.equal(configuration(),'https://tt-ai.example.test:8443');
    process.env.NODE_ENV='test';
    process.env.TT_AI_SERVICE_URL='http://127.0.0.1:8787/';
    assert.equal(configuration(),'http://127.0.0.1:8787');
  }finally {
    if(originalUrl===undefined)delete process.env.TT_AI_SERVICE_URL;
    else process.env.TT_AI_SERVICE_URL=originalUrl;
    if(originalEnv===undefined)delete process.env.NODE_ENV;
    else process.env.NODE_ENV=originalEnv;
  }
});

test('TT AI admin routing refuses traversal and URLs with query or fragment',async()=>{
  const oldUrl=process.env.TT_AI_SERVICE_URL;
  const oldKey=process.env.TT_AI_SIGNING_PRIVATE_KEY;
  const oldFetch=global.fetch;
  try{
    process.env.TT_AI_SERVICE_URL='https://tt-ai.example.test';
    process.env.TT_AI_SIGNING_PRIVATE_KEY=privatePem;
    global.fetch=async()=>{throw Error('Unsafe route must not send a request');};
    for(const path of [
      '/v1/admin/knowledge/catalog-links/../../query',
      '/v1/admin/knowledge/catalog-links/list?untrusted=1',
      '/v1/admin/knowledge/technical-proposals/list#fragment',
    ]) {
      await assert.rejects(requestTTAIAdmin({employee,path,requestId}),error=>
        error?.code==='TT_AI_ADMIN_PATH_NOT_ALLOWED',path);
    }
  }finally{
    if(oldUrl===undefined)delete process.env.TT_AI_SERVICE_URL;
    else process.env.TT_AI_SERVICE_URL=oldUrl;
    if(oldKey===undefined)delete process.env.TT_AI_SIGNING_PRIVATE_KEY;
    else process.env.TT_AI_SIGNING_PRIVATE_KEY=oldKey;
    global.fetch=oldFetch;
  }
});
