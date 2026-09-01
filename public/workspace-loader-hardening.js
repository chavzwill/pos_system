(()=>{'use strict';
const VERSION='20260825-1500';
const assets={
'sales-workspace':['/sales-workspace.css','/sales-workspace.js','TotalToolsSalesWorkspace'],
'quotations-workspace':['/quotations-workspace.css','/quotations-workspace.js','TotalToolsQuotationsWorkspace'],
'layaway-workspace':['/layaway-workspace.css','/layaway-workspace.js','TotalToolsLayawayWorkspace'],
'promotions-workspace':['/promotions-workspace.css','/promotions-workspace.js','TotalToolsPromotionsWorkspace'],
'held-sales-workspace':['/held-sales-workspace.css','/held-sales-workspace.js','TotalToolsHeldSalesWorkspace'],
'cashier-controls-workspace':['/cashier-controls-workspace.css','/cashier-controls-workspace.js','TotalToolsCashierControls'],
'customer-crm-workspace':['/customer-crm-workspace.css','/customer-crm-workspace.js','TotalToolsCustomerCrmWorkspace'],
'admin-workspace':['/admin-workspace.css','/admin-workspace.js','TotalToolsAdminWorkspace'],
'rbac-workspace':['/rbac-workspace.css','/rbac-workspace.js','TotalToolsRbacWorkspace'],
'settings-workspace':['/settings-workspace.css','/settings-workspace.js','TotalToolsSettingsWorkspace'],
'operational-reports':['/operational-reports.css','/operational-reports.js','TotalToolsOperationalReports'],
'transfers-workspace':['/transfers-workspace.css','/transfers-workspace.js','TotalToolsTransfersWorkspace'],
'work-orders-workspace':['/work-orders-workspace.css','/work-orders-workspace.js','TotalToolsWorkOrdersWorkspace'],
'inventory-workspace':['/inventory-workspace.css','/inventory-workspace.js','TotalToolsInventoryWorkspace'],
'purchasing-workspace':['/purchasing-workspace.css','/purchasing-workspace.js','TotalToolsPurchasingWorkspace'],
'rentals-workspace':['/rentals-workspace.css','/rentals-workspace.js','TotalToolsRentalsWorkspace'],
'repair-operations':['/repair-operations.css','/repair-operations.js','TotalToolsRepairOperations'],
'repair-communications':['/repair-communications.css','/repair-communications.js','TotalToolsRepairCommunications'],
'repair-authorizations':['/repair-authorizations.css','/repair-authorizations.js','TotalToolsRepairAuthorizations'],
'repair-parts-integrity':['/repair-parts-integrity.css','/repair-parts-integrity.js','TotalToolsRepairPartsIntegrity'],
'scheduling-intelligence':['/scheduling-intelligence.css','/scheduling-intelligence.js','TotalToolsSchedulingIntelligence'],
'repair-notifications':['/repair-notifications.css','/repair-notifications.js','TotalToolsRepairNotifications'],
'logistics-intelligence':['/logistics-intelligence.css','/logistics-intelligence.js','TotalToolsLogisticsIntelligence'],
'inventory-intelligence':['/inventory-intelligence.css','/inventory-intelligence.js','TotalToolsInventoryIntelligence'],
'stock-rebalancing':['/stock-rebalancing.css','/stock-rebalancing.js','TotalToolsSmartTransfers'],
'accounting-intelligence':['/accounting-intelligence.css','/accounting-intelligence.js','TotalToolsAccountingIntelligence'],
'accounting-ledger':['/accounting-ledger.css','/accounting-ledger.js','TotalToolsAccountingLedger'],
'supplier-ledger':['/supplier-ledger.css','/supplier-ledger.js','TotalToolsSupplierLedger'],
'settlement-reconciliation':['/settlement-reconciliation.css','/settlement-reconciliation.js','TotalToolsSettlementReconciliation'],
'financial-controls-intelligence':['/financial-controls-intelligence.css','/financial-controls-intelligence.js','TotalToolsFinancialControlsIntelligence']};
const loading=new Map();
function ensureCss(href){if([...document.styleSheets].some(x=>x.href&&x.href.includes(href)))return;const l=document.createElement('link');l.rel='stylesheet';l.href=`${href}?v=${VERSION}`;document.head.appendChild(l);}
function removeScripts(src){document.querySelectorAll('script[src]').forEach(s=>{try{if(new URL(s.src,location.href).pathname===src)s.remove();}catch(_){}});}
function loadScript(src,global,force=false){if(window[global]?.open)return Promise.resolve(window[global]);const key=src+'|'+global;if(!force&&loading.has(key))return loading.get(key);const p=new Promise((resolve,reject)=>{if(force)removeScripts(src);const id='shell-hardened-'+src.replace(/\W/g,'-');document.getElementById(id)?.remove();const s=document.createElement('script');s.id=id;s.async=true;s.src=`${src}?v=${VERSION}${force?'&retry='+Date.now():''}`;s.onload=()=>requestAnimationFrame(()=>window[global]?.open?resolve(window[global]):reject(new Error(`Module script loaded but ${global} was not registered.`)));s.onerror=()=>reject(new Error(`Unable to load ${src}`));document.body.appendChild(s);});loading.set(key,p);p.finally(()=>loading.delete(key));return p;}
async function openFeature(key,title='Workspace'){if(key==='legacy'){location.href='/legacy?from=shell&open='+encodeURIComponent(title);return true;}const a=assets[key];if(!a)throw new Error(`Unknown workspace module: ${key}`);const [css,js,global]=a;ensureCss(css);let api;try{api=await loadScript(js,global,false);}catch(first){api=await loadScript(js,global,true);}if(!api?.open)throw new Error(`${title} did not initialize after a clean reload.`);if(key==='customer-crm-workspace'&&/pipeline/i.test(title))await api.open({tab:'pipeline'});else await api.open();return true;}
window.TotalToolsShellOpen=openFeature;
window.TotalToolsWorkspaceLoader={open:openFeature,assets,version:VERSION};
// This is the single capture-phase owner of shell workspace buttons. Guided Mode
// calls TotalToolsShellOpen directly and therefore cannot race this handler.
document.addEventListener('click',e=>{const b=e.target.closest?.('#shell-root [data-open]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();openFeature(b.dataset.open,b.dataset.title||'Workspace').catch(err=>alert(`${b.dataset.title||'Workspace'} could not open: ${err.message}`));},true);
})();