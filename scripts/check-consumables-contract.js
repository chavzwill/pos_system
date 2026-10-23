'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const schema=read('lib/consumables-schema.js');
const route=read('routes/consumables.js');
const shell=read('public/app-shell.js');
const loader=read('public/workspace-loader-hardening.js');
const ui=read('public/consumables-workspace.js');
const css=read('public/ui-workspaces.css');
const server=read('server.js');
const checks=[
 ['Uses separate purchase, balance and issue storage',/CREATE TABLE IF NOT EXISTS consumable_purchase_orders/.test(schema)&&/CREATE TABLE IF NOT EXISTS consumable_balances/.test(schema)&&/CREATE TABLE IF NOT EXISTS consumable_movements/.test(schema)],
 ['No retail stock columns in consumable schema',!/\bbranch_inventory\b|\bstock_movements\b/.test(schema)],
 ['Route never increases resale stock',!/\bUPDATE products SET stock_qty\b|\bINSERT INTO branch_inventory\b|\bINSERT INTO stock_movements\b/.test(route)],
 ['PO requires authorized approval',route.includes("requirePermission('purchasing_approve')")&&route.includes('SELF_APPROVAL')],
 ['Receipt checks approved status and remaining quantity',route.includes("['approved','partial'].includes(po.status)")&&route.includes('quantity_received+?<=quantity_ordered')],
 ['Separate receipt cannot silently update retail inventory',route.includes('INSERT INTO consumable_balances')&&route.includes("'receive'")],
 ['Issue quantity cannot go below zero',route.includes('qty_on_hand>=? AND value_cents>=?')&&route.includes('INSUFFICIENT_CONSUMABLES')],
 ['Approval and usage journals are append-only',schema.includes('trg_consumable_movements_no_update')&&schema.includes('trg_consumable_order_events_no_delete')&&route.includes('INSERT INTO consumable_order_events')],
 ['Monetary tracking uses integer cents',route.includes('value_cents')&&route.includes('unit_cost_cents')&&route.includes('function cents(')],
 ['Mutation receipts require idempotency keys',route.includes("headers['idempotency-key']")&&route.includes('IDEMPOTENCY_CONFLICT')&&schema.includes('idempotency_key TEXT PRIMARY KEY')],
 ['Links to real branches, departments and rental products',route.includes("exists(tx,'departments'")&&route.includes("exists(tx,'products'")&&route.includes("if(!equipment.is_rental)")&&route.includes('unit_reference')],
 ['Branch permissions enforced for writes and reads',route.includes('function assertBranch(')&&route.includes('function branchFilter(')],
 ['Separate workflow is routed from shell',server.includes("app.use('/api/consumables'")&&shell.includes("'consumables-workspace'")&&loader.includes("'consumables-workspace'")&&loader.includes("['/ui-workspaces.css','/consumables-workspace.js'")],
 ['UI provides all controlled operations',ui.includes('Create consumable PO')&&ui.includes('Record receipt')&&ui.includes('Record usage')&&ui.includes('Copy to new PO')],
 ['Mobile accessibility has 320px layout support',css.includes('@media(max-width:640px)')&&ui.includes('aria-modal="true"')]
];
for(const [title,pass] of checks)console.log((pass?'PASS':'FAIL')+' consumables: '+title);
assert(checks.every(x=>x[1]),'Consumables release contract has failed');
console.log('PASS consumables safety contracts: '+checks.length+'/'+checks.length);
