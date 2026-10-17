(()=>{'use strict';
const VERSION='20260923-1040';
const assets={
'receiving-workspace':['/ui-workspaces.css','/purchase-fast-receiving.js','TotalToolsFastReceiving'],
'sales-workspace':['/ui-workspaces.css?v=20261017-design','/sales-workspace.js','TotalToolsSalesWorkspace'],
'quotations-workspace':['/ui-workspaces.css?v=20261017-design','/quotations-workspace.js','TotalToolsQuotationsWorkspace'],
'layaway-workspace':['/ui-workspaces.css?v=20261017-design','/layaway-workspace.js','TotalToolsLayawayWorkspace'],
'promotions-workspace':['/ui-workspaces.css?v=20261017-design','/promotions-workspace.js','TotalToolsPromotionsWorkspace'],
'held-sales-workspace':['/ui-workspaces.css?v=20261017-design','/held-sales-workspace.js','TotalToolsHeldSalesWorkspace'],
'cashier-controls-workspace':['/ui-workspaces.css?v=20261017-design','/cashier-controls-workspace.js','TotalToolsCashierControls'],
'customer-crm-workspace':['/ui-workspaces.css?v=20261017-design','/customer-crm-workspace.js','TotalToolsCustomerCrmWorkspace'],
'admin-workspace':['/ui-workspaces.css?v=20261017-design','/admin-workspace.js','TotalToolsAdminWorkspace'],
'rbac-workspace':['/ui-workspaces.css?v=20261017-design','/rbac-workspace.js','TotalToolsRbacWorkspace'],
'settings-workspace':['/ui-workspaces.css?v=20261017-design','/settings-workspace.js','TotalToolsSettingsWorkspace'],
'operational-reports':['/ui-workspaces.css?v=20261017-design','/operational-reports.js','TotalToolsOperationalReports'],
'transfers-workspace':['/ui-workspaces.css?v=20261017-design','/transfers-workspace.js','TotalToolsTransfersWorkspace'],
'work-orders-workspace':['/ui-workspaces.css?v=20261017-design','/work-orders-workspace.js','TotalToolsWorkOrdersWorkspace'],
'inventory-workspace':['/ui-workspaces.css?v=20261017-design','/inventory-workspace.js','TotalToolsInventoryWorkspace'],
'warehouse-operations':['/ui-workspaces.css?v=20261017-design','/warehouse-operations-workspace.js','TotalToolsWarehouseOperations'],
'catalog-admin-workspace':['/ui-workspaces.css?v=20261017-design','/catalog-admin-workspace.js','TotalToolsCatalogAdmin'],
'purchasing-workspace':['/ui-workspaces.css?v=20261017-design','/purchasing-workspace.js','TotalToolsPurchasingWorkspace'],
'suppliers-workspace':['/ui-workspaces.css?v=20261017-design','/suppliers-workspace.js','TotalToolsSuppliersWorkspace'],
'rentals-workspace':['/ui-workspaces.css?v=20261017-design','/rentals-workspace.js','TotalToolsRentalsWorkspace'],
'repair-operations':['/ui-workspaces.css?v=20261017-design','/repair-operations.js','TotalToolsRepairOperations'],
'repair-communications':['/ui-workspaces.css?v=20261017-design','/repair-communications.js','TotalToolsRepairCommunications'],
'repair-authorizations':['/ui-workspaces.css?v=20261017-design','/repair-authorizations.js','TotalToolsRepairAuthorizations'],
'repair-parts-integrity':['/ui-workspaces.css?v=20261017-design','/repair-parts-integrity.js','TotalToolsRepairPartsIntegrity'],
'scheduling-intelligence':['/ui-workspaces.css?v=20261017-design','/scheduling-intelligence.js','TotalToolsSchedulingIntelligence'],
'repair-notifications':['/ui-workspaces.css?v=20261017-design','/repair-notifications.js','TotalToolsRepairNotifications'],
'logistics-intelligence':['/ui-workspaces.css?v=20261017-design','/logistics-intelligence.js','TotalToolsLogisticsIntelligence'],
'inventory-intelligence':['/ui-workspaces.css?v=20261017-design','/inventory-intelligence.js','TotalToolsInventoryIntelligence'],
'stock-rebalancing':['/ui-workspaces.css?v=20261017-design','/stock-rebalancing.js','TotalToolsSmartTransfers'],
'accounting-intelligence':['/ui-workspaces.css?v=20261017-design','/accounting-intelligence.js','TotalToolsAccountingIntelligence'],
'accounting-ledger':['/ui-workspaces.css?v=20261017-design','/accounting-ledger.js','TotalToolsAccountingLedger'],
'supplier-ledger':['/ui-workspaces.css?v=20261017-design','/supplier-ledger.js','TotalToolsSupplierLedger'],
'settlement-reconciliation':['/ui-workspaces.css?v=20261017-design','/settlement-reconciliation.js','TotalToolsSettlementReconciliation'],
'financial-controls-intelligence':['/ui-workspaces.css?v=20261017-design','/financial-controls-intelligence.js','TotalToolsFinancialControlsIntelligence']};
const loading=new Map();
function ensureCss(href){if([...document.styleSheets].some(x=>x.href&&x.href.includes(href)))return;const l=document.createElement('link');l.rel='stylesheet';l.href=`${href}?v=${VERSION}`;document.head.appendChild(l);}
function removeScripts(src){document.querySelectorAll('script[src]').forEach(s=>{try{if(new URL(s.src,location.href).pathname===src)s.remove();}catch(_){}});}
function loadScript(src,global,force=false){if(window[global]?.open)return Promise.resolve(window[global]);const key=src+'|'+global;if(!force&&loading.has(key))return loading.get(key);const p=new Promise((resolve,reject)=>{if(force)removeScripts(src);const id='shell-hardened-'+src.replace(/\W/g,'-');document.getElementById(id)?.remove();const s=document.createElement('script');s.id=id;s.async=true;s.src=`${src}?v=${VERSION}${force?'&retry='+Date.now():''}`;s.onload=()=>requestAnimationFrame(()=>window[global]?.open?resolve(window[global]):reject(new Error(`Module script loaded but ${global} was not registered.`)));s.onerror=()=>reject(new Error(`Unable to load ${src}`));document.body.appendChild(s);});loading.set(key,p);p.finally(()=>loading.delete(key));return p;}
async function openFeature(key,title='Workspace',options={}){if(key==='legacy'){location.href='/legacy?from=shell&open='+encodeURIComponent(title);return true;}if(key==='purchasing-workspace'){if(/request/i.test(title||''))options={...options,tab:'pr'};else if(/order|receiv/i.test(title||''))options={...options,tab:'po'}}if(key==='admin-workspace'&&/branch/i.test(title||''))options={...options,tab:'branches'};const a=assets[key];if(!a)throw new Error(`Unknown workspace module: ${key}`);const [css,js,global]=a;ensureCss(css);let api;try{api=await loadScript(js,global,false);}catch(first){api=await loadScript(js,global,true);}if(!api?.open)throw new Error(`${title} did not initialize after a clean reload.`);if(key==='customer-crm-workspace'&&/pipeline/i.test(title))options={...options,tab:'pipeline'};return window.TotalToolsPresentation.mount(key,title,api,options||{});}
window.TotalToolsShellOpen=openFeature;
window.TotalToolsWorkspaceLoader={open:openFeature,assets,version:VERSION};
// This is the single capture-phase owner of shell workspace buttons. Guide Me
// calls TotalToolsShellOpen directly and therefore cannot race this handler.
document.addEventListener('click',e=>{const b=e.target.closest?.('#shell-root [data-open]');if(!b||b.closest('[data-tt-workspace]'))return;e.preventDefault();e.stopImmediatePropagation();openFeature(b.dataset.open,b.dataset.title||'Workspace').catch(err=>{const message=`${b.dataset.title||'Workspace'} could not open: ${err.message}`;if(window.TotalToolsShellUI?.toast)window.TotalToolsShellUI.toast(message,'error');else console.error(message);});},true);
})();