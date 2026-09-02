'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

const DB_FILES = ['pos.db', 'pos.db-shm', 'pos.db-wal'];
const STRONG_PASSWORD = 'S3cure-Bootstrap!2026';
const STRONG_PIN = '864209';

function cleanDb() {
  for (const file of DB_FILES) {
    try { fs.rmSync(file, { force: true }); } catch (_) {}
  }
}

function runPreflight(extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/production-credential-preflight.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TURSO_DATABASE_URL: '',
      TURSO_AUTH_TOKEN: '',
      POS_BOOTSTRAP_ADMIN_PASSWORD: '',
      POS_BOOTSTRAP_ADMIN_PIN: '',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (process.env.TURSO_DATABASE_URL) {
    throw new Error('Credential bootstrap certification must use isolated local SQLite, not Turso.');
  }

  const databaseSource = fs.readFileSync('database.js', 'utf8');
  assert(!databaseSource.includes("password='123456'"), 'database.js still contains the legacy admin password repair.');
  assert(!databaseSource.includes("'admin','1234','123456'"), 'database.js still seeds the legacy admin password/PIN pair.');
  assert(databaseSource.includes("const lockedCredential = '!LOCKED!';"), 'Fresh identities are not explicitly credential-locked.');

  cleanDb();
  try {
    const blocked = runPreflight();
    assert(blocked.status !== 0, 'Production preflight unexpectedly accepted a fresh locked database without bootstrap credentials.');
    assert(/SECURITY STARTUP BLOCK/i.test(`${blocked.stdout}\n${blocked.stderr}`), 'Missing bootstrap credentials did not fail through the security startup block.');

    const secured = runPreflight({
      POS_BOOTSTRAP_ADMIN_PASSWORD: STRONG_PASSWORD,
      POS_BOOTSTRAP_ADMIN_PIN: STRONG_PIN,
    });
    assert(secured.status === 0, `Strong production bootstrap failed: ${String(secured.stderr || secured.stdout).slice(0, 500)}`);

    const db = createClient({ url: 'file:pos.db' });
    try {
      const { rows } = await db.execute({ sql: 'SELECT id,username,password,pin,must_change_password FROM employees ORDER BY id', args: [] });
      const admin = rows.find(row => row.username === 'admin');
      assert(admin, 'Fresh database did not contain the bootstrap administrator identity.');
      assert(/^\$2[aby]\$/.test(String(admin.password || '')), 'Provisioned administrator password is not bcrypt at rest.');
      assert(/^\$2[aby]\$/.test(String(admin.pin || '')), 'Provisioned administrator PIN is not bcrypt at rest.');
      assert(await bcrypt.compare(STRONG_PASSWORD, admin.password), 'Stored administrator password does not match the supplied strong bootstrap value.');
      assert(await bcrypt.compare(STRONG_PIN, admin.pin), 'Stored administrator PIN does not match the supplied strong bootstrap value.');
      assert(!(await bcrypt.compare('123456', admin.password)), 'Legacy default password still authenticates after bootstrap.');
      assert(!(await bcrypt.compare('123456', admin.pin)), 'Legacy default PIN still authenticates after bootstrap.');
      assert(Number(admin.must_change_password) === 1, 'Bootstrap administrator is not forced to change the temporary password.');

      for (const employee of rows) {
        const password = employee.password == null ? null : String(employee.password);
        const pin = employee.pin == null ? null : String(employee.pin);
        if (password !== null) assert(/^\$2[aby]\$/.test(password), `Employee ${employee.id} has a non-bcrypt password at rest.`);
        assert(pin === '!LOCKED!' || /^\$2[aby]\$/.test(pin || ''), `Employee ${employee.id} has a plaintext/usable seeded PIN at rest.`);
        assert(!/^\d{4,10}$/.test(pin || ''), `Employee ${employee.id} retains a numeric plaintext PIN.`);
      }
    } finally {
      db.close();
    }

    console.log('Production credential bootstrap certification passed: fresh identities are locked, missing bootstrap fails closed, and supplied bootstrap credentials are bcrypt-only at rest.');
  } finally {
    cleanDb();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  cleanDb();
  process.exit(1);
});
