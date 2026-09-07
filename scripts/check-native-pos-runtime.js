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
const inventoryWorkspace = read('public/inventory-workspace.js');
const purchasingWorkspace = read('public/purchasing-workspace.js');
const logisticsRoute = read('routes/logistics-intelligence.js');
const commercialHandoff = read('routes/logistics-commercial-handoff.js');
const server = read('server.js');

if (manifest.runtime !== 'native-pos') fail('runtime identity must be native-pos');
if (manifest.frontend !== 'pos-owned') fail('frontend must be POS-owned');
if (manifest.server !== 'pos-owned') fail('server must be POS-owned');
if (manifest.apiBase !== '/api') fail('native API base must remain /api');
if (manifest.sameOrigin !== true) fail('frontend and POS API must remain same-origin by default');
if (manifest.externalCommerceRuntimeRequired !== false) fail('external commerce runtime cannot be a POS boot dependency');

for (const asset of ['/pos-native-runtime.js','/pos-api-client.js','/native-pos-shell.js','/native-pos-shell.css','/native-sales-modernization.js','/native-sales-modernization.css','/native-repairs-modernization.js','/native-repairs-modernization.css','/native-rentals-modernization.js','/native-rentals-modernization.css','/native-dispatch-modernization.js','/native-dispatch-modernization.css','/native-inventory-modernization.js','/native-inventory-modernization.css','/native-purchasing-modernization.js','/native-purchasing-modernization.css']) {
  if (!shell.includes(asset)) fail(`${asset} is missing from app shell`);
}
if (!bootstrap.includes("fetch('/pos-runtime.json'")) fail('frontend does not verify the POS runtime manifest');
if (!apiClient.includes("const API_BASE = '/api'")) fail('POS API client must remain rooted at /api');
if (!apiClient.includes("url.origin !== location.origin")) fail('POS API client must reject cross-origin runtime calls');
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
if (!logisticsRoute.includes("router.get('/command-center'")) fail('native dispatch command center API is missing');
if (!commercialHandoff.includes("/from-purchase-order/:id") || !commercialHandoff.includes("/from-sales-invoice/:id") || !commercialHandoff.includes("/from-rental/:id") || !commercialHandoff.includes("logistics-repair-handoff")) fail('native dispatch commercial handoffs are incomplete');
if (!server.includes("const app = express();")) fail('native Express application bootstrap missing');
if (!server.includes("app.use('/api'")) fail('native POS API mount missing');
if (!server.includes('express.static(publicDir')) fail('POS server must serve its own frontend');

if (!process.exitCode) {
  console.log('Native POS runtime contract passed. Sales, repairs, rentals, dispatch, inventory and purchasing are POS-owned and same-origin.');
}
