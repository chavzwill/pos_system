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

run('Static production contract',process.execPath,['scripts/check-pos-production-certification.js']);
run('Native runtime architecture contract',process.execPath,['scripts/check-native-pos-runtime.js']);
run('Backup and recovery contract',process.execPath,['scripts/check-production-recovery-contract.js']);

if(process.env.POS_RECOVERY_REHEARSAL_ARCHIVE){
  run('Non-destructive recovery rehearsal','bash',['scripts/production-recovery-rehearsal.sh',process.env.POS_RECOVERY_REHEARSAL_ARCHIVE]);
}else{
  console.log('\nRecovery rehearsal archive not supplied; static recovery contract passed, but backup restore rehearsal is not being claimed. Set POS_RECOVERY_REHEARSAL_ARCHIVE to a verified production-style backup to exercise it.');
}

let playwrightCli;
try{
  playwrightCli=require.resolve('@playwright/test/cli');
}catch(error){
  console.error('Playwright is not installed in this checkout. This runner will not install packages automatically. Run the repository-approved dependency setup first, then retry.');
  process.exit(2);
}

const suites=[
  'tests/native-pos-certification.spec.js',
  'tests/operations-acceptance.spec.js',
  'tests/security-boundaries.spec.js',
  'tests/multi-branch-read-integrity.spec.js',
  'tests/operation-idempotency.spec.js',
  'tests/lifecycle-concurrency.spec.js',
  'tests/business-integrity.spec.js',
  'tests/pos-financial-runtime.js',
  'tests/accounting-ledger-integrity.spec.js',
  'tests/accounting-source-sync-rbac.spec.js',
  'tests/logistics-intelligence.spec.js',
  'tests/rentals-integrity.spec.js',
  'tests/repair-quality-integrity.spec.js',
  'tests/service-completion-integrity.spec.js',
];
run('Runtime production certification',process.execPath,[playwrightCli,'test',...suites]);
console.log('\nPOS production certification completed successfully.');
