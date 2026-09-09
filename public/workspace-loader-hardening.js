(()=>{'use strict';
const VERSION='20260909-refund-workflow-v2';
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
'financial-controls-intelligence':['/financial-controls-intelligence.css','/financial-controls-intelligence.js','TotalToolsFinancialControlsIntelligence'],
'operations-attention':['/operations-attention-center.css','/operations-attention-center.js','TotalToolsOperationsAttentionCenter'],
'drawer':['/cash-drawer-workspace.css','/cash-drawer-workspace.js','TotalToolsCashDrawerWorkspace'],
'commerce':['/ecommerce-operations-workspace.css','/ecommerce-operations-workspace.js','TotalToolsEcommerceOperations'],
'warehouse':['/warehouse-operations-workspace.css','/warehouse-operations-workspace.js','TotalToolsWarehouseOperations'],
'suppliers':['/suppliers-workspace.css','/suppliers-workspace.js','TotalToolsSuppliersWorkspace'],
'catalog':['/catalog-admin-workspace.css','/catalog-admin-workspace.js','TotalToolsCatalogAdmin'],
'ar':['/accounts-receivable-workspace.css','/accounts-receivable-workspace.js','TotalToolsAccountsReceivableWorkspace'],
'commissions':['/commissions-workspace.css','/commissions-workspace.js','TotalToolsCommissionsWorkspace'],
'integrations':['/integration-admin-workspace.css','/integration-admin-workspace.js','TotalToolsIntegrationAdmin'],
'denominations':['/denominations-workspace.css','/denominations-workspace.js','TotalToolsDenominationsWorkspace'],
'programs':['/customer-programs-workspace.css','/customer-programs-workspace.js','TotalToolsCustomerProgramsWorkspace'],
'technician-performance':['/technician-compensation.css','/technician-compensation.js','TotalToolsTechnicianCompensation'],
'technician-coaching':['/technician-coaching.css','/technician-coaching.js','TotalToolsTechnicianCoaching'],
'technician-management':['/technician-management-intelligence.css','/technician-management-intelligence.js','TotalToolsTechnicianManagementIntelligence']
};
const extras={
'logistics-intelligence':['/logistics-field-execution.js','/logistics-route-planning.js','/logistics-location-intelligence.js','/logistics-commercial-handoff.js'],
'rentals-workspace':['/rental-fleet-management.js','/rental-fleet-disposal.js','/rental-fleet-transfer.js'],
'purchasing-workspace':['/purchase-order-document-context.js'],
'held-sales-workspace':['/held-sales-recall-context.js']
};
const loading=new Map(),loadedExtras=new Set(),cssLoading=new Map();
function assetPath(url){try{return new URL(url,location.href).pathname}catch(_){return String(url||'')}}
function removeScripts(src){document.querySelectorAll('script[src]').forEach(s=>{if(assetPath(s.src)===src)s.remove();});}
function workspaceAuthorityLink(){return [...document.querySelectorAll('link[rel="stylesheet"]')].find(l=>assetPath(l.href)==='/total-tools-workspace-ui.css')||null;}
function insertWorkspaceCss(link){const authority=workspaceAuthorityLink();if(authority&&authority.parentNode===document.head)document.head.insertBefore(link,authority);else document.head.appendChild(link);}
function ensureCss(href,force=false){if(!force&&[...document.styleSheets].some(x=>x.href&&assetPath(x.href)===href))return Promise.resolve();if(!force&&cssLoading.has(href))return cssLoading.get(href);const p=new Promise((resolve,reject)=>{if(force)document.querySelectorAll('link[rel="stylesheet"]').forEach(l=>{if(assetPath(l.href)===href)l.remove();});const l=document.createElement('link');l.rel='stylesheet';l.href=`${href}?v=${VERSION}${force?'&retry='+Date.now():''}`;l.dataset.ttWorkspaceCss=href;const timer=setTimeout(()=>{l.remove();reject(new Error(`Timed out loading ${href}`));},8000);l.onload=()=>{clearTimeout(timer);resolve();};l.onerror=()=>{clearTimeout(timer);l.remove();reject(new Error(`Unable to load ${href}`));};insertWorkspaceCss(l);});cssLoading.set(href,p);p.then(()=>cssLoading.delete(href),()=>cssLoading.delete(href));return p;}
function loadRawScript(src){return new Promise((resolve,reject)=>{if(loadedExtras.has(src))return resolve();const s=document.createElement('script');s.async=false;s.src=`${src}?v=${VERSION}`;const timer=setTimeout(()=>{s.remove();reject(new Error(`Timed out loading ${src}`));},8000);s.onload=()=>{clearTimeout(timer);loadedExtras.add(src);resolve();};s.onerror=()=>{clearTimeout(timer);s.remove();reject(new Error(`Unable to load ${src}`));};document.body.appendChild(s);});}
function loadScript(src,global,force=false){if(window[global]?.open)return Promise.resolve(window[global]);const key=src+'|'+global;if(!force&&loading.has(key))return loading.get(key);const p=new Promise((resolve,reject)=>{if(force)removeScripts(src);const id='shell-hardened-'+src.replace(/\W/g,'-');document.getElementById(id)?.remove();const s=document.createElement('script');s.id=id;s.async=false;s.src=`${src}?v=${VERSION}${force?'&retry='+Date.now():''}`;const timer=setTimeout(()=>{s.remove();reject(new Error(`${global} timed out while loading.`));},10000);s.onload=()=>{clearTimeout(timer);requestAnimationFrame(()=>window[global]?.open?resolve(window[global]):reject(new Error(`Module script loaded but ${global} was not registered.`)));};s.onerror=()=>{clearTimeout(timer);s.remove();reject(new Error(`Unable to load ${src}`));};document.body.appendChild(s);});loading.set(key,p);p.then(()=>loading.delete(key),()=>loading.delete(key));return p;}
async function loadExtras(key){for(const src of extras[key]||[]){try{await loadRawScript(src);}catch(error){console.warn('Optional workspace enhancer did not load',src,error);}}}
function recovery(title,error,retry){document.getElementById('tt-workspace-load-error')?.remove();const host=document.createElement('div');host.id='tt-workspace-load-error';host.className='tt-workspace-load-error';host.innerHTML=`<section role="alertdialog" aria-modal="true" aria-labelledby="tt-workspace-error-title"><span>Workspace recovery</span><h2 id="tt-workspace-error-title"></h2><p></p><div><button type="button" data-retry>Retry workspace</button><button type="button" data-close>Return to dashboard</button></div><small>No business action has been retried automatically.</small></section>`;host.querySelector('h2').textContent=`${title} could not open`;host.querySelector('p').textContent=error?.message||'The workspace failed to initialize.';host.querySelector('[data-close]').onclick=()=>host.remove();host.querySelector('[data-retry]').onclick=()=>{host.remove();retry();};document.body.appendChild(host);host.querySelector('[data-retry]')?.focus();}
function dispatchHealth(detail){window.dispatchEvent(new CustomEvent('tt:workspace-health',{detail}));}
function openOptions(key,title){if(key==='customer-crm-workspace'&&/pipeline/i.test(title))return{tab:'pipeline'};if(key==='programs')return{tab:(window.__TT_WORKSPACE_PROFILE__?.permissions||{})['discount-cards']?'discount':'cashback'};if(key==='technician-performance')return{tab:'performance'};return null;}
async function openFeature(key,title='Workspace'){if(key==='legacy'){location.href='/legacy?from=shell&open='+encodeURIComponent(title);return true;}const a=assets[key];if(!a)throw new Error(`Unknown workspace module: ${key}`);const[css,js,global]=a;dispatchHealth({key,title,state:'loading',at:Date.now()});let api;try{await ensureCss(css,false);api=await loadScript(js,global,false);}catch(first){console.warn('Workspace first load failed; retrying cleanly',key,first);await ensureCss(css,true);api=await loadScript(js,global,true);}if(!api?.open)throw new Error(`${title} did not initialize after a clean reload.`);try{const options=openOptions(key,title);if(options)await api.open(options);else await api.open();}catch(error){dispatchHealth({key,title,state:'failed',message:error?.message||String(error),at:Date.now()});throw error;}document.documentElement.dataset.ttActiveWorkspace=key;dispatchHealth({key,title,state:'open',at:Date.now()});void loadExtras(key);return true;}
async function probe(url){try{const r=await fetch(`${url}?v=${VERSION}`,{method:'HEAD',credentials:'same-origin',cache:'no-store'});return{url,ok:r.ok,status:r.status};}catch(error){return{url,ok:false,status:0,error:error?.message||String(error)}}}
async function certify(){const unique=[...new Set(Object.values(assets).flatMap(([css,js])=>[css,js]).concat(Object.values(extras).flat()))];const results=[];for(const url of unique)results.push(await probe(url));const failed=results.filter(x=>!x.ok);const report={ok:failed.length===0,checked:results.length,failed,results,at:new Date().toISOString()};dispatchHealth({state:'certification',...report});return report;}
window.TotalToolsShellOpen=openFeature;window.TotalToolsWorkspaceLoader={open:openFeature,assets,extras,certify,version:VERSION};
document.addEventListener('click',e=>{const b=e.target.closest?.('#shell-root [data-open]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();const key=b.dataset.open,title=b.dataset.title||'Workspace';if(b.dataset.ttOpening==='1')return;b.dataset.ttOpening='1';b.disabled=true;openFeature(key,title).catch(err=>recovery(title,err,()=>openFeature(key,title).catch(error=>recovery(title,error,()=>location.reload())))).then(()=>{delete b.dataset.ttOpening;b.disabled=false;},()=>{delete b.dataset.ttOpening;b.disabled=false;});},true);
})();