'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'local-spendos.config.json'),'utf8'));
(async()=>{
 const pos=`http://127.0.0.1:${config.posPort}`,spend=`http://127.0.0.1:${config.spendPort}`;
 const statusResponse=await fetch(spend+'/v1/system/status?tenantId=total-tools',{signal:AbortSignal.timeout(5000)});
 if(!statusResponse.ok)throw new Error('SpendOS status failed');
 const status=await statusResponse.json();
 const page=await fetch(pos,{signal:AbortSignal.timeout(5000)});if(!page.ok)throw new Error('POS page failed');
 const denied=await fetch(pos+'/api/spendos-management/outbox/health',{signal:AbortSignal.timeout(5000)});
 if(denied.status!==401)throw new Error('Unauthenticated POS management was not denied');
 const db=new DatabaseSync(config.posDatabase,{readOnly:true});
 const counts={};for(const table of ['purchase_requests','purchase_orders','spendos_outbox'])counts[table]=db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;db.close();
 const worker=JSON.parse(fs.readFileSync(path.join(root,'local-spendos-runtime/worker-status.json'),'utf8'));
 if(Date.now()-Date.parse(worker.checkedAt)>20000)throw new Error('Worker heartbeat is stale');
 console.log(JSON.stringify({ok:true,pos,spend,status,counts,worker,unauthenticatedManagementStatus:denied.status},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
