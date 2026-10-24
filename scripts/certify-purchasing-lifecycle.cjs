'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const repo=path.join(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'tt-purchasing-cert-'));
// No inherited database, integration or production credentials. Bootstrap and
// server run outside the repository, so dotenv cannot load its environment.
const env={PATH:process.env.PATH,HOME:process.env.HOME,CI:'1',POS_TEST_USER:'admin',POS_TEST_PASSWORD:'Isolated-Certification!2026',POS_TEST_PIN:'864209',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:''};
let server;
async function main(){
 cp.execFileSync(process.execPath,[path.join(repo,'scripts/ci-runtime-bootstrap.js')],{cwd:dir,env,stdio:'inherit'});
 const log=fs.openSync(path.join(dir,'server.log'),'w');
 server=cp.spawn(process.execPath,['-e',`const app=require(${JSON.stringify(path.join(repo,'server.js'))});const server=app.listen(0,'127.0.0.1',()=>process.send(server.address().port));`],{cwd:dir,env:{...env,VERCEL:'1',TURSO_DATABASE_URL:'file:'+path.join(dir,'pos.db')},stdio:['ignore',log,log,'ipc']});
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Isolated server startup timed out')),30000);server.once('message',port=>{clearTimeout(timer);resolve(port)});server.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code))});});
 const config=path.join(dir,'playwright.config.cjs');fs.writeFileSync(config,`module.exports={testDir:${JSON.stringify(path.join(repo,'tests'))},testMatch:'purchasing-lifecycle.spec.js',timeout:120000,workers:1,reporter:'list'};`);
 const child=cp.spawn(process.execPath,[path.join(repo,'node_modules/@playwright/test/cli.js'),'test','--config='+config],{cwd:dir,env:{...env,POS_ISOLATED_CERTIFICATION:'1',POS_CERT_BASE_URL:'http://127.0.0.1:'+port},stdio:'inherit'});
 process.exitCode=await new Promise(resolve=>child.once('exit',code=>resolve(code??1)));
 console.log('Isolated evidence directory:',dir);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{server?.kill();});
