'use strict';
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const route=fs.readFileSync(path.join(root,'routes','tt-ai-read.js'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

const checks=[
  ['TT AI route is mounted',server.includes("app.use('/api/tt-ai', require('./routes/tt-ai-read'))")],
  ['machine API keys cannot impersonate staff',route.includes('TT_AI_STAFF_SESSION_REQUIRED')&&route.includes('if (req.apiKey)')],
  ['cross-branch reads require existing authority',route.includes("multi_branch_access")&&route.includes('TT_AI_BRANCH_FORBIDDEN')],
  ['gateway exposes no POST write route',!route.includes('router.post(')],
  ['gateway exposes no PATCH write route',!route.includes('router.patch(')],
  ['gateway exposes no PUT write route',!route.includes('router.put(')],
  ['gateway exposes no DELETE write route',!route.includes('router.delete(')],
  ['product reads are branch scoped',route.includes('LEFT JOIN branch_inventory bi ON bi.product_id=p.id AND bi.branch_id=?')],
  ['cost visibility is permission gated',route.includes("can(req.employee?.permissions, 'purchasing')")&&route.includes("can(req.employee?.permissions, 'reports_financial')")],
  ['rental asset registry is capability guarded',route.includes("tableExists('rental_assets')")&&route.includes("tableExists('inventory_serials')")],
  ['exact assets can be searched by serial or asset number',route.includes('a.asset_number LIKE ?')&&route.includes('s.serial_number LIKE ?')],
  ['asset reads remain branch scoped',route.includes('WHERE a.branch_id=? AND (CAST(a.id AS TEXT)=? OR a.asset_number=? OR s.serial_number=?)')],
  ['maintenance cost is redacted without financial authority',route.includes('const { direct_cost, ...safe } = item')],
];

const failed=checks.filter(([,ok])=>!ok);
for(const [label,ok] of checks)console.log(`${ok?'PASS':'FAIL'} - ${label}`);
if(failed.length){
  console.error(`TT AI read contract failed: ${failed.length} check(s)`);
  process.exit(1);
}
console.log(`TT AI read contract passed: ${checks.length}/${checks.length}`);
