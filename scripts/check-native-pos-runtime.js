const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const fail = (message) => {
  console.error(`Native POS runtime contract failed: ${message}`);
  process.exitCode = 1;
};

const manifest = JSON.parse(read('public/pos-runtime.json'));
const shell = read('public/app-shell.html');
const bootstrap = read('public/pos-native-runtime.js');
const apiClient = read('public/pos-api-client.js');
const nativeShell = read('public/native-pos-shell.js');
const nativeShellCss = read('public/native-pos-shell.css');
const salesModernization = read('public/native-sales-modernization.js');
const repairsModernization = read('public/native-repairs-modernization.js');
const rentalsModernization = read('public/native-rentals-modernization.js');
const dispatchModernization = read('public/native-dispatch-modernization.js');
const dispatchModernizationCss = read('public/native-dispatch-modernization.css');
const inventoryModernization = read('public/native-inventory-modernization.js');
const inventoryModernizationCss = read('public/native-inventory-modernization.css');
const purchasingModernization = read('public/native-purchasing-modernization.js');
const purchasingModernizationCss = read('public/native-purchasing-modernization.css');
const financeModernization = read('public/native-finance-modernization.js');
const financeModernizationCss = read('public/native-finance-modernization.css');
const crmModernization = read('public/native-crm-modernization.js');
const crmModernizationCss = read('public/native-crm-modernization.css');
const adminModernization = read('public/native-admin-modernization.js');
const adminModernizationCss = read('public/native-admin-modernization.css');
const inventoryWorkspace = read('public/inventory-workspace.js');
const purchasingWorkspace = read('public/purchasing-workspace.js');
const accountingIntelligence = read('public/accounting-intelligence.js');
const accountingLedger = read('public/accounting-ledger.js');
const crmWorkspace = read('public/customer-crm-workspace.js');
const adminWorkspace = read('public/admin-workspace.js');
const logisticsRoute = read('routes/logistics-intelligence.js');
const commercialHandoff = read('routes/logistics-commercial-handoff.js');
const branchGuard = read('routes/multi-branch-integrity-guard.js');
const idempotency = read('routes/operation-idempotency.js');
const server = read('server.js');

if (manifest.runtime !== 'native-pos') fail('runtime identity must be native-pos');
if (manifest.frontend !== 'pos-owned') fail('frontend must be POS-owned');
if (manifest.server !== 'pos-owned') fail('server must be POS-owned');
if (manifest.apiBase !== '/api') fail('native API base must remain /api');
if (manifest.sameOrigin !== true) fail('frontend and POS API must remain same-origin by default');
if (manifest.externalCommerceRuntimeRequired !== false) fail('external commerce runtime cannot be a POS boot dependency');

