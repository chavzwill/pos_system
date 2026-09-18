'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const exists=p=>fs.existsSync(path.join(root,p));
const read=p=>exists(p)?fs.readFileSync(path.join(root,p),'utf8'):'';
let failed=0;
function check(name,pass){console.log(`${pass?'PASS':'FAIL'} Predictive Lookup: ${name}`);if(!pass)failed++;}

const enginePath='lib/predictive-lookup.js';
const routePath='routes/predictive-lookup.js';
const uiPath='public/predictive-lookup.js';
const cssPath='public/predictive-lookup.css';
const engine=read(enginePath),route=read(routePath),ui=read(uiPath);
const server=read('server.js'),pkg=read('package.json'),shell=read('public/app-shell.html');

check('shared engine exists',exists(enginePath));
check('shared route exists',exists(routePath));
check('shared browser controller exists',exists(uiPath));
check('shared browser styles exist',exists(cssPath));
check('server mounts predictive lookup route',server.includes("/api/predictive-lookup")&&server.includes("./routes/predictive-lookup"));
check('full syntax wall includes predictive lookup contract',pkg.includes('check:predictive-lookup'));
check('engine supports product supplier and customer domains',/product/.test(engine)&&/supplier/.test(engine)&&/customer/.test(engine));
check('engine preserves exact identifier priority',/exact_identifier/.test(engine)&&/rank/.test(engine));
check('engine supports reviewed alias evidence only',/reviewed|approved/.test(engine)&&/alias/.test(engine));
check('engine enforces bounded results',/limit/.test(engine)&&/Math\.min/.test(engine));
check('route uses authenticated authorization',/requireAuth/.test(route)||/req\.employee/.test(route));
check('route returns stable safe failure',route.includes('PREDICTIVE_LOOKUP_UNAVAILABLE')&&!route.includes('e.message'));
check('browser uses AbortController cancellation',ui.includes('AbortController'));
check('browser suppresses stale responses',/request|sequence|token/i.test(ui));
check('browser exposes accessible combobox/listbox semantics',ui.includes('aria-autocomplete')&&ui.includes('listbox'));
check('browser handles keyboard selection',ui.includes('ArrowDown')&&ui.includes('ArrowUp')&&ui.includes('Enter')&&ui.includes('Escape'));
check('shell loads predictive lookup client',shell.includes('predictive-lookup.js')&&shell.includes('predictive-lookup.css'));
check('catalog picker consumes shared predictive lookup',read('public/catalog-picker.js').includes('TotalToolsPredictiveLookup'));
check('sales customer lookup consumes shared predictive lookup',read('public/sales-workspace.js').includes('TotalToolsPredictiveLookup'));
check('quote customer lookup consumes shared predictive lookup',read('public/catalog-workflow-enhancer.js').includes('TotalToolsPredictiveLookup'));
if(exists(enginePath)){
  try{
    const mod=require(path.join(root,enginePath));
    const rank=mod.rankCandidate;
    check('rank helper is exported',typeof rank==='function');
    if(typeof rank==='function'){
      const exact=rank({match_kind:'exact_identifier'});
      const prefix=rank({match_kind:'identifier_prefix'});
      const alias=rank({match_kind:'reviewed_alias'});
      const name=rank({match_kind:'exact_name'});
      check('exact identifier outranks prefix alias and name',exact<prefix&&prefix<alias&&alias<name);
    }
  }catch(e){check('engine module loads',false);}
}

if(failed){console.error(`Predictive Lookup contract failed: ${failed}`);process.exit(1);}
console.log('Predictive Lookup contract passed.');
