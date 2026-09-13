const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const route=fs.readFileSync(path.join(root,'routes','employee-end-shift-assistant.js'),'utf8');
const checks=[
 ['end-shift snapshot requires employee authentication',route.includes('router.use(requireAuth)')],
 ['open employee drawer is a blocking condition',route.includes("ds.employee_id=? AND ds.status='open'")&&route.includes("severity:'blocking'")],
 ['follow-ups are included in handoff review',route.includes("completed=0 AND type='follow_up'")],
 ['assigned unfinished dispatch is included',route.includes('assignee_employee_id=?')&&route.includes("status NOT IN ('completed','cancelled')")],
 ['existing unresolved handovers remain visible',route.includes("status!='resolved'")],
 ['assistant never auto-closes a cash drawer',!route.includes("UPDATE drawer_sessions SET status='closed'")],
 ['assistant never auto-completes dispatch work',!route.includes('UPDATE dispatch_jobs')],
 ['handover is attributable to authenticated employee',route.includes('req.employee.id')&&route.includes('created_by')],
 ['handover persists a server-derived unfinished-work summary',route.includes("Unfinished work:")&&route.includes('snap.items')],
 ['sign-out readiness depends on drawer custody',route.includes('ready_to_sign_out:openDrawers.length===0')]
];
let failed=0;
for(const [name,ok] of checks){if(ok)console.log(`PASS End shift: ${name}`);else{console.error(`FAIL End shift: ${name}`);failed++;}}
if(failed)process.exit(1);
console.log(`End-of-shift assistant contract OK (${checks.length} checks).`);
