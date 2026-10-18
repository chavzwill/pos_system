'use strict';
const fs=require('fs'),path=require('path'),{spawn,spawnSync}=require('child_process');
const repo='chavzwill/pos_system', evidenceBranch='evidence/total-tools-ui', sourceSha=process.env.GITHUB_SHA;
let authenticated=false;
function run(bin,args,options={}){const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer:30*1024*1024,...options});if(r.error)throw r.error;return r;}
function gh(args){const r=run('gh',args);if(r.status)throw Error('GitHub operation failed: '+r.stderr.slice(0,500));return r.stdout.trim();}
function status(data){const p='docs/ui-review/12ui-review-status.json',endpoint='repos/'+repo+'/contents/'+p;let sha='';try{sha=gh(['api',endpoint+'?ref='+encodeURIComponent(evidenceBranch),'--jq','.sha']);}catch(_){}
const args=['api','--method','PUT',endpoint,'-f','branch='+evidenceBranch,'-f','message=docs(ui): update cloud design review status [skip ci]','-f','content='+Buffer.from(JSON.stringify({...data,sourceSha,updatedAt:new Date().toISOString()},null,2)).toString('base64')];if(sha)args.push('-f','sha='+sha);gh(args);}
async function authenticate(){
 status({state:'starting_authentication'});
 await new Promise((resolve,reject)=>{
  const child=spawn('12ui',['auth','login','--key-name','Total Tools UI alignment'],{stdio:['ignore','pipe','pipe']});let buffer='',published=false;
  const consume=data=>{buffer+=data.toString();const clean=buffer.replace(/\x1b\[[0-9;]*m/g,'').replaceAll('\\/','/');const uri=clean.match(/https:\/\/[^\s"<>]+/);if(uri&&!published){published=true;status({state:'awaiting_authentication',verificationUrl:uri[0]});console.log('Cloud authentication link published to the evidence branch.');}};
  const diagnostic=setTimeout(()=>{if(!published)status({state:'authentication_waiting',outputBytes:buffer.length,mentionsCode:/code/i.test(buffer),mentionsAuthorize:/authorize/i.test(buffer),publicPrompt:buffer.replace(/(?:sk-|12ui_|tui_|eyJ)[A-Za-z0-9._-]+/g,'[redacted]').slice(0,500)});},30000);
  child.stdout.on('data',consume);child.stderr.on('data',consume);
  child.on('error',reject);child.on('close',code=>{clearTimeout(diagnostic);code===0?resolve():reject(Error('Cloud design sign-in did not finish.'))});
 });
 status({state:'authenticated_waiting_for_ui_checks'});
}
async function main(){
 let workflow;
 for(let attempt=0;attempt<80;attempt++){
  const rows=JSON.parse(gh(['run','list','--repo',repo,'--branch','redesign/total-tools-frontend','--limit','20','--json','databaseId,headSha,name,status,conclusion']));
  workflow=rows.find(r=>r.headSha===sourceSha&&r.name==='Frontend Redesign Evidence');
  if(workflow?.status==='completed')break;
  await new Promise(resolve=>setTimeout(resolve,10000));
 }
 if(!workflow||workflow.status!=='completed'||workflow.conclusion!=='success')throw Error('Exact-head UI evidence must pass before visual alignment review.');
 gh(['run','download',String(workflow.databaseId),'--repo',repo,'--name','frontend-redesign-evidence-'+sourceSha,'--dir','/tmp/tt-final-ui-source']);
 const input='/tmp/tt-final-ui-source/test-results/frontend-experience/point-of-sale-1440.png';
 if(!fs.existsSync(input))throw Error('Rendered sales evidence was not found.');
 await authenticate();authenticated=true;
 status({state:'reviewing_rendered_implementation',uiRun:workflow.databaseId});
 const out='/tmp/tt-12ui-final-review';
 const args=['improve',input,'--scope','page','--target','docs/ui-design/selected-reference.png','--repo',process.cwd(),'--direction','Review this actual populated Total Tools POS implementation against the selected reference. Retain the established Total Tools green and yellow, neutral navigation, transaction table and focused checkout. Refine spacing and information hierarchy; preserve real business actions and data. No generic dashboard, no old green sidebar.','--candidates','2','--to','draft','--out-dir',out];
 const result=run('12ui',args,{timeout:18*60*1000});
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'review-command.txt'),(result.stdout||'')+'\n'+(result.stderr||''));
 if(result.status!==0)throw Error('12ui visual review did not complete; output retained in the ephemeral runner.');
 const next=run('12ui',['next',out,'--wait','--json'],{timeout:10*60*1000});fs.writeFileSync(path.join(out,'review-result.json'),next.stdout||'');
 if(next.status!==0)throw Error('12ui visual review images were not ready.');
 gh(['api','repos/'+repo+'/git/ref/heads/'+evidenceBranch,'--jq','.object.sha']);
 let r=run('git',['fetch','origin',evidenceBranch]);if(r.status)throw Error('Evidence fetch failed.');
 r=run('git',['worktree','add','--detach','/tmp/tt-final-design-evidence','origin/'+evidenceBranch]);if(r.status)throw Error('Evidence worktree failed.');
 const dst='/tmp/tt-final-design-evidence/docs/ui-review/'+sourceSha.slice(0,7)+'/12ui-alignment';fs.mkdirSync(dst,{recursive:true});
 const walk=dir=>{for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const src=path.join(dir,ent.name);if(ent.isDirectory()){if(!ent.name.startsWith('.'))walk(src);continue;}if(!/\.(png|webp|html|css)$/.test(ent.name))continue;const target=path.join(dst,path.relative(out,src));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(src,target);}};walk(out);
 const images=[];const scan=dir=>{for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isDirectory())scan(p);else if(/\.(png|webp)$/.test(p))images.push(p);}};scan(out);
 const transport=path.join(dst,'image-transport');fs.mkdirSync(transport,{recursive:true});const index=[];
 for(const [n,p]of images.slice(0,8).entries()){const data=fs.readFileSync(p).toString('base64'),parts=[];for(let i=0;i<data.length;i+=100000){const name='image-'+n+'-'+Math.floor(i/100000)+'.txt';fs.writeFileSync(path.join(transport,name),data.slice(i,i+100000));parts.push(name);}index.push({source:path.relative(out,p),mime:p.endsWith('.webp')?'image/webp':'image/png',parts});}fs.writeFileSync(path.join(transport,'index.json'),JSON.stringify(index,null,2));
 fs.copyFileSync(path.join(out,'review-command.txt'),path.join(dst,'review-command.txt'));fs.copyFileSync(path.join(out,'review-result.json'),path.join(dst,'review-result.json'));
 const git=args=>{const r=run('git',args,{cwd:'/tmp/tt-final-design-evidence'});if(r.status)throw Error('Evidence publication failed: '+r.stderr.slice(0,400));};
 git(['config','user.name','Total Tools Design Review']);git(['config','user.email','design-review@users.noreply.github.com']);git(['add','docs/ui-review']);git(['commit','-m','docs(ui): retain implementation alignment review [skip ci]']);git(['push','origin','HEAD:'+evidenceBranch]);
 status({state:'review_ready',uiRun:workflow.databaseId,evidencePath:'docs/ui-review/'+sourceSha.slice(0,7)+'/12ui-alignment'});
}

