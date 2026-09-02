'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

const DB_FILES = ['pos.db', 'pos.db-shm', 'pos.db-wal'];
const TEMPORARY_PASSWORD = 'Recovery-Only!2026-A7';
const REASON = 'Automated certification of the privileged recovery boundary';

function cleanDb() {
  for (const file of DB_FILES) {
    try { fs.rmSync(file, { force: true }); } catch (_) {}
  }
}
function run(extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/production-account-recovery.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TURSO_DATABASE_URL: '',
      TURSO_AUTH_TOKEN: '',
      POS_RECOVERY_USERNAME: 'admin',
      POS_RECOVERY_PASSWORD: TEMPORARY_PASSWORD,
      POS_RECOVERY_REASON: REASON,
      POS_RECOVERY_CONFIRM: '',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (process.env.TURSO_DATABASE_URL) throw new Error('Recovery certification must use isolated local SQLite, not Turso.');
  cleanDb();
  try {
    const unconfirmed = run();
    assert(unconfirmed.status !== 0, 'Recovery unexpectedly ran without explicit RESET confirmation.');
    assert(/SECURITY RECOVERY BLOCK/i.test(`${unconfirmed.stdout}\n${unconfirmed.stderr}`), 'Unconfirmed recovery did not fail through the recovery security block.');

    const weak = run({ POS_RECOVERY_CONFIRM: 'RESET', POS_RECOVERY_PASSWORD: '123456' });
    assert(weak.status !== 0, 'Recovery unexpectedly accepted a weak temporary password.');

    const recovered = run({ POS_RECOVERY_CONFIRM: 'RESET' });
    assert(recovered.status === 0, `Confirmed strong recovery failed: ${String(recovered.stderr || recovered.stdout).slice(0, 500)}`);

    const db = createClient({ url: 'file:pos.db' });
    try {
      const { rows: [admin] } = await db.execute({ sql: "SELECT id,password,must_change_password FROM employees WHERE username='admin'", args: [] });
      assert(admin, 'Recovery administrator does not exist.');
      assert(/^\$2[aby]\$/.test(String(admin.password || '')), 'Recovered password is not bcrypt at rest.');
      assert(await bcrypt.compare(TEMPORARY_PASSWORD, admin.password), 'Recovered password does not match the supplied temporary credential.');
      assert(!(await bcrypt.compare('123456', admin.password)), 'Legacy weak password authenticates after recovery.');
      assert(Number(admin.must_change_password) === 1, 'Recovered administrator is not forced through first-login password change.');

      const { rows: audits } = await db.execute({
        sql: "SELECT action,target_type,target_id,reason,control,new_value FROM security_audit_events WHERE action='operator_password_recovery' ORDER BY id DESC",
        args: [],
      });
      assert(audits.length === 1, `Expected exactly one recovery audit event, found ${audits.length}.`);
      assert(Number(audits[0].target_id) === Number(admin.id), 'Recovery audit points at the wrong employee.');
      assert(audits[0].reason === REASON, 'Recovery audit did not retain the operator reason.');
      assert(audits[0].control === 'production_account_recovery', 'Recovery audit control classification is missing.');
      assert(!String(audits[0].new_value || '').includes(TEMPORARY_PASSWORD), 'Recovery audit leaked the temporary password.');
    } finally {
      db.close();
    }

    console.log('Production account recovery certification passed: explicit confirmation, strong temporary credential, forced change, bcrypt storage, and audit evidence are enforced.');
  } finally {
    cleanDb();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  cleanDb();
  process.exit(1);
});
