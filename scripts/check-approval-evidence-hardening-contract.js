'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const lib=fs.readFileSync(path.join(root,'lib/approval-routing.js'),'utf8');
const checks=[
 ['approval events reject updates',lib.includes('trg_approval_events_no_update')],
 ['approval events reject deletes',lib.includes('trg_approval_events_no_delete')],
 ['approval requests with evidence reject deletes',lib.includes('trg_approval_requests_no_evidence_delete')],
 ['fresh approval event schema avoids cascade deletion',!/CREATE TABLE IF NOT EXISTS approval_events[\s\S]*?ON DELETE CASCADE[\s\S]*?\)/.test(lib)]
];
let failed=0;
for(const [name,ok] of checks){if(ok)console.log(`PASS Approval evidence: ${name}`);else{console.error(`FAIL Approval evidence: ${name}`);failed++;}}
if(failed)process.exit(1);
console.log(`Approval evidence hardening contract OK (${checks.length} checks).`);
