'use strict';
// Local-only supervisor. No credentials, seed fixtures, automatic backfill, or external jobs.
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'local-spendos.config.json'),'utf8'));
for(const key of ['posDatabase','spendDatabase','spendSource'])if(!path.isAbsolute(config[key])||!fs.existsSync(config[key]))throw new Error(`Existing absolute ${key} is required`);
for(const port of [config.posPort,config.spendPort])if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port');
Object.assign(process.env,{
 NODE_ENV:'development',POS_SKIP_DEMO_SEED:'1',POS_EMBEDDED:'1',
 TURSO_DATABASE_URL:'file:'+config.posDatabase,TURSO_AUTH_TOKEN:'',
 SPENDOS_DB:config.spendDatabase,SPENDOS_TENANT_ID:'total-tools',
 SPENDOS_INGEST_URL:`http://127.0.0.1:${config.spendPort}/v1/events`,
 SPENDOS_API_KEY:'',SPENDOS_UI_PASSWORD:'',SPENDOS_SESSION_SECRET:'',
 SPENDOS_OUTBOX_BATCH:'25',SPENDOS_OUTBOX_MAX_ATTEMPTS:'8',
});
delete process.env.VERCEL;
process.chdir(root);
const runtime=path.join(root,'local-spendos-runtime');fs.mkdirSync(runtime,{recursive:true});
async function main(){
 const mode=process.argv[2];
 if(mode==='spendos'){
  const {server}=require(path.join(config.spendSource,'src/server'));
  server.listen(config.spendPort,'127.0.0.1',()=>console.log('SpendOS local service ready'));
 }else if(mode==='pos'){
  const {ensureReady}=require('../database');await ensureReady();
  require('../server').listen(config.posPort,'127.0.0.1',()=>{console.log('POS local service ready');process.send?.('ready');});
 }else if(mode==='worker'){
  // POS completes migrations before this child is started. Avoid concurrent schema writes.
  const {claimRows,deliver}=require('./deliver-spendos-outbox');
  async function cycle(){
   try{
    const rows=await claimRows();const results=[];
    for(const row of rows)results.push(await deliver(row));
    fs.writeFileSync(path.join(runtime,'worker-status.json'),JSON.stringify({checkedAt:new Date().toISOString(),processed:results.length,results},null,2));
    if(results.length)console.log(JSON.stringify({results}));
   }catch(e){console.error('Local worker:',e.message);}
   setTimeout(cycle,5000);
  }
  await cycle();
 }else{
  // One supervisor owns all three children and stops them together.
  const children=[];
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;for(const child of children)child.kill();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  function launch(role){
   const child=spawn(process.execPath,[__filename,role],{cwd:root,env:process.env,stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
   children.push(child);
   fs.writeFileSync(path.join(runtime,'processes.json'),JSON.stringify({supervisor:process.pid,children:children.map(c=>c.pid),startedAt:new Date().toISOString()},null,2));
   child.on('error',e=>{console.error(e.message);process.exitCode=1;stop();});
   child.on('exit',(code)=>{if(!stopping){process.exitCode=code||1;stop();}});
   return child;
  }
  launch('spendos');
  launch('pos').once('message',message=>{if(message==='ready'&&!stopping)launch('worker');});
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
