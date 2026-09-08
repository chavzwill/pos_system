'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const runner=fs.readFileSync(path.join(root,'scripts/run-pos-disposable-release-certification.js'),'utf8');
const focused=fs.readFileSync(path.join(root,'scripts/run-pos-disposable-certification.js'),'utf8');
const portHelper=fs.readFileSync(path.join(root,'scripts/disposable-certification-port.js'),'utf8');
const playwright=fs.readFileSync(path.join(root,'playwright.config.js'),'utf8');
const sharedTarget=fs.readFileSync(path.join(root,'scripts/check-shared-test-target-contract.js'),'utf8');
const activeTargetAudit=fs.readFileSync(path.join(root,'scripts/check-active-certification-targets.js'),'utf8');
const need=(content,needle,label)=>{if(!content.includes(needle))throw new Error(`${label} missing: ${needle}`);};
const forbid=(content,needle,label)=>{if(content.includes(needle))throw new Error(`${label} must not contain: ${needle}`);};

need(runner,"POS_TEST_BASE_URL must not be set",'external target refusal');
need(runner,"!inheritedDb.startsWith('file:')",'remote database refusal');
need(runner,"selectFreePort",'dynamic release port selection');
need(runner,"POS_TEST_BASE_URL: certificationBaseURL",'release shared target injection');
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
forbid(runner,"const certificationPort = '3001'",'release fixed port');
forbid(runner,"POS_DISPOSABLE_PORT overrides are not supported",'release arbitrary-port refusal');

need(focused,"selectFreePort",'focused dynamic port selection');
need(focused,"POS_TEST_BASE_URL: certificationBaseURL",'focused shared target injection');
forbid(focused,"const certificationPort = '3001'",'focused fixed port');
forbid(focused,"POS_DISPOSABLE_PORT overrides are not supported",'focused arbitrary-port refusal');

need(portHelper,"server.listen(0,'127.0.0.1'",'OS-assigned free port selection');
need(portHelper,"probePort",'selected-port availability verification');
need(portHelper,"validatePort",'requested-port validation');

need(playwright,"POS_DISPOSABLE_CERTIFICATION === 'YES'",'Playwright disposable mode detection');
need(playwright,"Boolean(process.env.POS_TEST_BASE_URL) && !disposableCertification",'disposable local target ownership');
need(playwright,"reuseExistingServer: disposableCertification ? false : true",'Playwright disposable server ownership');

need(sharedTarget,"check-active-certification-targets",'shared target graph audit integration');
need(activeTargetAudit,"fixedTargetPattern",'active fixed-target detection');
need(activeTargetAudit,"run-pos-disposable-release-certification.js",'release runner graph discovery');
need(activeTargetAudit,"run-pos-disposable-certification.js",'focused runner graph discovery');
need(activeTargetAudit,"repair-financial-runtime-helper.migrated.js",'migrated repair helper enforcement');

console.log('Disposable release certification contract passed: isolated database ownership, dynamic loopback server ownership, no-reuse Playwright startup, active target graph auditing, branch isolation, financial/accounting lifecycle coverage, and cleanup are all required.');
