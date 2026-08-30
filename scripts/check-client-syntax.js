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
  'app-shell.js','shell-deferred.js','workspace-loader-hardening.js','total-tools-identity.js','reports-shell-bridge.js','customer-programs-shell-bridge.js','customer-programs-workspace.js','warehouse-shell-bridge.js','warehouse-operations-workspace.js','cash-drawer-shell-bridge.js','cash-drawer-workspace.js','accounts-receivable-shell-bridge.js','accounts-receivable-workspace.js','commissions-shell-bridge.js','commissions-workspace.js','ecommerce-operations-shell-bridge.js','ecommerce-operations-workspace.js','integration-admin-shell-bridge.js','integration-admin-workspace.js','suppliers-shell-bridge.js','suppliers-workspace.js','catalog-admin-shell-bridge.js','catalog-admin-workspace.js','denominations-shell-bridge.js','denominations-workspace.js','settings-workspace.js','quotations-workspace.js','layaway-workspace.js','promotions-workspace.js','sales-workspace.js','pos-margin-override-ui.js','pos-uom-barcode-scanner.js','held-sales-workspace.js','held-sales-recall-context.js','cashier-controls-workspace.js','customer-crm-workspace.js','admin-workspace.js','rbac-workspace.js','transfers-workspace.js','work-orders-workspace.js','service-concessions-ui.js','service-refunds-ui.js','inventory-workspace.js','purchasing-workspace.js','rentals-workspace.js','rental-fleet-management.js','rental-fleet-disposal.js','rental-fleet-transfer.js','logistics-commercial-handoff.js','logistics-field-execution.js','logistics-route-planning.js','logistics-location-intelligence.js','uom-commercial-experience.js','client-diagnostics.js','pos-guide-map.js','guided-mode.js','guided-mode-orchestrator.js','guided-mode-access.js','purchase-order-document-context.js','held-sales-recall-context.js','guided-mode-completion.js','guided-mode-role-context.js','guided-mode-record-context.js','guided-mode-exact-action.js','guided-mode-exact-fallback.js','guided-mode-hardening.js','guided-mode-integrity.js','guided-mode-adversarial.js','guided-mode-qa.js','technician-compensation.js','stock-rebalancing.js','operational-reports.js','repair-operations.js','repair-communications.js','repair-notifications.js','repair-authorizations.js','repair-parts-integrity.js','inventory-intelligence.js','logistics-intelligence.js','scheduling-intelligence.js','accounting-intelligence.js','financial-controls-intelligence.js','supplier-ledger.js','settlement-reconciliation.js','accounting-ledger.js','pos-upgrade-navigation.js','navigation-shell.js','role-workspace.js','employee-workspace-home.js','login-controller.js',
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
require('./check-logistics-commercial-handoff-contract');
require('./check-logistics-field-execution-contract');
require('./check-logistics-route-planning-contract');
require('./check-logistics-route-execution-contract');
require('./check-logistics-location-intelligence-contract');
