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
const salesModernizationCss = read('public/native-sales-modernization.css');
const repairsModernization = read('public/native-repairs-modernization.js');
const repairsModernizationCss = read('public/native-repairs-modernization.css');
const rentalsModernization = read('public/native-rentals-modernization.js');
const rentalsModernizationCss = read('public/native-rentals-modernization.css');
const dispatchModernization = read('public/native-dispatch-modernization.js');
const dispatchModernizationCss = read('public/native-dispatch-modernization.css');
const logisticsRoute = read('routes/logistics-intelligence.js');
const commercialHandoff = read('routes/logistics-commercial-handoff.js');
const server = read('server.js');

if (manifest.runtime !== 'native-pos') fail('runtime identity must be native-pos');
if (manifest.frontend !== 'pos-owned') fail('frontend must be POS-owned');
if (manifest.server !== 'pos-owned') fail('server must be POS-owned');
if (manifest.apiBase !== '/api') fail('native API base must remain /api');
if (manifest.sameOrigin !== true) fail('frontend and POS API must remain same-origin by default');
if (manifest.externalCommerceRuntimeRequired !== false) fail('external commerce runtime cannot be a POS boot dependency');

for (const asset of ['/pos-native-runtime.js','/pos-api-client.js','/native-pos-shell.js','/native-pos-shell.css','/native-sales-modernization.js','/native-sales-modernization.css','/native-repairs-modernization.js','/native-repairs-modernization.css','/native-rentals-modernization.js','/native-rentals-modernization.css','/native-dispatch-modernization.js','/native-dispatch-modernization.css']) {
  if (!shell.includes(asset)) fail(`${asset} is missing from app shell`);
}
if (!bootstrap.includes("fetch('/pos-runtime.json'")) fail('frontend does not verify the POS runtime manifest');
if (!apiClient.includes("const API_BASE = '/api'")) fail('POS API client must remain rooted at /api');
if (!apiClient.includes("url.origin !== location.origin")) fail('POS API client must reject cross-origin runtime calls');
if (!nativeShell.includes('TotalToolsNativePosShell')) fail('native command shell API is missing');
if (!nativeShellCss.includes('.pos-command-overlay')) fail('native command palette styling is missing');
if (!salesModernization.includes("const ROOT_ID='tt-sales-workspace'")) fail('cashier enhancement must bind to the native POS sales workspace');
if (!repairsModernization.includes("const ROOT_ID='tt-work-orders-workspace'")) fail('repairs enhancement must bind to the native POS work-order workspace');
if (!rentalsModernization.includes("const ROOT_ID='tt-rentals-workspace'")) fail('rentals enhancement must bind to the native POS rental workspace');
if (!dispatchModernization.includes("const ROOT_ID='tt-logistics-intelligence'")) fail('dispatch enhancement must bind to the native POS logistics workspace');
if (!dispatchModernization.includes('supplier_pickup') || !dispatchModernization.includes('customer_delivery') || !dispatchModernization.includes('rental_delivery') || !dispatchModernization.includes('repair_pickup') || !dispatchModernization.includes('branch_transfer')) fail('dispatch modernization must expose the unified logistics sources');
if (!dispatchModernizationCss.includes('.tt-dispatch-modern-bar')) fail('dispatch command bar styling is missing');
if (!logisticsRoute.includes("router.get('/command-center'")) fail('native dispatch command center API is missing');
if (!commercialHandoff.includes("/from-purchase-order/:id") || !commercialHandoff.includes("/from-sales-invoice/:id") || !commercialHandoff.includes("/from-rental/:id") || !commercialHandoff.includes("logistics-repair-handoff")) fail('native dispatch commercial handoffs are incomplete');
if (!server.includes("const app = express();")) fail('native Express application bootstrap missing');
if (!server.includes("app.use('/api'")) fail('native POS API mount missing');
if (!server.includes('express.static(publicDir')) fail('POS server must serve its own frontend');

if (!process.exitCode) {
  console.log('Native POS runtime contract passed. Frontend, cashier, repairs, rentals, dispatch, API client and server are POS-owned and same-origin.');
}
