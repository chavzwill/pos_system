(()=>{'use strict';
const VERSION='20260825-1445';
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
function loadScript(src,global,force=false){if(window[global]?.open)return Promise.resolve(window[global]);const key=src+'|'+global;if(!force&&loading.has(key))return loading.get(key);const p=new Promise((resolve,reject)=>{const id='shell-hardened-'+src.replace(/\W/g,'-');const stale=document.getElementById(id);if(stale)stale.remove();if(force){document.querySelectorAll(`script[src^="${src}?"]`).forEach(s=>s.remove());}
 const s=document.createElement('script');s.id=id;s.async=true;s.src=`${src}?v=${VERSION}${force?'&retry='+Date.now():''}`;s.onload=()=>{setTimeout(()=>window[global]?.open?resolve(window[global]):reject(new Error(`Module script loaded but ${global} was not registered.`)),0);};s.onerror=()=>reject(new Error(`Unable to load ${src}`));document.body.appendChild(s);});loading.set(key,p);p.finally(()=>loading.delete(key));return p;}
async function openFeature(key,title='Workspace'){if(key==='legacy'){location.href='/legacy?from=shell&open='+encodeURIComponent(title);return true;}const a=assets[key];if(!a)throw new Error('Unknown workspace module.');const [css,js,global]=a;ensureCss(css);let api;try{api=await loadScript(js,global,false);}catch(first){api=await loadScript(js,global,true);}if(!api?.open)throw new Error('Workspace module did not initialize after a clean reload.');if(key==='customer-crm-workspace'&&/pipeline/i.test(title))await api.open({tab:'pipeline'});else await api.open();return true;}
window.TotalToolsShellOpen=openFeature;
// Capture shell module buttons before the older loader can consume the click.
document.addEventListener('click',e=>{const b=e.target.closest?.('#shell-root [data-open]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();openFeature(b.dataset.open,b.dataset.title||'Workspace').catch(err=>alert(`${b.dataset.title||'Workspace'} could not open: ${err.message}`));},true);
// Guided Mode must not move past a navigation step until its workspace actually opens.
const taskWorkspace={
 'Complete a sale':['sales-workspace','#tt-sales-workspace','Point of Sale'],
 'Hold or recall a sale':['sales-workspace','#tt-sales-workspace','Point of Sale'],
 'Return or refund a transaction':['cashier-controls-workspace','#tt-cashier-controls','Returns, Voids & Receipt Evidence'],
 'Create or work a repair':['work-orders-workspace','#tt-work-orders-workspace','Work Orders'],
 'Create or manage a rental':['rentals-workspace','#tt-rentals-workspace','Rental Operations'],
 'Dispatch, route or complete a delivery':['logistics-intelligence','#tt-logistics-intelligence','Dispatch Command Center'],
 'Adjust inventory':['inventory-workspace','#tt-inventory-workspace','Inventory Operations'],
 'Create or approve a purchase request':['purchasing-workspace','#tt-purchasing-workspace','Purchasing Operations'],
 'Create, edit, copy, cancel or receive a PO':['purchasing-workspace','#tt-purchasing-workspace','Purchasing Operations'],
 'Create, dispatch or receive a branch transfer':['transfers-workspace','#tt-transfers-workspace','Inter-Branch Transfers'],
 'Create or manage a quotation':['quotations-workspace','#tt-quotes','Quotes & Estimates'],
 'Run, export or print a report':['operational-reports','#tt-operational-reports','Reports']
};
let guideOpening=false;
document.addEventListener('click',async e=>{const next=e.target.closest?.('#tt-guided-mode [data-guide-next]');if(!next||guideOpening)return;const g=document.getElementById('tt-guided-mode');const step=(g?.querySelector('.tt-guide__step-count')?.textContent||'').trim();if(!/^step\s+1\s+of\s+/i.test(step))return;const task=(g?.querySelector('.tt-guide__head p')?.textContent||'').trim();const cfg=taskWorkspace[task];if(!cfg||document.querySelector(cfg[1]))return;e.preventDefault();e.stopImmediatePropagation();guideOpening=true;next.disabled=true;const old=next.textContent;next.textContent='Opening…';try{await openFeature(cfg[0],cfg[2]);await new Promise(r=>setTimeout(r,80));if(!document.querySelector(cfg[1]))throw new Error('The required workspace did not become available.');next.disabled=false;next.textContent=old;next.click();}catch(err){next.disabled=false;next.textContent=old;window.TotalToolsGuidedModeIntegrity?.pause?.(`Guided Mode could not open ${cfg[2]}. ${err.message}`);alert(`${cfg[2]} could not open: ${err.message}`);}finally{guideOpening=false;}},true);
})();