'use strict';
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const dir='docs/ui-design/evidence', control='docs/ui-design/commands.json';
const branch='redesign/total-tools-frontend', repo='chavzwill/pos_system';
fs.mkdirSync(dir,{recursive:true});
const seen=new Set(), started=Date.now();
const run=(bin,args,options={})=>{
 const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer:20*1024*1024,...options});
 if(r.error)throw r.error;
 return r;
};
function git(args){const r=run('git',args);if(r.status)throw Error(r.stderr);return r.stdout.trim();}
git(['config','user.name','Total Tools Design CI']);git(['config','user.email','design-ci@users.noreply.github.com']);
function publish(id,output,status){
 git(['pull','--ff-only','origin',branch]);
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,id+'.txt'),output);
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({command:id,status,updatedAt:new Date().toISOString()},null,2));
 // Publish only generated image/HTML/CSS assets, never CLI auth or configuration files.
 for(const match of output.matchAll(/"runDir"\s*:\s*"([^"]+)"/g)){
  const source=match[1];
  if(!fs.existsSync(source))continue;
  fs.writeFileSync(path.join(dir,id+'-run-directory.txt'),source);
  const walk=(folder)=>{
   for(const ent of fs.readdirSync(folder,{withFileTypes:true})){
    const src=path.join(folder,ent.name);
    if(ent.isDirectory()){if(!ent.name.startsWith('.'))walk(src);continue;}
    if(!/\.(png|webp|html|css)$/i.test(ent.name))continue;
    const dst=path.join(dir,id+'-assets',path.relative(source,src));
    fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);
   }
  };walk(source);
 }
 git(['add',dir]);if(!git(['diff','--cached','--name-only']))return;
 git(['commit','-m','docs(ui): publish cloud design evidence '+id+' [skip ci]']);
 git(['push','origin','HEAD:'+branch]);
}
while(Date.now()-started<50*60*1000){
 git(['pull','--ff-only','origin',branch]);
 const commands=JSON.parse(fs.readFileSync(control,'utf8'));
 for(const c of commands){
  if(seen.has(c.id))continue;
  if(!/^[a-z0-9-]+$/.test(c.id)||!Array.isArray(c.args)||!c.args.every(x=>typeof x==='string'))throw Error('Invalid design command');
  if(!['--help','draft','next','branch','convert','improve','workspace'].includes(c.args[0]))throw Error('Unsupported design operation');
  seen.add(c.id);
  const r=run('12ui',c.args,{timeout:20*60*1000});
  const output=(r.stdout||'')+'\n'+(r.stderr||'');
  publish(c.id,output,r.status);
  console.log('Design command '+c.id+' finished with status '+r.status);
 }
 // The cloud session remains alive for inspection, selection and collection.
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
}
