'use strict';
const {spawnSync}=require('child_process');
const path=require('path');

const root=path.resolve(__dirname,'..');
function run(label,command,args){
  console.log(`\n=== ${label} ===`);
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit',env:process.env});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}

const base=String(process.env.POS_TEST_BASE_URL||'').trim();
if(!base){
  console.error('POS_TEST_BASE_URL is required for read-only external certification. Example: https://pos.example.com');
  process.exit(2);
}

let parsed;
try{ parsed=new URL(base); }catch(error){ console.error('POS_TEST_BASE_URL must be a valid absolute URL.'); process.exit(2); }
if(!['http:','https:'].includes(parsed.protocol)){
  console.error('POS_TEST_BASE_URL must use http or https.');
  process.exit(2);
}

run('Static native runtime contract',process.execPath,['scripts/check-native-pos-runtime.js']);
run('Startup health/cutover contract',process.execPath,['scripts/check-production-observability-contract.js']);

let playwrightCli;
try{ playwrightCli=require.resolve('@playwright/test/cli'); }
catch(error){
  console.error('Playwright is not installed in this checkout. This runner will not install packages automatically.');
  process.exit(2);
}

// These suites are intentionally limited to browser/runtime observations and do
// not perform business mutations. Authenticated production reads remain covered
// separately by scripts/production-smoke.sh.
run('Read-only browser certification',process.execPath,[playwrightCli,'test','tests/native-responsive-shell.spec.js']);
console.log(`\nRead-only POS certification completed for ${parsed.origin}. No business mutation suite was executed.`);