for (const asset of ['/pos-native-runtime.js','/pos-api-client.js','/native-pos-shell.js','/native-pos-shell.css','/native-sales-modernization.js','/native-sales-modernization.css','/native-repairs-modernization.js','/native-repairs-modernization.css','/native-rentals-modernization.js','/native-rentals-modernization.css','/native-dispatch-modernization.js','/native-dispatch-modernization.css','/native-inventory-modernization.js','/native-inventory-modernization.css','/native-purchasing-modernization.js','/native-purchasing-modernization.css','/native-finance-modernization.js','/native-finance-modernization.css','/native-crm-modernization.js','/native-crm-modernization.css','/native-admin-modernization.js','/native-admin-modernization.css']) {
  if (!shell.includes(asset)) fail(`${asset} is missing from app shell`);
}
if (!bootstrap.includes("fetch('/pos-runtime.json'")) fail('frontend does not verify the POS runtime manifest');
if (!apiClient.includes("if (value.startsWith('/api/')) return value")) fail('POS API client must remain rooted at /api');
if (!apiClient.includes('POS native API client only accepts same-origin paths')) fail('POS API client must reject cross-origin runtime calls');
if (!apiClient.includes("init.headers['Idempotency-Key']")) fail('native mutation client must attach durable idempotency keys');
if (!apiClient.includes('const nativeFetch = window.fetch.bind(window)')) fail('native API client must retain an unwrapped transport for its own requests');
if (!apiClient.includes('window.fetch = protectedDirectFetch')) fail('direct same-origin API mutations must be intercepted by the durable mutation layer');
if (!apiClient.includes("response.status >= 500")) fail('ambiguous server failures must preserve pending mutation identity');
if (!apiClient.includes('operation_idempotency_outcome_unknown')) fail('native client must recognize unresolved idempotency outcomes');
if (!apiClient.includes("'/api/employees/login'")) fail('authentication must remain outside business-operation idempotency interception');
const apiClientIndex = shell.indexOf('/pos-api-client.js');
const appShellIndex = shell.indexOf('/app-shell.js');
if (apiClientIndex < 0 || appShellIndex < 0 || apiClientIndex > appShellIndex) fail('POS API protection must load before workspace shell code');
if (!branchGuard.includes("require('./operation-idempotency')")) fail('server mutation idempotency must run after branch authorization');
if (!idempotency.includes('UNIQUE(scope,idempotency_key)')) fail('durable operation idempotency storage is missing');
if (!nativeShell.includes('TotalToolsNativePosShell')) fail('native command shell API is missing');
if (!nativeShellCss.includes('.pos-command-overlay')) fail('native command palette styling is missing');
if (!salesModernization.includes("const ROOT_ID='tt-sales-workspace'")) fail('cashier enhancement must bind to native sales');
if (!repairsModernization.includes("const ROOT_ID='tt-work-orders-workspace'")) fail('repairs enhancement must bind to native work orders');
if (!rentalsModernization.includes("const ROOT_ID='tt-rentals-workspace'")) fail('rentals enhancement must bind to native rentals');
if (!dispatchModernization.includes("const ROOT_ID='tt-logistics-intelligence'")) fail('dispatch enhancement must bind to native logistics');
if (!dispatchModernization.includes('supplier_pickup') || !dispatchModernization.includes('customer_delivery') || !dispatchModernization.includes('rental_delivery') || !dispatchModernization.includes('repair_pickup') || !dispatchModernization.includes('branch_transfer')) fail('dispatch modernization must expose unified logistics sources');
if (!dispatchModernizationCss.includes('.tt-dispatch-modern-bar')) fail('dispatch command styling is missing');
if (!inventoryModernization.includes("const ROOT_ID='tt-inventory-workspace'")) fail('inventory enhancement must bind to native inventory');
if (!inventoryModernizationCss.includes('.tt-inv-modern-bar')) fail('inventory command styling is missing');
if (!inventoryWorkspace.includes('/api/products?') || !inventoryWorkspace.includes('/movements') || !inventoryWorkspace.includes('/stock')) fail('native inventory operational APIs are incomplete');
if (!purchasingModernization.includes("const ROOT_ID='tt-purchasing-workspace'")) fail('purchasing enhancement must bind to native purchasing');
if (!purchasingModernizationCss.includes('.tt-purch-modern-bar')) fail('purchasing command styling is missing');
if (!purchasingWorkspace.includes('/api/purchase-requests') || !purchasingWorkspace.includes('/api/purchase-orders')) fail('native purchasing workflows are incomplete');
if (!financeModernization.includes("'tt-accounting-intelligence'") || !financeModernization.includes("'tt-accounting-ledger'")) fail('finance enhancement must bind to native accounting workspaces');
if (!financeModernizationCss.includes('.tt-finance-modern-bar')) fail('finance command styling is missing');
if (!accountingIntelligence.includes('/api/accounting-intelligence') || !accountingLedger.includes('/api/accounting-ledger')) fail('native finance workspaces must use POS accounting APIs');
if (!accountingLedger.includes('Posted journals are locked and must be corrected by reversal')) fail('posted-journal immutability guidance is missing');
if (!crmModernization.includes("const ROOT_ID='tt-customer-crm'")) fail('CRM enhancement must bind to native CRM');
if (!crmModernizationCss.includes('.tt-crm-modern-bar')) fail('CRM command styling is missing');
if (!crmWorkspace.includes('/api/customers?') || !crmWorkspace.includes('/api/crm/dashboard')) fail('native CRM customer and pipeline APIs are incomplete');
if (!adminModernization.includes("const ROOT_ID='tt-admin'")) fail('administration enhancement must bind to native admin');
if (!adminModernizationCss.includes('.tt-admin-modern-bar')) fail('administration command styling is missing');
if (!adminWorkspace.includes('/api/employees') || !adminWorkspace.includes('/api/branches') || !adminWorkspace.includes('/api/security-groups')) fail('native administration APIs are incomplete');
if (!adminWorkspace.includes('Permissions come from the selected security group')) fail('RBAC authority guidance is missing');
if (!logisticsRoute.includes("router.get('/command-center'")) fail('native dispatch command center API is missing');
if (!commercialHandoff.includes('/from-purchase-order/:id') || !commercialHandoff.includes('/from-sales-invoice/:id') || !commercialHandoff.includes('/from-rental/:id') || !commercialHandoff.includes('logistics-repair-handoff')) fail('native dispatch commercial handoffs are incomplete');
if (!server.includes('const app = express();')) fail('native Express application bootstrap missing');
if (!server.includes("app.use('/api'")) fail('native POS API mount missing');
if (!server.includes('express.static(publicDir')) fail('POS server must serve its own frontend');

if (!process.exitCode) {
  console.log('Native POS runtime contract passed. POS-owned same-origin workspaces and durable mutation protection are present, including direct fetch interception.');
}
