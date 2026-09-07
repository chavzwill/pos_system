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
const server = read('server.js');

if (manifest.runtime !== 'native-pos') fail('runtime identity must be native-pos');
if (manifest.frontend !== 'pos-owned') fail('frontend must be POS-owned');
if (manifest.server !== 'pos-owned') fail('server must be POS-owned');
if (manifest.apiBase !== '/api') fail('native API base must remain /api');
if (manifest.sameOrigin !== true) fail('frontend and POS API must remain same-origin by default');
if (manifest.externalCommerceRuntimeRequired !== false) fail('external commerce runtime cannot be a POS boot dependency');

if (!shell.includes('/pos-native-runtime.js')) fail('native runtime bootstrap is missing from app shell');
if (!shell.includes('/pos-api-client.js')) fail('native POS API client is missing from app shell');
if (!shell.includes('/native-pos-shell.js')) fail('native POS shell enhancement is missing from app shell');
if (!shell.includes('/native-pos-shell.css')) fail('native POS shell stylesheet is missing from app shell');
if (!shell.includes('/native-sales-modernization.js')) fail('native cashier enhancement is missing from app shell');
if (!shell.includes('/native-sales-modernization.css')) fail('native cashier stylesheet is missing from app shell');
if (!shell.includes('/native-repairs-modernization.js')) fail('native repairs enhancement is missing from app shell');
if (!shell.includes('/native-repairs-modernization.css')) fail('native repairs stylesheet is missing from app shell');
if (!shell.includes('/native-rentals-modernization.js')) fail('native rentals enhancement is missing from app shell');
if (!shell.includes('/native-rentals-modernization.css')) fail('native rentals stylesheet is missing from app shell');
if (!bootstrap.includes("fetch('/pos-runtime.json'")) fail('frontend does not verify the POS runtime manifest');
if (!apiClient.includes("const API_BASE = '/api'")) fail('POS API client must remain rooted at /api');
if (!apiClient.includes("url.origin !== location.origin")) fail('POS API client must reject cross-origin runtime calls');
if (!nativeShell.includes('TotalToolsNativePosShell')) fail('native command shell API is missing');
if (!nativeShellCss.includes('.pos-command-overlay')) fail('native command palette styling is missing');
if (!salesModernization.includes("const ROOT_ID='tt-sales-workspace'")) fail('cashier enhancement must bind to the native POS sales workspace');
if (!salesModernization.includes("e.key==='F2'")) fail('cashier checkout shortcut contract missing');
if (!salesModernizationCss.includes('.pos-cashier-strip')) fail('cashier readiness strip styling is missing');
if (!repairsModernization.includes("const ROOT_ID='tt-work-orders-workspace'")) fail('repairs enhancement must bind to the native POS work-order workspace');
if (!repairsModernization.includes('TotalToolsNativeRepairs')) fail('native repairs enhancement API is missing');
if (!repairsModernizationCss.includes('.tt-repair-modern-bar')) fail('repair command bar styling is missing');
if (!rentalsModernization.includes("const ROOT_ID='tt-rentals-workspace'")) fail('rentals enhancement must bind to the native POS rental workspace');
if (!rentalsModernization.includes('TotalToolsNativeRentalsModernization')) fail('native rentals enhancement API is missing');
if (!rentalsModernizationCss.includes('.pos-rental-command')) fail('rental command bar styling is missing');
if (!server.includes("const app = express();")) fail('native Express application bootstrap missing');
if (!server.includes("app.use('/api'")) fail('native POS API mount missing');
if (!server.includes('express.static(publicDir')) fail('POS server must serve its own frontend');

if (!process.exitCode) {
  console.log('Native POS runtime contract passed. Frontend, cashier, repairs, rentals, API client and server are POS-owned and same-origin.');
}
