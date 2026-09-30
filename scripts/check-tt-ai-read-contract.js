'use strict';
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const route=fs.readFileSync(path.join(root,'routes','tt-ai-read.js'),'utf8');
const tools=fs.readFileSync(path.join(root,'lib','tt-ai-read-tools.js'),'utf8');
const client=fs.readFileSync(path.join(root,'lib','tt-ai-client.js'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

const checks=[
  ['TT AI route is mounted',server.includes("app.use('/api/tt-ai', require('./routes/tt-ai-read'))")],
  ['machine API keys cannot impersonate staff',route.includes('TT_AI_STAFF_SESSION_REQUIRED')&&route.includes('if (req.apiKey)')],
  ['query POST is conversation-only',route.includes("router.post('/query'")&&!route.includes('router.patch(')&&!route.includes('router.put(')&&!route.includes('router.delete(')],
  ['query availability uses v2 private key',route.includes('TT_AI_SIGNING_PRIVATE_KEY')&&!route.includes('TT_AI_SHARED_SECRET')],
  ['cross-branch reads require existing authority',tools.includes("multi_branch_access")&&tools.includes('TT_AI_BRANCH_FORBIDDEN')],
  ['read tool module contains no SQL mutations',!/(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)/i.test(tools)],
  ['product reads are branch scoped',tools.includes('LEFT JOIN branch_inventory bi ON bi.product_id=p.id AND bi.branch_id=?')],
  ['cost visibility is permission gated',tools.includes("can(employee?.permissions, 'purchasing')")&&tools.includes("can(employee?.permissions, 'reports_financial')")],
  ['rental asset registry is capability guarded',tools.includes("tableExists('rental_assets')")&&tools.includes("tableExists('inventory_serials')")],
  ['exact assets can be searched by serial or asset number',tools.includes('a.asset_number LIKE ?')&&tools.includes('s.serial_number LIKE ?')],
  ['asset reads remain branch scoped',tools.includes('WHERE a.branch_id=? AND (CAST(a.id AS TEXT)=? OR a.asset_number=? OR s.serial_number=?)')],
  ['maintenance cost is redacted without financial authority',tools.includes('const { direct_cost, ...safe } = item')],
  ['AI plans are capped',client.includes('MAX_PLAN_STEPS = 3')&&client.includes('TT_AI_PLAN_TOO_LARGE')],
  ['AI may request only POS evidence from this proxy',client.includes("step.source !== 'pos'")&&client.includes('TT_AI_SOURCE_NOT_ALLOWED')],
  ['POS evidence execution uses explicit read-tool allowlist',client.includes('executeTTAIReadTool')&&tools.includes('TT_AI_TOOL_NOT_ALLOWED')],
  ['proxy uses Ed25519 private key and no shared secret',client.includes('TT_AI_SIGNING_PRIVATE_KEY')&&!client.includes('TT_AI_SHARED_SECRET')],
  ['each service call mints a fresh assertion',client.includes('const staffToken = () => createTTAIStaffAssertion')&&client.match(/staffToken\(\)/g)?.length>=2],
];

const failed=checks.filter(([,ok])=>!ok);
for(const [label,ok] of checks)console.log(`${ok?'PASS':'FAIL'} - ${label}`);
if(failed.length){
  console.error(`TT AI read/proxy contract failed: ${failed.length} check(s)`);
  process.exit(1);
}
console.log(`TT AI read/proxy contract passed: ${checks.length}/${checks.length}`);
