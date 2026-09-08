'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const runner=fs.readFileSync(path.join(root,'scripts/run-pos-disposable-release-certification.js'),'utf8');
const focused=fs.readFileSync(path.join(root,'scripts/run-pos-disposable-certification.js'),'utf8');
const playwright=fs.readFileSync(path.join(root,'playwright.config.js'),'utf8');
const helper=fs.readFileSync(path.join(root,'tests/test-base-url.js'),'utf8');
const nativeCert=fs.readFileSync(path.join(root,'tests/native-pos-certification.spec.js'),'utf8');
const securityCert=fs.readFileSync(path.join(root,'tests/security-boundaries.spec.js'),'utf8');
const erpCert=fs.readFileSync(path.join(root,'tests/erp-intelligence.spec.js'),'utf8');
const inventoryCert=fs.readFileSync(path.join(root,'tests/inventory-intelligence.spec.js'),'utf8');
const reportsCert=fs.readFileSync(path.join(root,'tests/operational-reports.spec.js'),'utf8');
const technicianCert=fs.readFileSync(path.join(root,'tests/technician-compensation.spec.js'),'utf8');
const need=(content,needle,label)=>{if(!content.includes(needle))throw new Error(`${label} missing: ${needle}`);};
const forbid=(content,needle,label)=>{if(content.includes(needle))throw new Error(`${label} must not contain: ${needle}`);};

need(runner,"POS_TEST_BASE_URL must not be set",'external target refusal');
need(runner,"!inheritedDb.startsWith('file:')",'remote database refusal');
need(runner,"Port ${certificationPort} is already in use or unavailable",'occupied-port refusal');
need(runner,"POS_DISPOSABLE_PORT overrides are not supported",'legacy hard-coded port drift refusal');
need(runner,"Playwright is not installed",'no-install dependency failure');
need(runner,"fs.mkdtempSync",'isolated temporary state');
need(runner,"npmCommand",'cross-platform npm invocation');
need(runner,"['run', 'check:syntax']",'repository syntax gate');
need(runner,"POS_TEST_ALLOW_MUTATIONS: 'YES'",'explicit disposable mutation authority');
need(runner,"POS_BRANCH_TEST_USER: 'jdoe'",'branch-scoped runtime identity');
need(runner,"branchPermissions.multi_branch_access===true",'branch authority assertion');
need(runner,"tests/multi-branch-read-integrity.spec.js",'multi-branch read isolation runtime coverage');
need(runner,"tests/purchase-order-hardening.spec.js",'purchase order hardening runtime coverage');
need(runner,"tests/procurement-intelligence-integrity.spec.js",'procurement integrity runtime coverage');
need(runner,"tests/loss-control-integrity.spec.js",'loss control runtime coverage');
need(runner,"tests/technician-compensation.spec.js",'technician compensation runtime coverage');
need(runner,"tests/erp-intelligence.spec.js",'ERP intelligence runtime coverage');
need(runner,"tests/inventory-intelligence.spec.js",'inventory intelligence runtime coverage');
need(runner,"tests/operational-reports.spec.js",'operational reports runtime coverage');
need(runner,"tests/accounting-ledger-integrity.spec.js",'ledger runtime coverage');
need(runner,"tests/rentals-integrity.spec.js",'rental runtime coverage');
need(runner,"tests/repair-quality-integrity.spec.js",'repair runtime coverage');
need(runner,"tests/service-completion-integrity.spec.js",'service completion runtime coverage');
need(runner,"fs.rmSync(tempRoot",'temporary state cleanup');
need(focused,"Port ${certificationPort} is already in use or unavailable",'focused disposable occupied-port refusal');
need(playwright,"reuseExistingServer: disposableCertification ? false : true",'Playwright disposable server ownership');
need(playwright,"POS_DISPOSABLE_CERTIFICATION === 'YES'",'Playwright disposable mode detection');

need(helper,"POS_TEST_BASE_URL",'shared test target helper');
need(helper,"assertSafeMutationTarget",'shared mutation target guard');
for(const [label,content] of [
  ['native certification',nativeCert],
  ['security certification',securityCert],
  ['ERP intelligence certification',erpCert],
  ['inventory intelligence certification',inventoryCert],
  ['operational reports certification',reportsCert],
  ['technician compensation certification',technicianCert],
]){
  need(content,"./test-base-url.js",`${label} shared target`);
  forbid(content,"http://localhost:3001",`${label} portability`);
}
need(securityCert,"assertSafeMutationTarget",'security mutation target guard');

console.log('Disposable release certification contract passed: isolated database/server ownership, occupied-port refusal, syntax/static gates, branch isolation, financial/accounting lifecycles, shared target plumbing across core and intelligence certification suites, and cleanup are all required.');
