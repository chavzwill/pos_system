'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let failed=0;
function check(name,pass){console.log(`${pass?'PASS':'FAIL'} Stock Planning: ${name}`);if(!pass)failed++;}
const inventory=read('public/inventory-intelligence.js');
const route=read('routes/inventory-intelligence.js');
const staffFiles=[
  ['inventory workspace',inventory],
  ['Guide Me catalog',read('public/guided-mode.js')],
  ['Guide Me orchestrator',read('public/guided-mode-orchestrator.js')],
  ['Guide Me fallback',read('public/guided-mode-exact-fallback.js')],
  ['Guide Me completion',read('public/guided-mode-completion.js')],
  ['Guide Me role context',read('public/guided-mode-role-context.js')],
  ['Operations Attention Center',read('public/operations-attention-center.js')],
  ['purchasing workspace',read('public/purchasing-workspace.js')],
  ['operational reports UI',read('public/operational-reports.js')]
];
check('canonical staff name is rendered',staffFiles.some(([,text])=>text.includes('Stock Planning & Replenishment')));
for(const [name,text] of staffFiles)check(`${name} hides legacy term`,!/Inventory Intelligence/i.test(text));
check('internal API remains compatible',inventory.includes("'/api/inventory-intelligence'"));
check('internal global remains compatible',inventory.includes('TotalToolsInventoryIntelligence'));
check('recommendations state they do not change stock automatically',/never change stock automatically|do not change stock automatically/i.test(inventory));
check('workspace uses canonical title',inventory.includes('Stock Planning & Replenishment'));
for(const section of ['Needs attention','Low stock','Excess & slow-moving stock','Move between branches','What to order','Supplier choice','Stock value at risk']) check(`workspace includes ${section}`,inventory.includes(section));
check('workspace never renders raw caught error messages',!inventory.includes('renderError(e.message)')&&!inventory.includes('alert(e.message)'));
for(const key of ['low_stock','excess_slow_moving','what_to_order','supplier_choice','stock_value_at_risk']) check(`overview exposes ${key}`,route.includes(`${key}:`));
check('overview route never returns raw caught error messages',!route.includes('error: e.message'));
check('supplier choice requires report authority',route.includes("can(req.employee?.permissions, 'reports')"));
check('supplier choice explains insufficient evidence',route.includes('Not enough supplier performance history'));
check('supplier choice never auto-creates purchasing',!route.includes('INSERT INTO purchase_orders')&&!route.includes('INSERT INTO purchase_requests'));
check('workspace renders governed transfer action',inventory.includes('Create transfer'));
check('workspace renders governed purchase-request action',inventory.includes('Create purchase request'));
if(failed){console.error(`Stock Planning language contract failed: ${failed}`);process.exit(1);}
console.log('Stock Planning language contract passed.');