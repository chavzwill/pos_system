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
if (!bootstrap.includes("fetch('/pos-runtime.json'")) fail('frontend does not verify the POS runtime manifest');
if (!apiClient.includes("const API_BASE = '/api'")) fail('POS API client must remain rooted at /api');
if (!apiClient.includes("url.origin !== location.origin")) fail('POS API client must reject cross-origin runtime calls');
if (!nativeShell.includes('TotalToolsNativePosShell')) fail('native command shell API is missing');
if (!nativeShellCss.includes('.pos-command-overlay')) fail('native command palette styling is missing');
if (!server.includes("const app = express();")) fail('native Express application bootstrap missing');
if (!server.includes("app.use('/api'")) fail('native POS API mount missing');
if (!server.includes('express.static(publicDir')) fail('POS server must serve its own frontend');

if (!process.exitCode) {
  console.log('Native POS runtime contract passed. Frontend, shell, API client and server are POS-owned and same-origin.');
}
