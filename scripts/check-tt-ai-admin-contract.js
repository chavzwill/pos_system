'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const route=fs.readFileSync(path.join(root,'routes','tt-ai-admin.js'),'utf8');
const client=fs.readFileSync(path.join(root,'lib','tt-ai-client.js'),'utf8');
const signer=fs.readFileSync(path.join(root,'lib','tt-ai-assertion.js'),'utf8');
const permissions=fs.readFileSync(path.join(root,'lib','permissions.js'),'utf8');
const shell=fs.readFileSync(path.join(root,'public','app-shell.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'public','tt-ai-knowledge-review.js'),'utf8');
const css=fs.readFileSync(path.join(root,'public','tt-ai-knowledge-review.css'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

const checks=[
  ['admin proxy is mounted separately from read gateway',server.includes("app.use('/api/tt-ai-admin', require('./routes/tt-ai-admin'))")],
  ['machine credentials cannot administer knowledge',route.includes('TT_AI_ADMIN_STAFF_SESSION_REQUIRED')&&route.includes('if (req.apiKey)')],
  ['all knowledge admin routes require explicit integration-admin permission',(route.match(/requirePermission\('settings_integrations'\)/g)||[]).length>=5],
  ['settings integrations remains explicit-only',permissions.includes("EXPLICIT_ONLY_PERMISSIONS = new Set(['customers_sensitive', 'settings_integrations'")&&permissions.includes("if (EXPLICIT_ONLY_PERMISSIONS.has(key)) return permissions[key] === true")],
  ['signed assertion carries integration-admin authority',signer.includes("'settings_integrations'")],
  ['admin client allowlists only TT AI knowledge catalog paths',client.includes('requestTTAIAdmin')&&client.includes('TT_AI_ADMIN_PATH_NOT_ALLOWED')&&client.includes('^\\/v1\\/admin\\/knowledge\\/catalog-links')],
  ['workspace is administration-only and explicitly permission-gated',shell.includes("'TT AI Knowledge Review'")&&shell.includes("'tt-ai-knowledge-review':'settings_integrations'")],
  ['workspace lazy-loads its dedicated assets',shell.includes("'tt-ai-knowledge-review':['/tt-ai-knowledge-review.css','/tt-ai-knowledge-review.js','TotalToolsTTAIKnowledgeReview']")],
  ['workspace uses only dedicated TT AI admin proxy endpoints',ui.includes('/api/tt-ai-admin/context')&&ui.includes('/api/tt-ai-admin/knowledge-review')&&!/\/api\/(?:products|inventory|purchase-orders|rentals|transactions)\//.test(ui)],
  ['approval requires an explicit second confirmation',ui.includes('data-decide="approve"')&&ui.includes('data-confirm="')&&ui.includes('Confirm approval')],
  ['review screen has no bulk approve action',!ui.includes('Approve all')&&!ui.includes('approve-all')],
  ['review screen explains operational non-mutation boundary',ui.includes('They do not change POS products, stock, prices, purchases, rentals or accounting records')],
  ['proposal evidence and match reasons are visible',ui.includes('Why TT AI suggested this match')&&ui.includes('manufacturer_part_number')&&ui.includes('source_filename')],
  ['responsive mobile treatment exists',css.includes('@media(max-width:760px)')],
  ['reduced motion is respected',css.includes('prefers-reduced-motion')],
];

const failed=checks.filter(([,ok])=>!ok);
for(const [label,ok] of checks)console.log(`${ok?'PASS':'FAIL'} - ${label}`);
if(failed.length){
  console.error(`TT AI admin contract failed: ${failed.length} check(s)`);
  process.exit(1);
}
console.log(`TT AI admin contract passed: ${checks.length}/${checks.length}`);
