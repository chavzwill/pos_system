'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const roots=['public','docs','tests','scripts'];
const extensions=new Set(['.js','.mjs','.cjs','.html','.css','.md','.json','.txt']);
const legacy=[['Guided','Mode'].join(' '),['Guided','Help'].join(' '),['guided','mode'].join(' '),['Guided','mode'].join(' ')];
const violations=[];
function walk(dir){
  if(!fs.existsSync(dir))return;
  for(const entry of fs.readdirSync(dir)){
    const file=path.join(dir,entry);
    const stat=fs.statSync(file);
    if(stat.isDirectory()){walk(file);continue;}
    if(!extensions.has(path.extname(file)))continue;
    if(path.resolve(file)===path.resolve(__filename))continue;
    const text=fs.readFileSync(file,'utf8');
    for(const term of legacy){
      if(text.includes(term))violations.push({file:path.relative(root,file),term});
    }
  }
}
roots.forEach(dir=>walk(path.join(root,dir)));
if(violations.length){
  console.error('Guide Me brand contract failed. Legacy user-facing terminology remains:');
  for(const v of violations)console.error(`- ${v.file}: ${v.term}`);
  process.exit(1);
}
console.log('Guide Me brand contract OK: no legacy user-facing name remains in product, docs, tests or scripts.');
