'use strict';
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const route=fs.readFileSync(path.join(root,'routes','tt-ai-read.js'),'utf8');
const tools=fs.readFileSync(path.join(root,'lib','tt-ai-read-tools.js'),'utf8');
const client=fs.readFileSync(path.join(root,'lib','tt-ai-client.js'),'utf8');
const signer=fs.readFileSync(path.join(root,'lib','tt-ai-assertion.js'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

const postRoutes=[...route.matchAll(/router\.post\(\s*['"]([^'"]+)['"]/g)].map(m=>m[1]);
const checks=[
  ['TT AI route is mounted',server.includes("app.use('/api/tt-ai', require('./routes/tt-ai-read'))")],
  ['machine API keys cannot impersonate staff',route.includes('TT_AI_STAFF_SESSION_REQUIRED')&&route.includes('if (req.apiKey)')],
  ['query is the only POST surface',postRoutes.length===1&&postRoutes[0]==='/query'],
  ['gateway exposes no PATCH write route',!route.includes('router.patch(')],
  ['gateway exposes no PUT write route',!route.includes('router.put(')],
  ['gateway exposes no DELETE write route',!route.includes('router.delete(')],
  ['read-tool module performs no SQL mutation',!/\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(tools.replace(/CREATE TABLE IF NOT EXISTS/g,''))],
  ['cross-branch reads require existing authority',tools.includes("multi_branch_access")&&tools.includes('TT_AI_BRANCH_FORBIDDEN')],
  ['product reads are branch scoped',tools.includes('LEFT JOIN branch_inventory bi ON bi.product_id=p.id AND bi.branch_id=?')],
  ['cost visibility is permission gated',tools.includes("can(employee?.permissions, 'purchasing')")&&tools.includes("can(employee?.permissions, 'reports_financial')")],
  ['rental asset registry is capability guarded',tools.includes("tableExists('rental_assets')")&&tools.includes("tableExists('inventory_serials')")],
  ['exact assets can be searched by serial or asset number',tools.includes('a.asset_number LIKE ?')&&tools.includes('s.serial_number LIKE ?')],
  ['asset reads remain branch scoped',tools.includes('WHERE a.branch_id=? AND (CAST(a.id AS TEXT)=? OR a.asset_number=? OR s.serial_number=?)')],
  ['maintenance cost is redacted without financial authority',tools.includes('const { direct_cost, ...safe } = item')],
  ['AI plan is capped before execution',client.includes('MAX_PLAN_STEPS')&&client.includes('TT_AI_PLAN_TOO_LARGE')],
  ['AI may request only POS evidence in this slice',client.includes("step.source !== 'pos'")&&client.includes('TT_AI_SOURCE_NOT_ALLOWED')],
  ['assertion stays server-side',client.includes('createTTAIStaffAssertion')&&!route.includes('signed.token')],
  ['POS owns asymmetric signing key and no shared secret remains',signer.includes('process.env.TT_AI_SIGNING_PRIVATE_KEY')&&!signer.includes('TT_AI_SHARED_SECRET')&&!client.includes('TT_AI_SHARED_SECRET')],
];

const failed=checks.filter(([,ok])=>!ok);
for(const [label,ok] of checks)console.log(`${ok?'PASS':'FAIL'} - ${label}`);
if(failed.length){
  console.error(`TT AI read contract failed: ${failed.length} check(s)`);
  process.exit(1);
}
console.log(`TT AI read contract passed: ${checks.length}/${checks.length}`);
