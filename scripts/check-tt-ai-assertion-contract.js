'use strict';
const crypto=require('crypto');
const Module=require('module');

const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
  if(request==='./permissions'&&String(parent?.filename||'').endsWith('tt-ai-assertion.js')){
    return {can:(permissions,key)=>Boolean(permissions?.[key])};
  }
  return originalLoad.call(this,request,parent,isMain);
};
const {createTTAIStaffAssertion,TT_AI_ASSERTION_CONTRACT}=require('../lib/tt-ai-assertion');
Module._load=originalLoad;

const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
const privatePem=privateKey.export({type:'pkcs8',format:'pem'});
const publicPem=publicKey.export({type:'spki',format:'pem'});
const now=1800000000000;
const employee={id:42,default_branch_id:2,permissions:{inventory:true,rentals:true,security_manage:true}};
const result=createTTAIStaffAssertion({employee,requestId:'req-1',privateKey:privatePem,now});
const [version,payload,signature]=result.token.split('.');
const verified=crypto.verify(null,Buffer.from(`${version}.${payload}`,'utf8'),publicPem,Buffer.from(signature,'base64url'));
const claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
const checks=[
  ['v2 contract',TT_AI_ASSERTION_CONTRACT.version==='v2'],
  ['Ed25519 contract',TT_AI_ASSERTION_CONTRACT.algorithm==='Ed25519'],
  ['signature verifies with public key',verified],
  ['employee identity preserved',claims.sub==='42'&&claims.branch_id==='2'],
  ['allowed capabilities preserved',claims.permissions.includes('inventory')&&claims.permissions.includes('rentals')],
  ['unapproved capability excluded',!claims.permissions.includes('security_manage')],
  ['nonce present',typeof claims.nonce==='string'&&claims.nonce.length>10],
  ['short lifetime',claims.exp-claims.iat<=120],
];
for(const [label,ok] of checks)console.log(`${ok?'PASS':'FAIL'} - ${label}`);
if(checks.some(([,ok])=>!ok))process.exit(1);
console.log(`TT AI assertion contract passed: ${checks.length}/${checks.length}`);
