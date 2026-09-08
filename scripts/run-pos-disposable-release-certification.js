'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fail = message => { console.error(`ERROR: ${message}`); process.exit(2); };
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const certificationPort = '3001';

if (String(process.env.POS_TEST_BASE_URL || '').trim()) {
  fail('POS_TEST_BASE_URL must not be set for disposable release certification. This runner owns its isolated local server/database.');
}
const inheritedDb = String(process.env.TURSO_DATABASE_URL || '').trim();
if (inheritedDb && !inheritedDb.startsWith('file:')) {
  fail('Refusing disposable release certification while TURSO_DATABASE_URL points at a non-local database.');
}
if (process.env.POS_DISPOSABLE_PORT && String(process.env.POS_DISPOSABLE_PORT) !== certificationPort) {
  fail(`POS_DISPOSABLE_PORT overrides are not supported by the current release suites. Port ${certificationPort} is required so hard-coded legacy certification clients cannot drift to another server.`);
}

// Mutation-heavy certification must own the HTTP listener as well as the
// temporary database. If another process already owns port 3001, fail before
// creating fixtures instead of letting Playwright reuse or contact that process.
const portProbe = spawnSync(process.execPath, ['-e', `
  const net=require('net');
  const server=net.createServer();
  server.once('error',err=>{ console.error(err.code||err.message); process.exit(1); });
  server.listen(${certificationPort},'127.0.0.1',()=>server.close(()=>process.exit(0)));
`], { cwd: root, encoding: 'utf8' });
if (portProbe.status !== 0) {
  fail(`Port ${certificationPort} is already in use or unavailable. Stop the existing POS/server first. Disposable certification will never reuse an existing server because its tests mutate business data.`);
}

let playwrightCli;
try {
  playwrightCli = require.resolve('@playwright/test/cli');
} catch (_) {
  fail('Playwright is not installed in this checkout. This runner will not install packages or browsers automatically.');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'total-tools-pos-release-cert-'));
const dbPath = path.join(tempRoot, 'pos-release-cert.db');
const testPassword = process.env.POS_DISPOSABLE_TEST_PASSWORD || 'LocalCertificationOnly-2026!';
const testPin = process.env.POS_DISPOSABLE_TEST_PIN || '246810';
const branchPassword = process.env.POS_DISPOSABLE_BRANCH_PASSWORD || 'BranchCertificationOnly-2026!';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: certificationPort,
  TURSO_DATABASE_URL: `file:${dbPath}`,
  TURSO_AUTH_TOKEN: '',
  POS_TEST_USER: 'admin',
  POS_TEST_PASSWORD: testPassword,
  POS_TEST_PIN: testPin,
  POS_TEST_ALLOW_MUTATIONS: 'YES',
  POS_DISPOSABLE_CERTIFICATION: 'YES',
  POS_BRANCH_TEST_USER: 'jdoe',
  POS_BRANCH_TEST_PASSWORD: branchPassword,
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

function capture(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return String(result.stdout || '').trim();
}

