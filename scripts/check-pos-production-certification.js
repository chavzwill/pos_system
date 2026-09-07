const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const requireFile = relative => {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) throw new Error(`Missing production-certification asset: ${relative}`);
  return read(relative);
};
const expectContains = (content, needle, label) => {
  if (!content.includes(needle)) throw new Error(`${label} is missing required evidence: ${needle}`);
};

const runtime = JSON.parse(requireFile('public/pos-runtime.json'));
if (runtime.runtime !== 'native-pos' || runtime.frontend !== 'pos-owned' || runtime.server !== 'pos-owned' || runtime.sameOrigin !== true || runtime.externalCommerceRuntimeRequired !== false) {
  throw new Error('Native POS ownership contract is not production-safe.');
}

const requiredSuites = [
  'tests/native-pos-certification.spec.js',
  'tests/operations-acceptance.spec.js',
  'tests/business-integrity.spec.js',
  'tests/security-boundaries.spec.js',
  'tests/multi-branch-read-integrity.spec.js',
  'tests/pos-financial-runtime.js',
  'tests/accounting-source-sync-rbac.spec.js',
  'tests/logistics-intelligence.spec.js',
  'tests/rentals-integrity.spec.js',
  'tests/repair-quality-integrity.spec.js',
];
for (const file of requiredSuites) requireFile(file);

const native = read('tests/native-pos-certification.spec.js');
expectContains(native, "externalCommerceRuntimeRequired: false", 'native POS certification');
expectContains(native, '/api/logistics-intelligence/command-center', 'dispatch certification');
expectContains(native, '/api/accounting-intelligence/overview', 'finance certification');
expectContains(native, '/api/security-groups', 'administration certification');

const security = read('tests/security-boundaries.spec.js');
expectContains(security, 'view-only Dispatch role reads the board but cannot plan jobs or sell from another branch', 'branch mutation isolation certification');
expectContains(security, 'dispatch_view', 'dispatch permission separation');
expectContains(security, 'security_assign', 'privilege-escalation certification');

const branchReads = read('tests/multi-branch-read-integrity.spec.js');
expectContains(branchReads, 'branch-scoped employee cannot inspect an arbitrary branch_id', 'branch read isolation certification');
expectContains(branchReads, 'multi_branch_integrity', 'branch read denial evidence');
expectContains(branchReads, '/api/products?active=1&branch_id=', 'branch inventory read certification');
expectContains(branchReads, '/api/work-orders?branch_id=', 'branch repair read certification');
expectContains(branchReads, '/api/rentals/agreements?branch_id=', 'branch rental read certification');
expectContains(branchReads, '/api/purchase-orders?branch_id=', 'branch purchasing read certification');

const branchGuard = read('routes/multi-branch-integrity-guard.js');
expectContains(branchGuard, 'Branch-scoped reads are an authorization boundary', 'multi-branch read guard');
expectContains(branchGuard, "req.query?.branch_id", 'multi-branch query guard');
expectContains(branchGuard, "sourceBranch('transactions'", 'transaction detail IDOR guard');
expectContains(branchGuard, "sourceBranch('work_orders'", 'repair detail IDOR guard');
expectContains(branchGuard, "sourceBranch('rental_agreements'", 'rental detail IDOR guard');
expectContains(branchGuard, "sourceBranch('purchase_orders'", 'purchase-order detail IDOR guard');

const integrity = read('tests/business-integrity.spec.js');
expectContains(integrity, 'registerPurchasingFinancialRuntimeCertification', 'purchasing accounting certification');
expectContains(integrity, 'registerRentalFinancialRuntimeCertification', 'rental accounting certification');
expectContains(integrity, 'registerRepairFinancialRuntimeCertification', 'repair accounting certification');
expectContains(integrity, 'registerDispatchFieldRuntimeCertification', 'dispatch field certification');

const finance = read('tests/pos-financial-runtime.js');
expectContains(finance, 'cash sale, stock restoration, refund settlement and drawer custody remain coherent', 'retail financial certification');
expectContains(finance, 'net_movement', 'drawer reconciliation evidence');

console.log('POS production certification contract passed: native ownership, cross-module runtime suites, multi-branch read/write isolation, RBAC, dispatch, and financial evidence are present.');
