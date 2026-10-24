(()=>{'use strict';
const VERSION='20261024-dispatch-board1';
const assets={
'receiving-workspace':['/ui-workspaces.css','/purchase-fast-receiving.js','TotalToolsFastReceiving'],
'sales-workspace':['/ui-workspaces.css','/sales-workspace.js','TotalToolsSalesWorkspace'],
'quotations-workspace':['/ui-workspaces.css','/quotations-workspace.js','TotalToolsQuotationsWorkspace'],
'layaway-workspace':['/ui-workspaces.css','/layaway-workspace.js','TotalToolsLayawayWorkspace'],
'promotions-workspace':['/ui-workspaces.css','/promotions-workspace.js','TotalToolsPromotionsWorkspace'],
'held-sales-workspace':['/ui-workspaces.css','/held-sales-workspace.js','TotalToolsHeldSalesWorkspace'],
'cashier-controls-workspace':['/ui-workspaces.css','/cashier-controls-workspace.js','TotalToolsCashierControls'],
'customer-crm-workspace':['/ui-workspaces.css','/customer-crm-workspace.js','TotalToolsCustomerCrmWorkspace'],
'admin-workspace':['/ui-workspaces.css','/admin-workspace.js','TotalToolsAdminWorkspace'],
'rbac-workspace':['/ui-workspaces.css','/rbac-workspace.js','TotalToolsRbacWorkspace'],
'settings-workspace':['/ui-workspaces.css','/settings-workspace.js','TotalToolsSettingsWorkspace'],
'operational-reports':['/ui-workspaces.css','/operational-reports.js','TotalToolsOperationalReports'],
'transfers-workspace':['/ui-workspaces.css','/transfers-workspace.js','TotalToolsTransfersWorkspace'],
'work-orders-workspace':['/ui-workspaces.css','/work-orders-workspace.js','TotalToolsWorkOrdersWorkspace'],
'inventory-workspace':['/ui-workspaces.css','/inventory-workspace.js','TotalToolsInventoryWorkspace'],
'warehouse-operations':['/ui-workspaces.css','/warehouse-operations-workspace.js','TotalToolsWarehouseOperations'],
'catalog-admin-workspace':['/ui-workspaces.css','/catalog-admin-workspace.js','TotalToolsCatalogAdmin'],
'purchasing-workspace':['/ui-workspaces.css','/purchasing-workspace.js','TotalToolsPurchasingWorkspace'],
'consumables-workspace':['/ui-workspaces.css','/consumables-workspace.js','TotalToolsConsumablesWorkspace'],
'suppliers-workspace':['/ui-workspaces.css','/suppliers-workspace.js','TotalToolsSuppliersWorkspace'],
'rentals-workspace':['/ui-workspaces.css','/rentals-workspace.js','TotalToolsRentalsWorkspace'],
'repair-operations':['/ui-workspaces.css','/repair-operations.js','TotalToolsRepairOperations'],
'repair-communications':['/ui-workspaces.css','/repair-communications.js','TotalToolsRepairCommunications'],
'repair-authorizations':['/ui-workspaces.css','/repair-authorizations.js','TotalToolsRepairAuthorizations'],
'repair-parts-integrity':['/ui-workspaces.css','/repair-parts-integrity.js','TotalToolsRepairPartsIntegrity'],
'scheduling-intelligence':['/ui-workspaces.css','/scheduling-intelligence.js','TotalToolsSchedulingIntelligence'],
'repair-notifications':['/ui-workspaces.css','/repair-notifications.js','TotalToolsRepairNotifications'],
'logistics-intelligence':['/ui-workspaces.css','/logistics-intelligence.js','TotalToolsLogisticsIntelligence'],
'inventory-intelligence':['/ui-workspaces.css','/inventory-intelligence.js','TotalToolsInventoryIntelligence'],
'stock-rebalancing':['/ui-workspaces.css','/stock-rebalancing.js','TotalToolsSmartTransfers'],
'accounting-intelligence':['/ui-workspaces.css','/accounting-intelligence.js','TotalToolsAccountingIntelligence'],
'accounting-ledger':['/ui-workspaces.css','/accounting-ledger.js','TotalToolsAccountingLedger'],
'supplier-ledger':['/ui-workspaces.css','/supplier-ledger.js','TotalToolsSupplierLedger'],
'settlement-reconciliation':['/ui-workspaces.css','/settlement-reconciliation.js','TotalToolsSettlementReconciliation'],
'financial-controls-intelligence':['/ui-workspaces.css','/financial-controls-intelligence.js','TotalToolsFinancialControlsIntelligence']};
const loading=new Map();
function ensureCss(href){if([...document.styleSheets].some(x=>x.href&&x.href.includes(href)))return;const l=document.createElement('link');l.rel='stylesheet';l.href=`${href}?v=${VERSION}`;document.head.appendChild(l);}
function removeScripts(src){document.querySelectorAll('script[src]').forEach(s=>{try{if(new URL(s.src,location.href).pathname===src)s.remove();}catch(_){}});}
function loadScript(src,global,force=false){if(window[global]?.open)return Promise.resolve(window[global]);const key=src+'|'+global;if(!force&&loading.has(key))return loading.get(key);const p=new Promise((resolve,reject)=>{if(force)removeScripts(src);const id='shell-hardened-'+src.replace(/\W/g,'-');document.getElementById(id)?.remove();const s=document.createElement('script');s.id=id;s.async=true;s.src=`${src}?v=${VERSION}${force?'&retry='+Date.now():''}`;s.onload=()=>requestAnimationFrame(()=>window[global]?.open?resolve(window[global]):reject(new Error(`Module script loaded but ${global} was not registered.`)));s.onerror=()=>reject(new Error(`Unable to load ${src}`));document.body.appendChild(s);});loading.set(key,p);p.finally(()=>loading.delete(key));return p;}
function purchasingIntent(title,options={}){const t=String(title||'').trim();if(/^create purchase request$/i.test(t))return{...options,tab:'pr',create:'pr'};if(/^create purchase order$/i.test(t))return{...options,tab:'po',create:'po'};if(/request/i.test(t))return{...options,tab:'pr'};if(/order|receiv/i.test(t))return{...options,tab:'po'};return options;}
async function openFeature(key,title='Workspace',options={}){if(key==='legacy'){location.href='/legacy?from=shell&open='+encodeURIComponent(title);return true;}if(key==='purchasing-workspace')options=purchasingIntent(title,options);if(key==='admin-workspace'&&/branch/i.test(title||''))options={...options,tab:'branches'};const a=assets[key];if(!a)throw new Error(`Unknown workspace module: ${key}`);const [css,js,global]=a;ensureCss(css);let api;try{api=await loadScript(js,global,false);}catch(first){api=await loadScript(js,global,true);}if(!api?.open)throw new Error(`${title} did not initialize after a clean reload.`);if(key==='customer-crm-workspace'&&/pipeline/i.test(title))options={...options,tab:'pipeline'};return window.TotalToolsPresentation.mount(key,title,api,options||{});}
window.TotalToolsShellOpen=openFeature;
window.TotalToolsWorkspaceLoader={open:openFeature,assets,version:VERSION};
// This is the single capture-phase owner of shell workspace buttons. Guide Me
// calls TotalToolsShellOpen directly and therefore cannot race this handler.
document.addEventListener('click',e=>{const b=e.target.closest?.('#shell-root [data-open]');if(!b||b.closest('[data-tt-workspace]'))return;e.preventDefault();e.stopImmediatePropagation();openFeature(b.dataset.open,b.dataset.title||'Workspace').catch(err=>{const message=`${b.dataset.title||'Workspace'} could not open: ${err.message}`;if(window.TotalToolsShellUI?.toast)window.TotalToolsShellUI.toast(message,'error');else console.error(message);});},true);
})();