try {
  run('Repository syntax and static workflow contracts', npmCommand, ['run', 'check:syntax']);

  run('Initialize isolated POS database and certification identities', process.execPath, ['-e', `
    const bcrypt=require('bcryptjs');
    const {ensureReady,db}=require('./database');
    (async()=>{
      await ensureReady();
      const [adminPasswordHash,adminPinHash,branchPasswordHash]=await Promise.all([
        bcrypt.hash(process.env.POS_TEST_PASSWORD,12),
        bcrypt.hash(process.env.POS_TEST_PIN,12),
        bcrypt.hash(process.env.POS_BRANCH_TEST_PASSWORD,12),
      ]);
      const adminResult=await db.execute({sql:"UPDATE employees SET password=?,pin=?,must_change_password=0,active=1 WHERE username='admin'",args:[adminPasswordHash,adminPinHash]});
      if(Number(adminResult.rowsAffected||0)!==1) throw new Error('Disposable admin bootstrap did not update exactly one employee');
      const branchResult=await db.execute({sql:"UPDATE employees SET password=?,must_change_password=0,active=1 WHERE username='jdoe'",args:[branchPasswordHash]});
      if(Number(branchResult.rowsAffected||0)!==1) throw new Error('Disposable branch-scoped user bootstrap did not update exactly one employee');
      const {rows:[admin]}=await db.execute({sql:"SELECT e.id,e.username,e.security_group_id,e.default_branch_id,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.username='admin'",args:[]});
      const {rows:[branchUser]}=await db.execute({sql:"SELECT e.id,e.username,e.security_group_id,e.default_branch_id,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.username='jdoe'",args:[]});
      if(!admin||!admin.security_group_id||!admin.default_branch_id) throw new Error('Disposable admin is missing security-group or branch authority');
      if(!branchUser||!branchUser.security_group_id||!branchUser.default_branch_id) throw new Error('Disposable branch-scoped user is missing security-group or branch authority');
      const adminPermissions=JSON.parse(admin.permissions||'{}');
      const branchPermissions=JSON.parse(branchUser.permissions||'{}');
      if(!adminPermissions.pos||!adminPermissions.inventory||!adminPermissions.work_orders) throw new Error('Disposable admin authority is incomplete');
      if(branchPermissions.multi_branch_access===true) throw new Error('Disposable branch test user unexpectedly has multi-branch access');
      console.log('PASS: isolated POS database initialized with admin and branch-scoped certification identities');
    })().catch(err=>{console.error(err);process.exit(1);});
  `]);

  const branchJson = capture(process.execPath, ['-e', `
    const {ensureReady,db}=require('./database');
    (async()=>{
      await ensureReady();
      const {rows}=await db.execute({sql:"SELECT id,branch_code FROM branches WHERE active=1 AND branch_code IN ('BR-001','BR-002') ORDER BY branch_code",args:[]});
      const own=rows.find(r=>r.branch_code==='BR-001');
      const other=rows.find(r=>r.branch_code==='BR-002');
      if(!own||!other||Number(own.id)===Number(other.id)) throw new Error('Disposable certification requires two distinct active branches');
      process.stdout.write(JSON.stringify({own:String(own.id),other:String(other.id)}));
    })().catch(err=>{console.error(err);process.exit(1);});
  `]);
  const branchIds = JSON.parse(branchJson);
  env.POS_BRANCH_TEST_OWN_BRANCH = branchIds.own;
  env.POS_BRANCH_TEST_OTHER_BRANCH = branchIds.other;
  console.log(`PASS: branch isolation fixtures resolved own=${branchIds.own}, other=${branchIds.other}`);

  run('Static production certification', process.execPath, ['scripts/check-pos-production-certification.js']);
  run('Native runtime architecture contract', process.execPath, ['scripts/check-native-pos-runtime.js']);
  run('Backup/recovery contract', process.execPath, ['scripts/check-production-recovery-contract.js']);
  run('Startup health/cutover contract', process.execPath, ['scripts/check-production-observability-contract.js']);

  const suites = [
    'tests/native-pos-certification.spec.js',
    'tests/native-responsive-shell.spec.js',
    'tests/operations-acceptance.spec.js',
    'tests/security-boundaries.spec.js',
    'tests/multi-branch-read-integrity.spec.js',
    'tests/operation-idempotency.spec.js',
    'tests/lifecycle-concurrency.spec.js',
    'tests/business-integrity.spec.js',
    'tests/purchase-order-hardening.spec.js',
    'tests/procurement-intelligence-integrity.spec.js',
    'tests/loss-control-integrity.spec.js',
    'tests/technician-compensation.spec.js',
    'tests/erp-intelligence.spec.js',
    'tests/inventory-intelligence.spec.js',
    'tests/logistics-intelligence.spec.js',
    'tests/operational-reports.spec.js',
    'tests/pos-financial-runtime.js',
    'tests/accounting-ledger-integrity.spec.js',
    'tests/accounting-source-sync-rbac.spec.js',
    'tests/rentals-integrity.spec.js',
    'tests/repair-quality-integrity.spec.js',
    'tests/service-completion-integrity.spec.js',
  ];

  run('Disposable release runtime certification', process.execPath, [playwrightCli, 'test', ...suites]);

  console.log(`\nPASS: disposable POS release certification completed using isolated database ${dbPath}`);
  console.log('No production database, remote database, deployment, package installation, or paid service was used.');
} finally {
  if (process.env.POS_KEEP_DISPOSABLE_CERTIFICATION === 'YES') {
    console.log(`Disposable release certification state retained at: ${tempRoot}`);
  } else {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
  }
}
