'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const employees=read('routes/employees.js');
const passwordTest=read('tests/password-reset-security.spec.js');
const pinTest=read('tests/pin-reset-security.spec.js');
const numbering=read('lib/nextNumber.js');
const numberingTest=read('tests/document-number-concurrency.spec.js');
const workflow=read('.github/workflows/runtime-certification.yml');

const checks=[];
const check=(name,pass)=>checks.push({name,pass:!!pass});

function block(start,end){
  const a=employees.indexOf(start);
  const b=employees.indexOf(end,a+start.length);
  return a>=0&&b>a?employees.slice(a,b):'';
}
const pinReset=block("router.post('/:id/reset-pin'","router.post('/:id/reset-password'");
const passwordReset=block("router.post('/:id/reset-password'","router.put('/:id'");

check('admin PIN reset requires Security Management authority',pinReset.includes("requirePermission('security_manage')"));
check('admin PIN reset is rate limited',pinReset.includes('loginRateLimit'));
check('admin PIN reset requires actor password reauthentication',
  pinReset.includes('reauth_password')&&pinReset.includes('verifyPassword(actor.password, reauth_password)'));
check('admin PIN reset returns explicit reauthentication code',
  pinReset.includes("code: 'REAUTHENTICATION_REQUIRED'"));
check('admin PIN reset revokes target sessions',
  pinReset.includes('destroyEmployeeSessions(targetId, tx)'));
check('admin PIN reset records elevated audit evidence',
  pinReset.includes("action: 'pin_reset_by_admin'")&&pinReset.includes('elevated_reauthentication: true'));

check('admin password reset requires Security Management authority',passwordReset.includes("requirePermission('security_manage')"));
check('admin password reset is rate limited',passwordReset.includes('loginRateLimit'));
check('admin password reset requires actor password reauthentication',
  passwordReset.includes('reauth_password')&&passwordReset.includes('verifyPassword(actor.password, reauth_password)'));
check('admin password reset returns explicit reauthentication code',
  passwordReset.includes("code: 'REAUTHENTICATION_REQUIRED'"));
check('admin password reset revokes target sessions',
  passwordReset.includes('destroyEmployeeSessions(targetId, tx)'));
check('admin password reset forces password change',
  passwordReset.includes('must_change_password=1'));
check('admin password reset records elevated audit evidence',
  passwordReset.includes("action: 'password_reset_by_admin'")&&passwordReset.includes('elevated_reauthentication: true'));

check('password reset runtime regression covers missing and invalid reauthentication',
  passwordTest.includes('resetWithoutReauth')&&passwordTest.includes('resetWithWrongReauth')&&passwordTest.includes('REAUTHENTICATION_REQUIRED'));
check('PIN reset runtime regression covers missing and invalid reauthentication',
  pinTest.includes('missingReauth')&&pinTest.includes('wrongReauth')&&pinTest.includes('REAUTHENTICATION_REQUIRED'));
check('PIN lifecycle regression verifies session revocation and audit',
  pinTest.includes('sessions_revoked')&&pinTest.includes('pin_reset_by_admin')&&pinTest.includes('pin_changed_self'));

check('document numbering uses atomic sequence UPSERT',
  numbering.includes('ON CONFLICT')&&/sequence/i.test(numbering));
check('document-number concurrency regression exists',
  /Promise\.all|concurr/i.test(numberingTest));
check('Gate 0 runtime certification includes password, PIN reset, and numbering regressions',
  workflow.includes('tests/password-reset-security.spec.js')&&
  workflow.includes('tests/pin-reset-security.spec.js')&&
  workflow.includes('tests/document-number-concurrency.spec.js'));

for(const c of checks) console.log(`${c.pass?'PASS':'FAIL'} Gate 0: ${c.name}`);
if(checks.some(c=>!c.pass)) process.exit(1);
console.log(`Gate 0 credential/concurrency contract OK (${checks.length} checks).`);
