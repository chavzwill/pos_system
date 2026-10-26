'use strict';
const assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const bcrypt=require('bcryptjs');
const fs=require('node:fs');
const dbFile=require('node:path').join(require('node:os').tmpdir(),`return-authorization-${process.pid}.db`);
const db=createClient({url:`file:${dbFile}`});
let requestNumber=0;
require.cache[require.resolve('../database')]={exports:{db,ensureReady:async()=>{}}};
const auth=require('../routes/retail-return-authorization');
async function run(){
 await db.batch([
  'CREATE TABLE security_groups(id INTEGER PRIMARY KEY,name TEXT,permissions TEXT)',
  'CREATE TABLE employees(id INTEGER PRIMARY KEY,first_name TEXT,last_name TEXT,password TEXT,active INTEGER,security_group_id INTEGER,default_branch_id INTEGER)',
  'CREATE TABLE employee_branches(employee_id INTEGER,branch_id INTEGER)',
  'CREATE TABLE transactions(id INTEGER PRIMARY KEY,branch_id INTEGER)',
  'CREATE TABLE returns(id INTEGER PRIMARY KEY,original_transaction_id INTEGER)',
  {sql:'INSERT INTO security_groups VALUES(1,?,?)',args:['Manager',JSON.stringify({transactions:true})]},
  {sql:'INSERT INTO security_groups VALUES(2,?,?)',args:['Other',JSON.stringify({transactions:true})]},
  'INSERT INTO transactions VALUES(1,10)'
 ],'write');
 const hash=await bcrypt.hash('ValidPassword!234',4);
 for(const [id,group,branch,active] of [[1,1,10,1],[2,1,10,1],[3,2,10,1],[4,1,20,1],[5,1,10,0]])await db.execute({sql:'INSERT INTO employees VALUES(?,?,?, ?,?,?,?)',args:[id,'Staff',String(id),hash,active,group,branch]});
 await auth.ensureSchema();
 const req=(over={})=>({employee:{id:1},params:{id:'1'},body:{notes:'Customer returned damaged item',return_authorizer_id:2,return_authorizer_password:'ValidPassword!234',...over},method:'POST',ip:`127.0.0.${++requestNumber}`});
 async function authorize(r){let failure,next=false;const res={setHeader(){},status(s){this.s=s;return this},json(v){failure={status:this.s,...v}}};await auth.authorizeReturn(r,res,()=>{next=true});return {failure,next};}
 assert.equal((await authorize(req({return_authorizer_id:1}))).failure.status,403);
 assert.equal((await authorize(req({return_authorizer_id:3}))).failure.status,403);
 assert.equal((await authorize(req({return_authorizer_id:4}))).failure.status,403);
 assert.equal((await authorize(req({return_authorizer_id:5}))).failure.status,403);
 assert.equal((await authorize(req({return_authorizer_password:'wrong'}))).failure.status,403);
 assert.equal((await authorize(req({notes:'x'}))).failure.status,400);
 const apiReq=req();apiReq.apiKey={id:1};delete apiReq.employee;assert.equal((await authorize(apiReq)).failure.status,401);
 const valid=req();assert.equal((await authorize(valid)).next,true);assert.equal(valid.body.return_authorizer_password,undefined);
 let tx=await db.transaction('write');await tx.execute('INSERT INTO returns VALUES(1,1)');await auth.recordReturnAuthorization(tx,valid,1);await tx.rollback();assert.equal((await db.execute('SELECT * FROM retail_return_authorizations')).rows.length,0);
 const again=req();await authorize(again);tx=await db.transaction('write');await tx.execute('INSERT INTO returns VALUES(2,1)');await auth.recordReturnAuthorization(tx,again,2);await tx.commit();
 const row=(await db.execute('SELECT * FROM retail_return_authorizations')).rows[0];assert.equal(row.authorized_by_employee_id,2);assert.equal(row.initiated_by_employee_id,1);assert.ok(!JSON.stringify(row).includes('ValidPassword'));
 await assert.rejects(db.execute("UPDATE retail_return_authorizations SET reason='tamper'"),/immutable/i);
 await assert.rejects(db.execute('DELETE FROM retail_return_authorizations'),/immutable/i);
 const permissions=(await db.execute('SELECT permissions FROM security_groups WHERE id=2')).rows[0];assert.equal(JSON.parse(permissions.permissions).returns_authorize,undefined);
 const revoked=req();assert.equal((await authorize(revoked)).next,true);
 await db.execute({sql:'UPDATE security_groups SET permissions=? WHERE id=1',args:[JSON.stringify({returns_authorize:false})]});
 tx=await db.transaction('write');await tx.execute('INSERT INTO returns VALUES(3,1)');await assert.rejects(auth.recordReturnAuthorization(tx,revoked,3),/permission/);await tx.rollback();
 assert.equal((await db.execute('SELECT COUNT(*) n FROM retail_return_authorizations')).rows[0].n,1);
 for(let attempt=1;attempt<=9;attempt++){const limited=req({return_authorizer_password:'wrong'});limited.ip='rate-limit-fixture';const result=await authorize(limited);assert.equal(result.failure.status,attempt===9?429:403);assert.equal(limited.body.return_authorizer_password,undefined);}
 await db.execute({sql:'UPDATE security_groups SET permissions=? WHERE id=1',args:[JSON.stringify({returns_authorize:true})]});
 const express=require('express');const app=express();app.use(express.json());app.use((req,res,next)=>{req.employee={id:1,permissions:{transactions_returns:true}};next();});
 app.use('/api/transactions',auth.router);
 app.post('/api/transactions/:id/return',(req,res)=>res.json({authorized:true,passwordPresent:Object.hasOwn(req.body,'return_authorizer_password')}));
 const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
 try{
  const url=`http://127.0.0.1:${server.address().port}/api/transactions/1/return`;
  let response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:'Valid return reason'})});assert.equal(response.status,400);
  response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:'Valid return reason',return_authorizer_id:2,return_authorizer_password:'ValidPassword!234'})});assert.equal(response.status,200);assert.deepEqual(await response.json(),{authorized:true,passwordPresent:false});
 }finally{await new Promise(resolve=>server.close(resolve));}
 assert.equal(require('../lib/permissions').can({transactions:true},'returns_authorize'),false);
 db.close();fs.rmSync(dbFile,{force:true});console.log('Independent return authorization runtime passed');
}
run().catch(e=>{console.error(e);db.close();process.exitCode=1});
