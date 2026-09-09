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

const externalBase=String(process.env.POS_TEST_BASE_URL||'').trim();
if(externalBase && process.env.POS_TEST_ALLOW_MUTATIONS!=='YES'){
  console.error(`Refusing to run the full production certification against external POS_TEST_BASE_URL=${externalBase}.`);
  console.error('Several runtime suites deliberately create/update test business records. Use the local native server, or set POS_TEST_ALLOW_MUTATIONS=YES only for an isolated disposable staging database.');
  console.error('For read-only external validation use: node scripts/run-pos-readonly-certification.js');
  process.exit(3);
}

run('Static production contract',process.execPath,['scripts/check-pos-production-certification.js']);
run('Native runtime architecture contract',process.execPath,['scripts/check-native-pos-runtime.js']);
run('Branch variation inventory integrity contract',process.execPath,['scripts/check-branch-variation-integrity-contract.js']);
run('Backup and recovery contract',process.execPath,['scripts/check-production-recovery-contract.js']);
run('Startup health and cutover contract',process.execPath,['scripts/check-production-observability-contract.js']);
run('Disposable release certification contract',process.execPath,['scripts/check-disposable-release-certification-contract.js']);
run('Shared POS test target contract',process.execPath,['scripts/check-shared-test-target-contract.js']);

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
  'tests/native-responsive-shell.spec.js',
  'tests/native-all-workspaces.spec.js',
  'tests/native-workspace-visual-integrity.spec.js',
  'tests/native-fluid-responsive-sweep.spec.js',
  'tests/operations-acceptance.spec.js',
  'tests/security-boundaries.spec.js',
  'tests/multi-branch-read-integrity.spec.js',
  'tests/operation-idempotency.spec.js',
  'tests/lifecycle-concurrency.spec.js',
  'tests/business-integrity.spec.js',
  'tests/purchase-order-hardening.spec.js',
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
