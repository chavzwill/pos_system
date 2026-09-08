'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fail = message => { console.error(`ERROR: ${message}`); process.exit(2); };

if (String(process.env.POS_TEST_BASE_URL || '').trim()) {
  fail('POS_TEST_BASE_URL must not be set for disposable certification. This runner owns its isolated local server/database.');
}
if (String(process.env.TURSO_DATABASE_URL || '').trim().startsWith('libsql:')) {
  fail('Refusing to run disposable certification while TURSO_DATABASE_URL points at a remote libsql database.');
}

let playwrightCli;
try {
  playwrightCli = require.resolve('@playwright/test/cli');
} catch (_) {
  fail('Playwright is not installed in this checkout. This runner will not install packages or browsers automatically.');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'total-tools-pos-cert-'));
const dbPath = path.join(tempRoot, 'pos-cert.db');
const testPassword = process.env.POS_DISPOSABLE_TEST_PASSWORD || 'LocalCertificationOnly-2026!';
const testPin = process.env.POS_DISPOSABLE_TEST_PIN || '246810';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: process.env.POS_DISPOSABLE_PORT || '3001',
  TURSO_DATABASE_URL: `file:${dbPath}`,
  TURSO_AUTH_TOKEN: '',
  POS_TEST_USER: 'admin',
  POS_TEST_PASSWORD: testPassword,
  POS_TEST_PIN: testPin,
  POS_TEST_ALLOW_MUTATIONS: 'YES',
  POS_DISPOSABLE_CERTIFICATION: 'YES',
};
delete env.VERCEL;
delete env.POS_TEST_BASE_URL;

function run(label, command, args, extraEnv = {}) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

try {
  run('Initialize isolated POS database and test administrator', process.execPath, ['-e', `
    const bcrypt=require('bcryptjs');
    const {ensureReady,db}=require('./database');
    (async()=>{
      await ensureReady();
      const passwordHash=await bcrypt.hash(process.env.POS_TEST_PASSWORD,12);
      const pinHash=await bcrypt.hash(process.env.POS_TEST_PIN,12);
      const result=await db.execute({sql:"UPDATE employees SET password=?,pin=?,must_change_password=0,active=1 WHERE username='admin'",args:[passwordHash,pinHash]});
      if(Number(result.rowsAffected||0)!==1) throw new Error('Disposable admin bootstrap did not update exactly one employee');
      const {rows:[admin]}=await db.execute({sql:"SELECT e.id,e.username,e.security_group_id,e.default_branch_id,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.username='admin'",args:[]});
      if(!admin||!admin.security_group_id||!admin.default_branch_id) throw new Error('Disposable admin is missing security-group or branch authority');
      const permissions=JSON.parse(admin.permissions||'{}');
      if(!permissions.pos||!permissions.inventory||!permissions.work_orders) throw new Error('Disposable admin authority is incomplete');
      console.log('PASS: isolated POS database initialized and admin credentials provisioned');
    })().catch(err=>{console.error(err);process.exit(1);});
  `]);

  run('Static production certification', process.execPath, ['scripts/check-pos-production-certification.js']);
  run('Native runtime architecture contract', process.execPath, ['scripts/check-native-pos-runtime.js']);
  run('Backup/recovery contract', process.execPath, ['scripts/check-production-recovery-contract.js']);
  run('Startup health/cutover contract', process.execPath, ['scripts/check-production-observability-contract.js']);

  const suites = [
    'tests/native-pos-certification.spec.js',
    'tests/native-responsive-shell.spec.js',
    'tests/operations-acceptance.spec.js',
    'tests/security-boundaries.spec.js',
    'tests/operation-idempotency.spec.js',
    'tests/lifecycle-concurrency.spec.js',
    'tests/business-integrity.spec.js',
    'tests/pos-financial-runtime.js',
    'tests/accounting-ledger-integrity.spec.js',
    'tests/accounting-source-sync-rbac.spec.js',
    'tests/logistics-intelligence.spec.js',
    'tests/rentals-integrity.spec.js',
    'tests/repair-quality-integrity.spec.js',
    'tests/service-completion-integrity.spec.js',
  ];

  run('Disposable runtime production certification', process.execPath, [playwrightCli, 'test', ...suites]);

  console.log(`\nPASS: disposable POS certification completed using isolated database ${dbPath}`);
  console.log('No production or remote database was used.');
} finally {
  if (process.env.POS_KEEP_DISPOSABLE_CERTIFICATION === 'YES') {
    console.log(`Disposable certification state retained at: ${tempRoot}`);
  } else {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
  }
}
