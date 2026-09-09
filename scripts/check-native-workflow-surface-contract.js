'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const exists=p=>fs.existsSync(path.join(root,p));
const fail=[];
const pass=[];
function check(name,ok,detail=''){(ok?pass:fail).push({name,detail});console.log(`${ok?'PASS':'FAIL'} Native workflow: ${name}${detail?' — '+detail:''}`);}
const loader=read('public/workspace-loader-hardening.js');
const shell=read('public/app-shell.js');
const support=read('public/shell-native-support.js');
const guide=read('public/guided-mode.js');
const role=read('public/role-operations-dashboard.js');
const auth=read('tests/auth.spec.js');
const deferred=read('public/shell-deferred.js');

function parseLoaderAssets(source){
 const start=source.indexOf('const assets={');
 const end=source.indexOf('};\nconst extras=',start);
 if(start<0||end<0)return new Map();
 const block=source.slice(start,end);
 const re=/'([^']+)'\s*:\s*\['([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\]/g;
 const out=new Map();let m;while((m=re.exec(block)))out.set(m[1],{css:m[2],js:m[3],global:m[4]});return out;
}
function parseSupportKeys(source){return [...source.matchAll(/\{key:'([^']+)',title:/g)].map(m=>m[1]);}
function parseShellKeys(source){return [...source.matchAll(/\[['"][^'\"]+['\"]\s*,['"][^'\"]*['\"]\s*,['"]([^'"]+)['"]\]/g)].map(m=>m[1]).filter(k=>k!=='legacy');}
const assets=parseLoaderAssets(loader);
check('hardened loader registry parsed',assets.size>=40,`registered=${assets.size}`);
for(const [key,a] of assets){
 check(`${key}: script exists`,exists('public'+a.js),a.js);
 check(`${key}: stylesheet exists`,exists('public'+a.css),a.css);
 if(exists('public'+a.js)){
   const js=read('public'+a.js);
   check(`${key}: registered global exists in source`,js.includes(a.global),a.global);
   check(`${key}: public open API exists`,/\bopen\b/.test(js)&&js.includes(a.global),a.global);
 }
}
for(const key of new Set(parseShellKeys(shell)))check(`primary shell card registered: ${key}`,assets.has(key));
for(const key of new Set(parseSupportKeys(support)))check(`support card registered: ${key}`,assets.has(key));
check('support cards delegate to hardened loader',support.includes('window.TotalToolsWorkspaceLoader')&&support.includes('data-open=')&&!support.includes('function loadJs(')&&!support.includes('function loadCss('));
check('support workspace failures do not use native alert',!support.includes('alert('));
check('technician manager related workspaces use hardened loader',read('public/technician-management-intelligence.js').includes('window.TotalToolsShellOpen')&&!read('public/technician-management-intelligence.js').includes('alert('));
check('workspace click path is capture protected',loader.includes("document.addEventListener('click'")&&loader.includes('e.stopImmediatePropagation()'));
check('workspace failures expose controlled recovery',loader.includes('tt-workspace-load-error')&&loader.includes('No business action has been retried automatically'));
check('workspace loads publish health state',loader.includes("state:'loading'")&&loader.includes("state:'failed'")&&loader.includes("state:'open'"));
check('asset certification is read-only HEAD',loader.includes("method:'HEAD'")&&loader.includes('cache:\'no-store\''));
check('no ignored cleanup finally remains in loader',!loader.includes("p.finally(")&&!loader.includes("cssLoading.set(href,p);\n  p.finally"));
check('authoritative Guided Mode only',deferred.includes("'/guided-mode.js'")&&!deferred.includes("'/guided-mode-orchestrator.js'")&&!deferred.includes("'/guided-mode-exact-fallback.js'"));
for(const match of guide.matchAll(/feature:'([^']+)'/g))check(`Guided Mode target registered: ${match[1]}`,assets.has(match[1]));
for(const method of ['openDispatch','openDriver','openSecurity','openAccounts'])check(`role dashboard API exposes ${method}`,role.includes(method));
check('native authentication tests target current shell',auth.includes('#shell-login')&&auth.includes('.shell-app')&&!auth.includes('#login-screen')&&!auth.includes('#login-user'));
check('authentication test covers invalid credentials',auth.includes('wrong password stays on login'));
check('authentication test covers reload persistence',auth.includes('successful login survives authenticated reload'));
check('authentication test covers logout revocation',auth.includes('logout revokes authenticated shell session'));

const riskyNativeDialogs=[];
for(const [key,a] of assets){if(!exists('public'+a.js))continue;const js=read('public'+a.js);for(const primitive of ['prompt(','confirm(','alert('])if(js.includes(primitive))riskyNativeDialogs.push(`${key}:${primitive.slice(0,-1)}`);}
if(riskyNativeDialogs.length)console.warn('WARN Native workflow: browser-native dialogs remain in registered workspace sources:',riskyNativeDialogs.join(', '));
else console.log('PASS Native workflow: registered workspace sources contain no browser-native prompt/confirm/alert calls');

console.log(`Native workflow surface certification: ${pass.length} passed, ${fail.length} failed, ${riskyNativeDialogs.length} native-dialog warning(s).`);
if(fail.length){for(const f of fail)console.error(`FAIL ${f.name}${f.detail?' — '+f.detail:''}`);process.exit(1);}