function publishText(file,text){
 const endpoint='repos/'+repo+'/contents/'+file;let sha='';try{sha=gh(['api',endpoint+'?ref='+encodeURIComponent(evidenceBranch),'--jq','.sha']);}catch(_){}
 const safe=String(text).replace(/((?:api[_-]?key|access[_-]?token|authorization|password|client[_-]?secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,'$1[redacted]').replace(/([?&](?:token|api_key|key)=)[^&\s]+/gi,'$1[redacted]');
 const args=['api','--method','PUT',endpoint,'-f','branch='+evidenceBranch,'-f','message=docs(ui): retain review diagnostics [skip ci]','-f','content='+Buffer.from(safe.slice(0,500000)).toString('base64')];if(sha)args.push('-f','sha='+sha);gh(args);
}
function collectReview(out,id){
 if(!fs.existsSync(out))return;
 const dest='/tmp/tt-review-evidence-'+Date.now();
 let r=run('git',['fetch','origin',evidenceBranch]);if(r.status)throw Error('Evidence fetch failed.');
 r=run('git',['worktree','add','--detach',dest,'origin/'+evidenceBranch]);if(r.status)throw Error('Evidence checkout failed.');
 const base=path.join(dest,'docs/ui-review/'+sourceSha.slice(0,7)+'/12ui-alignment/'+id);fs.mkdirSync(base,{recursive:true});
 const images=[];
 function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const src=path.join(dir,ent.name);if(ent.isDirectory()){if(!ent.name.startsWith('.'))walk(src);continue;}if(!/\.(png|webp|html|css)$/.test(src))continue;const target=path.join(base,path.relative(out,src));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(src,target);if(/\.(png|webp)$/.test(src))images.push(src);}}walk(out);
 const transport=path.join(base,'image-transport');fs.mkdirSync(transport,{recursive:true});const index=[];
 for(const [n,p]of images.slice(0,12).entries()){const data=fs.readFileSync(p).toString('base64'),parts=[];for(let j=0;j<data.length;j+=100000){const name='image-'+n+'-'+Math.floor(j/100000)+'.txt';fs.writeFileSync(path.join(transport,name),data.slice(j,j+100000));parts.push(name);}index.push({source:path.relative(out,p),mime:p.endsWith('.webp')?'image/webp':'image/png',parts});}
 fs.writeFileSync(path.join(transport,'index.json'),JSON.stringify(index,null,2));
 const git=args=>{const q=run('git',args,{cwd:dest});if(q.status)throw Error('Evidence publication failed.');};
 git(['config','user.name','Total Tools Design Review']);git(['config','user.email','design-review@users.noreply.github.com']);git(['add','docs/ui-review']);git(['commit','-m','docs(ui): retain review assets '+id+' [skip ci]']);git(['push','origin','HEAD:'+evidenceBranch]);
}
main().catch(async e=>{
 const prefix='docs/ui-review/'+sourceSha.slice(0,7)+'/12ui-alignment';
 const log='/tmp/tt-12ui-final-review/review-command.txt';
 if(fs.existsSync(log))publishText(prefix+'/initial-command.txt',fs.readFileSync(log,'utf8'));
 status({state:'review_needs_retry',reason:e.message,authenticated,diagnostics:prefix+'/initial-command.txt'});
 if(!authenticated){console.error(e.message);process.exitCode=1;return;}
 const seen=new Set(),started=Date.now();
 while(Date.now()-started<40*60*1000){
  let commands=[];try{commands=JSON.parse(gh(['api','repos/'+repo+'/contents/docs/ui-review/12ui-retry-commands.json?ref='+encodeURIComponent(evidenceBranch),'--jq','.content']).replace(/\n/g,''));}catch(_){
   try{const content=gh(['api','repos/'+repo+'/contents/docs/ui-review/12ui-retry-commands.json?ref='+encodeURIComponent(evidenceBranch),'--jq','.content']);commands=JSON.parse(Buffer.from(content.replace(/\n/g,''),'base64').toString());}catch(_){}
  }
  for(const c of commands){
   if(seen.has(c.id))continue;
   if(!/^[a-z0-9-]+$/.test(c.id)||!Array.isArray(c.args)||!c.args.every(a=>typeof a==='string')||!['improve','next','--help'].includes(c.args[0])||c.args.some(a=>['--apply','--api-key','--origin','--login-origin'].includes(a)))throw Error('Invalid review retry command.');
   seen.add(c.id);status({state:'review_retry_running',command:c.id,authenticated:true});
   const result=run('12ui',c.args,{timeout:20*60*1000});
   const output=(result.stdout||'')+'\n'+(result.stderr||'');publishText(prefix+'/'+c.id+'.txt',output);
   const pos=c.args.indexOf('--out-dir');const out=pos>=0?c.args[pos+1]:(c.args[0]==='next'?c.args[1]:null);
   if(out&&out.startsWith('/tmp/'))collectReview(out,c.id);
   status({state:'review_retry_complete',command:c.id,exitCode:result.status,authenticated:true,output:prefix+'/'+c.id+'.txt'});
  }
  await new Promise(resolve=>setTimeout(resolve,10000));
 }
 status({state:'review_session_ended',authenticated:false});
});
