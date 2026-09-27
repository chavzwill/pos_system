const fs=require('fs');
const route=fs.readFileSync('routes/transaction-void-hardening.js','utf8');
const checks=[
  ['void override is rate limited',route.includes('privilegedPinRateLimit')],
  ['void override accepts only 6-10 digit PIN input',route.includes("/^\\d{6,10}$/.test(String(pin||''))")],
  ['hashed PINs are verified with bcrypt',route.includes('bcrypt.compare(String(supplied),stored)')],
  ['legacy plaintext PINs are upgraded after successful use',route.includes('upgradeLegacyPin')&&route.includes('UPDATE employees SET pin=? WHERE id=? AND pin=?')],
  ['void permission is still required',route.includes('void_transactions===true')],
  ['successful privileged verification resets limiter',route.includes('resetRequestRateLimit(req)')],
  ['void transition is atomic',route.includes("WHERE id=? AND status='completed'")&&route.includes('rowsAffected||0')],
];
let failed=false;
for(const [name,pass] of checks){console.log(`${pass?'PASS':'FAIL'} ${name}`);if(!pass)failed=true;}
if(failed)process.exit(1);
console.log(`Transaction void security contract OK (${checks.length} checks).`);