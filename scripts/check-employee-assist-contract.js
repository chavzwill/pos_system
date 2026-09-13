'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const route=fs.readFileSync(path.join(root,'routes','employee-assist.js'),'utf8');
const db=fs.readFileSync(path.join(root,'database.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'public','employee-assist-ui.js'),'utf8');
let fail=0;function check(name,ok){console.log(`${ok?'PASS':'FAIL'} Employee assist: ${name}`);if(!ok)fail++;}
check('global search requires authentication',route.includes('router.use(requireAuth)'));
check('search is permission-aware',route.includes("allowed(req,['customers'")&&route.includes("allowed(req,['inventory'"));
check('operational record search is branch scoped',route.includes("(? IS NULL OR branch_id=?)"));
check('shift handovers are durable',db.includes('CREATE TABLE IF NOT EXISTS shift_handovers'));
check('handover preserves author and branch',db.includes('created_by INTEGER NOT NULL')&&db.includes('branch_id INTEGER REFERENCES branches(id)'));
check('handover has acknowledge and resolve lifecycle',route.includes("/handovers/:id/acknowledge")&&route.includes("/handovers/:id/resolve"));
check('handover cannot resolve another branch record',route.includes("AND (? IS NULL OR branch_id=?)"));
check('employee UI exposes universal search',ui.includes('Find anything')&&ui.includes('/api/employee-assist/search'));
check('employee UI exposes shift handover',ui.includes('Shift handover')&&ui.includes('/api/employee-assist/handovers'));
check('keyboard search shortcut is available',ui.includes("e.key.toLowerCase()==='k'"));
if(fail)process.exit(1);console.log('Employee assist contract OK (10 checks).');
