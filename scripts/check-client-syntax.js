'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const indexPath = path.join(publicDir, 'index.html');

function compile(source, filename) {
  try { new vm.Script(source, { filename }); console.log('Syntax OK:', filename); }
  catch (error) { console.error('Syntax FAILED:', filename); console.error(error && (error.stack || error.message || error)); process.exitCode = 1; }
}

const browserScripts = [
  'app-shell.js','sales-workspace.js','customer-crm-workspace.js','admin-workspace.js','transfers-workspace.js','work-orders-workspace.js','inventory-workspace.js','purchasing-workspace.js','rentals-workspace.js','client-diagnostics.js','pos-guide-map.js','guided-mode.js','technician-compensation.js','stock-rebalancing.js','operational-reports.js','repair-operations.js','repair-communications.js','repair-notifications.js','repair-authorizations.js','repair-parts-integrity.js','inventory-intelligence.js','logistics-intelligence.js','scheduling-intelligence.js','accounting-intelligence.js','financial-controls-intelligence.js','supplier-ledger.js','settlement-reconciliation.js','accounting-ledger.js','pos-upgrade-navigation.js','navigation-shell.js','role-workspace.js','employee-workspace-home.js','login-controller.js',
];
for (const filename of browserScripts) compile(fs.readFileSync(path.join(publicDir, filename), 'utf8'), filename);

const html = fs.readFileSync(indexPath, 'utf8');
const marker = 'const App = {';
const markerIndex = html.indexOf(marker);
const scriptStart = html.lastIndexOf('<script', markerIndex);
const scriptOpenEnd = scriptStart >= 0 ? html.indexOf('>', scriptStart) : -1;
const scriptEnd = html.indexOf('</script>', markerIndex);
if (markerIndex < 0 || scriptStart < 0 || scriptOpenEnd < 0 || scriptEnd < 0) { console.error('Syntax FAILED: unable to locate legacy POS application script in public/index.html'); process.exitCode = 1; }
else compile(html.slice(scriptOpenEnd + 1, scriptEnd), 'legacy-pos-app.js');
if (process.exitCode) process.exit(process.exitCode);
