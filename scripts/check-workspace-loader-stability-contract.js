'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const fail=m=>{console.error(`Workspace loader stability contract failed: ${m}`);process.exitCode=1;};
const loader=read('public/workspace-loader-hardening.js');
const shell=read('public/app-shell.js');
const nativeShell=read('public/native-pos-shell.js');
const css=read('public/native-pos-stability.css');

if(/\.finally\(\(\)=>loading\.delete/.test(loader))fail('loader must not create an ignored rejecting Promise.finally chain');
if(!loader.includes("p.then(()=>loading.delete(key),()=>loading.delete(key))"))fail('script loader must settle its loading registry without rejection leakage');
if(!loader.includes("p.then(()=>cssLoading.delete(href),()=>cssLoading.delete(href))"))fail('stylesheet loader must settle its loading registry without rejection leakage');
if(!loader.includes('async function certify()'))fail('runtime workspace asset certification is missing');
if(!loader.includes("method:'HEAD'"))fail('runtime asset certification must be non-mutating');
if(!nativeShell.includes("title:'Workspace health'"))fail('Workspace health must be reachable from the command palette');
if(!nativeShell.includes('loader.certify()'))fail('Workspace health must invoke the hardened loader certification');
if(!css.includes('.tt-workspace-health'))fail('Workspace health needs responsive recovery UI styling');

function registry(source){
 const start=source.indexOf('const assets={');if(start<0)return null;
 const end=source.indexOf('};',start);if(end<0)return null;
 const block=source.slice(start+'const assets='.length,end+1);
 try{return vm.runInNewContext('('+block+')');}catch(e){fail(`unable to parse workspace registry: ${e.message}`);return null;}
}
const a=registry(loader),b=registry(shell);
if(a&&b){
 const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();
 if(JSON.stringify(ak)!==JSON.stringify(bk))fail('hardened loader and app-shell workspace registries are out of sync');
 for(const key of ak){if(JSON.stringify(a[key])!==JSON.stringify(b[key]))fail(`workspace mapping differs for ${key}`);for(const asset of a[key].slice(0,2)){const local=path.join(root,'public',asset.replace(/^\//,''));if(!fs.existsSync(local))fail(`registered workspace asset missing: ${asset}`);}}
}
if(!process.exitCode)console.log('Workspace loader stability contract passed: registries match, assets exist, runtime health is available, and rejected loads cannot leak through ignored finally chains.');
