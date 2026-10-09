'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let failed=0;
const check=(name,pass)=>pass?console.log('PASS Authoritative UI:',name):(failed++,console.error('FAIL Authoritative UI:',name));

const authority=read('public/unified-ui-system.css');
const shellCss=read('public/app-shell.css');
const salesCss=read('public/sales-workspace.css');
const salesJs=read('public/sales-workspace.js');
const inventoryJs=read('public/inventory-workspace.js');
const inventoryCss=read('public/inventory-workspace.css');
const inventoryIntelligenceJs=read('public/inventory-intelligence.js');
const inventoryIntelligenceCss=read('public/inventory-intelligence.css');
const supplierLedgerJs=read('public/supplier-ledger.js');
const supplierLedgerCss=read('public/supplier-ledger.css');
const accountingLedgerJs=read('public/accounting-ledger.js');
const accountingLedgerCss=read('public/accounting-ledger.css');
const purchasingJs=read('public/purchasing-workspace.js');
const workOrdersJs=read('public/work-orders-workspace.js');
const workOrdersCss=read('public/work-orders-workspace.css');
const rentalsJs=read('public/rentals-workspace.js');
const rentalsCss=read('public/rentals-workspace.css');
const rentalFleetJs=read('public/rental-fleet-management.js');
const customerCrmJs=read('public/customer-crm-workspace.js');
const customerCrmCss=read('public/customer-crm-workspace.css');
const accountingJs=read('public/accounting-intelligence.js');
const accountingCss=read('public/accounting-intelligence.css');
const logisticsJs=read('public/logistics-intelligence.js');
const logisticsCss=read('public/logistics-intelligence.css');
const logisticsFieldJs=read('public/logistics-field-execution.js');
const logisticsLocationJs=read('public/logistics-location-intelligence.js');
const heldSalesJs=read('public/held-sales-workspace.js');
const heldSalesCss=read('public/held-sales-workspace.css');
const quotationsJs=read('public/quotations-workspace.js');
const quotationsCss=read('public/quotations-workspace.css');
const warehouseJs=read('public/warehouse-operations-workspace.js');
const warehouseCss=read('public/warehouse-operations-workspace.css');
const nativeSupportJs=read('public/shell-native-support.js');
const shellDeferredJs=read('public/shell-deferred.js');
const loaderHardeningSource=read('public/workspace-loader-hardening.js');
const operationalReportsJs=read('public/operational-reports.js');
const operationalReportsCss=read('public/operational-reports.css');
const denominationsJs=read('public/denominations-workspace.js');
const denominationsCss=read('public/denominations-workspace.css');
const settingsJs=read('public/settings-workspace.js');
const settingsCss=read('public/settings-workspace.css');
const guidedModeJs=read('public/guided-mode.js');
const guidedAccessJs=read('public/guided-mode-access.js');
const guidedHardeningJs=read('public/guided-mode-hardening.js');
const guidedExactJs=read('public/guided-mode-exact-action.js');
const accountsReceivableJs=read('public/accounts-receivable-workspace.js');
const accountsReceivableCss=read('public/accounts-receivable-workspace.css');
const catalogAdminJs=read('public/catalog-admin-workspace.js');
const catalogAdminCss=read('public/catalog-admin-workspace.css');
const technicianCompJs=read('public/technician-compensation.js');
const technicianCompCss=read('public/technician-compensation.css');
const technicianMgmtJs=read('public/technician-management-intelligence.js');
const technicianMgmtCss=read('public/technician-management-intelligence.css');
const commissionsJs=read('public/commissions-workspace.js');
const commissionsCss=read('public/commissions-workspace.css');
const integrationAdminJs=read('public/integration-admin-workspace.js');
const integrationAdminCss=read('public/integration-admin-workspace.css');
const customerProgramsJs=read('public/customer-programs-workspace.js');
const customerProgramsCss=read('public/customer-programs-workspace.css');
const ecommerceJs=read('public/ecommerce-operations-workspace.js');
const ecommerceCss=read('public/ecommerce-operations-workspace.css');
const promotionsJs=read('public/promotions-workspace.js');
const promotionsCss=read('public/promotions-workspace.css');
const financialControlsJs=read('public/financial-controls-intelligence.js');
const financialControlsCss=read('public/financial-controls-intelligence.css');
const settlementJs=read('public/settlement-reconciliation.js');
const settlementCss=read('public/settlement-reconciliation.css');
const cashierControlsJs=read('public/cashier-controls-workspace.js');
const cashierControlsCss=read('public/cashier-controls-workspace.css');
const adminJs=read('public/admin-workspace.js');
const adminCss=read('public/admin-workspace.css');
const attentionJs=read('public/operations-attention-center.js');
const attentionCss=read('public/operations-attention-center.css');
const purchasingCss=read('public/purchasing-workspace.css');
const suppliersJs=read('public/suppliers-workspace.js');
const suppliersCss=read('public/suppliers-workspace.css');
const transfersJs=read('public/transfers-workspace.js');
const transfersCss=read('public/transfers-workspace.css');
const loaderHardeningJs=read('public/workspace-loader-hardening.js');
const layawayJs=read('public/layaway-workspace.js');
const repairAuthorizationsJs=read('public/repair-authorizations.js');
const repairPartsJs=read('public/repair-parts-integrity.js');
const routePlanningJs=read('public/logistics-route-planning.js');
const departmentApprovalsJs=read('public/department-approvals-ui.js');
const catalogWorkflowJs=read('public/catalog-workflow-enhancer.js');
const secondaryReadableCss=['repair-communications.css','repair-parts-integrity.css','repair-notifications.css','layaway-workspace.css','scheduling-intelligence.css','purchase-order-document-context.css','repair-authorizations.css','technician-coaching.css','rbac-workspace.css','stock-rebalancing.css','repair-operations.css','employee-learning-center.css','total-tools-identity.css','guided-mode-efficiency.css','guided-mode-qa.css','guided-mode-final-pass.css'].map(f=>[f,read('public/'+f)]);
const shellHtml=read('public/app-shell.html');
const shellJs=read('public/app-shell.js');
const legacy=read('public/index.html');
const manual=read('public/manual.html');
const manualCss=read('public/manual-ui-v2.css');
const preview=read('public/preview.html');
const previewCss=read('public/preview-ui-v2.css');
const pkg=read('package.json');
const server=read('server.js');
const assetKeys=src=>{const m=src.match(/const assets=\{([\s\S]*?)\};/);return m?[...m[1].matchAll(/'([^']+)'\s*:/g)].map(x=>x[1]):[];};
const activeJsSources=[shellHtml,shellJs,shellDeferredJs,nativeSupportJs,loaderHardeningSource].join('\n');
const activeJsFiles=[...new Set([...activeJsSources.matchAll(/['\"]\/?([^'\"]+\.js)(?:\?[^'\"]*)?['\"]/g)].map(m=>path.basename(m[1])))].filter(f=>fs.existsSync(path.join(root,'public',f)));
const activeJsText=activeJsFiles.map(f=>read('public/'+f));
const declaredShellTokens=new Set([...shellCss.matchAll(/(--tt-[a-z0-9-]+)\s*:/gi)].map(m=>m[1]));
const usedShellTokens=[...shellCss.matchAll(/var\((--tt-[a-z0-9-]+)/gi)].map(m=>m[1]);

check('authoritative palette is exact',
  authority.includes('--tt-green:#0B7A3E') &&
  authority.includes('--tt-green-deep:#075C31') &&
  authority.includes('--tt-yellow:#F2D11F') &&
  authority.includes('--tt-bg:#F6F7F4') &&
  authority.includes('--tt-text:#111714')
);

check('shell theme tokens are complete with no unresolved custom properties',
  declaredShellTokens.size>=20 && usedShellTokens.every(token=>declaredShellTokens.has(token))
);

check('spacing radius and control tokens are coherent',
  authority.includes('--tt-radius-sm:12px') &&
  authority.includes('--tt-radius-md:18px') &&
  authority.includes('--tt-radius-lg:24px') &&
  authority.includes('--tt-radius-xl:28px') &&
  authority.includes('--tt-control-h:48px') &&
  authority.includes('--tt-control-h-sm:44px')
);

const tiny = [...authority.matchAll(/font-size\s*:\s*([0-9.]+)px/gi)].map(m=>Number(m[1])).filter(n=>n<=10);
check('authoritative layer contains no staff text at 10px or below', tiny.length===0);

check('keyboard focus is explicit and visible',
  authority.includes(':focus-visible') &&
  authority.includes('outline:3px solid rgba(11,122,62,.20)')
);

check('reduced motion is respected globally',
  authority.includes('@media(prefers-reduced-motion:reduce)') &&
  authority.includes('animation:none!important') &&
  authority.includes('transition:none!important')
);

check('responsive laws cover desktop tablet and mobile',
  authority.includes('@media(max-width:1280px)') &&
  authority.includes('@media(max-width:1024px)') &&
  authority.includes('@media(max-width:768px)') &&
  authority.includes('@media(max-width:480px)')
);

check('tables stay scannable instead of becoming card grids',
  authority.includes('table{border-collapse:separate') &&
  authority.includes('th{font-size:12px!important') &&
  authority.includes('td{font-size:13px!important')
);

check('legacy literal palette remnants are neutralized by exact v2 selectors',
  authority.includes('.tt-op-reports-launcher{') &&
  authority.includes('.tt-settlement__panel{') &&
  authority.includes('.tt-purch__spinner{border-top-color:var(--tt-green)!important}') &&
  authority.includes('.tt-tech-score__coverage-bar span{background:var(--tt-green)!important}') &&
  authority.includes('.tt-purch__head:before{background:var(--tt-green)!important}')
);

check('status language has semantic success warning danger treatment',
  authority.includes('--tt-success:#11864A') &&
  authority.includes('--tt-warning:#C98B16') &&
  authority.includes('--tt-danger:#C44238') &&
  authority.includes('[class*="overdue"]')
);

check('controls meet the staff interaction size law',
  authority.includes('min-height:var(--tt-control-h-sm)!important') &&
  authority.includes('min-height:var(--tt-control-h)!important') &&
  authority.includes('border-radius:var(--tt-radius-sm)!important')
);

const sectors=[
  '.tt-sales','.tt-held','.tt-cc','cdw-panel','.tt-quotes','.tt-lw','.tt-promo',
  '.tt-rent','.tt-inv','.tt-tr','.tt-purch','suppliers-shell','.tt-supplier-ledger','wow-shell',
  '.tt-wo','.tt-repair-auth__panel','.tt-repair-comms__panel','.tt-rn__panel','.tt-repair-ops__panel','.tt-rpi-panel',
  '.tt-logistics','.tt-li-panel','.tt-si-panel','.tt-rebalance','.tt-settlement',
  '.tt-crm','.tt-cp','.tt-aiacct','.tt-ledger','.arw','.tt-finctl','.tt-op-reports',
  '.tt-admin','.tt-settings','.tt-rbac','.iaw','catalog-admin-panel',
  'ecom-shell','cm-shell','denom-shell','.tt-tmi','.tt-tech-pay','.tt-coach',
  '.tt-ea-modal','.tt-learn','.tt-employee-workspace-home','.tt-guide',
  '.tt-po-document-context','.tt-po-dialog','.tt-qi__panel','.rc-wizard-review','.tt-cat__panel',
  '.tt-predictive-list'
];
check('all major frontend sectors are governed by the authoritative layer',
  sectors.every(token=>authority.includes(token))
);

check('global authority preserves the sales reference hierarchy',
  authority.includes('.tt-sales__head h2{font-size:30px!important') &&
  authority.includes('.tt-sales__product strong{font-size:15px!important') &&
  authority.includes('.tt-sales__totals div.total{font-size:22px!important')
);

check('frontline reference surfaces keep their dedicated v2 implementations',
  shellCss.includes('--tt-green:#0B7A3E') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(shellCss) &&
  salesCss.includes('--sales-green:#0B7A3E') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(salesCss)
);

check('shell removes retired competing theme layers',
  !shellHtml.includes('/premium-shell-v2.css') &&
  !shellHtml.includes('/premium-shell-v3.css') &&
  !shellHtml.includes('/late-2020s-') &&
  !shellHtml.includes('/workspace-quality-pass.css')
);

check('shell loads authoritative system last among static styles',
  shellHtml.includes('id="tt-authoritative-ui"') &&
  shellHtml.indexOf('/unified-ui-system.css') > shellHtml.indexOf('/employee-learning-center.css')
);

check('dynamic workspace css is inserted before authoritative system',
  shellJs.includes("document.getElementById('tt-authoritative-ui')") &&
  shellJs.includes('document.head.insertBefore(l,authority)')
);

const moduleCss=[...shellJs.matchAll(/['"]([^'"]+\.css)['"]/g)].map(m=>m[1].replace(/^\//,''));
check('every dynamically declared workspace stylesheet exists',
  moduleCss.length>=20 && moduleCss.every(file=>fs.existsSync(path.join(root,'public',path.basename(file))))
);

check('home is task-led, quiet and written for staff',
  shellJs.includes('What do you need?') &&
  shellJs.includes('Today at a glance') &&
  shellJs.includes('Needs attention') &&
  shellJs.includes('function domainIntro(') &&
  shellJs.includes('function moreCards(') &&
  shellJs.includes("service:'Repairs'") &&
  shellJs.includes("crm:'Customers'") &&
  shellJs.includes("administration:'Admin'")
);

check('purchasing landing keeps four clear first-level destinations',
  shellJs.includes("purchasing:[['Suppliers'") &&
  shellJs.includes("['Purchase Orders'") &&
  shellJs.includes("['Purchase Requests'") &&
  shellJs.includes("['Receiving'") &&
  shellJs.includes("'suppliers-workspace':['/suppliers-workspace.css'") &&
  purchasingJs.includes('async function open(opts={})')
);

check('advanced tools are progressively disclosed instead of always visible',
  shellJs.includes('<details class="shell-more">') &&
  shellCss.includes('.shell-more summary') &&
  shellCss.includes('.shell-choice-grid') &&
  shellCss.includes('.shell-quiet-section--snapshot')
);

check('quick command removes navigation hunting for permitted tasks',
  shellJs.includes("RECENT_TASKS_KEY='tt:shell:recent-tasks'") &&
  shellJs.includes('function commandCatalog()') &&
  shellJs.includes('function openCommand(') &&
  shellJs.includes("String(e.key).toLowerCase()==='k'") &&
  shellJs.includes('allowedFeature(key)') &&
  shellJs.includes('rememberTask(key,title)')
);

check('active shell-loaded frontend contains no blocking browser alert prompt or confirm calls',
  activeJsFiles.length>=20 &&
  activeJsText.every(src=>!/(?:\balert\s*\(|\bprompt\s*\(|\bconfirm\s*\()/.test(src))
);

check('shared shell dialog replaces blocking browser prompts and confirms in operational flows',
  shellJs.includes('function requestInput(') &&
  shellJs.includes('async function confirmAction(') &&
  shellJs.includes('confirm:confirmAction') &&
  shellJs.includes('request:requestInput') &&
  shellCss.includes('.shell-input-dialog__panel') &&
  shellCss.includes('.shell-input-dialog__fields input') &&
  shellCss.includes('font-size:16px') &&
  !salesJs.includes('prompt(') &&
  !layawayJs.includes('prompt(') &&
  !warehouseJs.includes('prompt(') &&
  !repairAuthorizationsJs.includes('prompt(') &&
  !departmentApprovalsJs.includes('prompt(') &&
  !routePlanningJs.includes('prompt(') &&
  !catalogWorkflowJs.includes('prompt(') &&
  !catalogAdminJs.includes('prompt(') &&
  !repairPartsJs.includes('prompt(')
);

check('shared dialog preserves evidence requirements in migrated workflows',
  salesJs.includes("title:'Email receipt'") &&
  layawayJs.includes("title:'Record layaway payment'") &&
  layawayJs.includes("title:'Cancel layaway plan'") &&
  warehouseJs.includes("title:'Post shipment'") &&
  warehouseJs.includes("title:'Create warehouse zone'") &&
  repairAuthorizationsJs.includes("title:decision==='approved'?'Approve estimate':'Reject estimate'") &&
  departmentApprovalsJs.includes("title:'Reject request'") &&
  routePlanningJs.includes("title:'Confirm pickup / custody'") &&
  routePlanningJs.includes("title:'Skip route stop'") &&
  routePlanningJs.includes("title:'Close route'") &&
  catalogAdminJs.includes("title:'Consolidate duplicate categories'") &&
  catalogAdminJs.includes("message:'Record the evidence or reason for this catalog review decision.'") &&
  repairPartsJs.includes("title:'Open repair parts'")
);

check('shell feedback avoids blocking alerts for shell-level support and module failures',
  shellJs.includes('function showToast(') &&
  shellJs.includes("window.TotalToolsShellUI={command:openCommand,toast:showToast,request:requestInput,confirm:confirmAction}") &&
  shellJs.includes("showToast(`${title||'Workspace'} could not open") &&
  !shellJs.includes("else alert('Guide Me is available inside supported tasks.')") &&
  !shellJs.includes("else alert('Help & Learning is still loading. Please try again.')")
);

check('canonical shell overlays contain and restore keyboard focus',
  shellJs.includes('aria-labelledby="shell-input-dialog-title"') &&
  shellJs.includes('aria-describedby="shell-input-dialog-description"') &&
  shellJs.includes("if(e.key==='Tab')") &&
  shellJs.includes('commandReturnFocus=document.activeElement') &&
  shellJs.includes("target.focus({preventScroll:true})") &&
  shellJs.includes("previous.focus({preventScroll:true})")
);

check('quick command is responsive and keyboard accessible',
  shellCss.includes('.shell-command__panel') &&
  shellCss.includes('.shell-command-result') &&
  shellCss.includes('.shell-command-button') &&
  shellCss.includes('.shell-toast-host') &&
  shellCss.includes('max-height:calc(100dvh - 16px)')
);

check('recent task recovery is one tap from home',
  shellJs.includes('function continueWorking()') &&
  shellJs.includes('Pick up where you left off') &&
  shellJs.includes("document.getElementById('shell-resume-all')") &&
  shellJs.includes('rememberTask(key,title);renderWorkspace(currentDomain)') &&
  shellCss.includes('.shell-resume__list') &&
  shellCss.includes('.shell-resume__item')
);

check('sales is scanner and keyboard first without weakening checkout confirmation',
  salesJs.includes('function focusProductSearch(') &&
  salesJs.includes('function bindSalesShortcuts()') &&
  salesJs.includes("e.key==='F2'") &&
  salesJs.includes("e.key==='F3'") &&
  salesJs.includes('aria-keyshortcuts="/"') &&
  salesJs.includes("title:'Complete sale?'") && salesJs.includes("confirmLabel:'Complete sale'") &&
  salesJs.includes("notice('Cash tendered cannot be less than the sale total.','error')") &&
  salesCss.includes('.tt-sales__shortcuts')
);

check('inventory is search-first without weakening adjustment control',
  inventoryJs.includes('function focusSearch(') &&
  inventoryJs.includes('function bindShortcuts()') &&
  inventoryJs.includes("e.key==='F2'") &&
  inventoryJs.includes("e.key==='F3'") &&
  inventoryJs.includes('aria-keyshortcuts="/"') &&
  inventoryJs.includes("title:'Post stock adjustment?'") && inventoryJs.includes("confirmLabel:'Post adjustment'") &&
  inventoryJs.includes("notice('A reason is required for every stock adjustment.','error')")
);

check('purchasing accelerates document entry while preserving authority boundaries',
  purchasingJs.includes('function focusComposer(') &&
  purchasingJs.includes('function focusLine(index)') &&
  purchasingJs.includes("e.key==='F2'") &&
  purchasingJs.includes("e.key==='F3'") &&
  purchasingJs.includes('aria-keyshortcuts="F2"') &&
  purchasingJs.includes('aria-keyshortcuts="F3"') &&
  purchasingJs.includes("title:'Cancel purchase order?'") &&
  purchasingJs.includes("title:'Post received quantities?'") &&
  purchasingJs.includes("notice('Enter at least one quantity received.','error')")
);

check('remaining purchasing admin supplier transfer surfaces keep final mobile interaction law',
  adminJs.includes('async function open(opts={})') &&
  adminJs.includes("['employees','branches','security'].includes(opts.tab)") &&
  adminCss.includes('#tt-admin .tt-admin__toolbar input') &&
  adminCss.includes('font-size:16px!important') &&
  purchasingCss.includes('.tt-purch__tabs{position:static;top:auto;z-index:auto}') &&
  suppliersCss.includes('.suppliers-overlay .suppliers-shell .suppliers-panel.suppliers-toolbar input[data-search]') &&
  suppliersCss.includes('font-size:16px!important') &&
  suppliersCss.includes('.suppliers-overlay.has-selection .suppliers-list{display:none}') &&
  transfersCss.includes('.tt-tr.has-selection .tt-tr__list{display:none}') &&
  transfersCss.includes('#tt-transfers-workspace .tt-tr__composer input') &&
  transfersCss.includes('font-size:16px!important') &&
  attentionCss.includes('.tt-oac__section-head{position:static;top:auto;z-index:auto}') &&
  attentionCss.includes('.tt-oac.has-selection .tt-oac__queue{display:none}')
);

check('transfers use product-native review dialogs while preserving physical-stock confirmation',
  transfersJs.includes('function confirmAction(') &&
  transfersJs.includes('function receiveDialog(') &&
  transfersJs.includes("title:'Post received quantities?'") &&
  transfersJs.includes("message:'Post these received quantities to destination inventory? This changes physical stock.'") &&
  transfersJs.includes("title:'Cancel transfer?'") &&
  !transfersJs.includes('prompt(')
);

check('operations attention remains evidence-only and one-job mobile',
  attentionJs.includes('This screen highlights risk; it does not silently change stock, payroll, purchasing, finance or customer records.') &&
  attentionJs.includes('Evidence-only · No automatic operational mutation') &&
  attentionJs.includes('data-list-back') &&
  attentionCss.includes('.tt-oac.has-selection .tt-oac__queue{display:none}') &&
  attentionCss.includes('.tt-oac:not(.has-selection) .tt-oac__detail{display:none}')
);

check('active secondary workspaces contain no staff microtype at 10px or below',
  secondaryReadableCss.every(([,css])=>!/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(css))
);

check('workspace hardening registry cannot hide shell modules or lose tile intent',
  assetKeys(shellJs).length>0 &&
  assetKeys(shellJs).every(k=>assetKeys(loaderHardeningJs).includes(k)) &&
  loaderHardeningJs.includes("'suppliers-workspace':['/suppliers-workspace.css'") &&
  loaderHardeningJs.includes("'warehouse-operations':['/warehouse-operations-workspace.css'") &&
  loaderHardeningJs.includes("options={...options,tab:'pr'}") &&
  loaderHardeningJs.includes("options={...options,tab:'po'}") &&
  loaderHardeningJs.includes("options={...options,tab:'branches'}") &&
  loaderHardeningJs.includes("window.TotalToolsShellUI?.toast") &&
  !loaderHardeningJs.includes('catch(err=>alert(')
);

check('repairs uses a calm search-first queue with progressive detail',
  workOrdersJs.includes('function focusSearch(') &&
  workOrdersJs.includes('function bindShortcuts()') &&
  workOrdersJs.includes("e.key==='F2'") &&
  workOrdersJs.includes("e.key==='F3'") &&
  workOrdersJs.includes('aria-keyshortcuts="/"') &&
  workOrdersJs.includes('tt-wo__disclosure') &&
  workOrdersJs.includes('<h3>Quality check</h3>') &&
  workOrdersCss.includes('.tt-wo__disclosure summary') &&
  workOrdersCss.includes('.tt-wo.has-selection .tt-wo__list-pane{display:none}') &&
  workOrdersCss.includes('#tt-work-orders-workspace #tt-wo-search{font-size:16px!important}') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(workOrdersCss)
);

check('rentals opens as a calm queue and progressively discloses lifecycle evidence',
  rentalsJs.includes('function focusSearch(') &&
  rentalsJs.includes('function bindShortcuts()') &&
  rentalsJs.includes("e.key==='F2'") &&
  rentalsJs.includes("e.key==='F3'") &&
  rentalsJs.includes('aria-keyshortcuts="/"') &&
  rentalsJs.includes('tt-rent__disclosure') &&
  rentalsJs.includes('<span>History</span>') &&
  rentalsJs.includes('<span>Assigned equipment</span>') &&
  rentalsJs.includes('<span>Missing items</span>') &&
  rentalsJs.includes("title:'Resume rental?'") &&
  !rentalsJs.includes('if(!state.selected&&state.rows.length)state.selected=state.rows[0]') &&
  rentalsCss.includes('.tt-rent.has-selection .tt-rent__list{display:none}') &&
  rentalsCss.includes('#tt-rentals-workspace #tt-rent-search') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(rentalsCss)
);

check('rental fleet dialogs match the canonical interaction law',
  rentalFleetJs.includes('aria-labelledby="tt-fleet-modal-title"') &&
  rentalFleetJs.includes('role="alert" aria-live="polite"') &&
  rentalFleetJs.includes("if(e.key==='Tab')") &&
  rentalFleetJs.includes("previous.focus({preventScroll:true})") &&
  rentalFleetJs.includes('@media(max-width:640px)') &&
  rentalFleetJs.includes('.tt-fleet__modal input,.tt-fleet__modal select,.tt-fleet__modal textarea{font-size:16px}')
);

check('customers is search-first with focused mobile detail and quiet history',
  customerCrmJs.includes('function focusSearch(') &&
  customerCrmJs.includes('function bindShortcuts()') &&
  customerCrmJs.includes("e.key==='F2'") &&
  customerCrmJs.includes('aria-keyshortcuts="/"') &&
  customerCrmJs.includes('tt-crm__disclosure') &&
  customerCrmJs.includes('>Opportunities</button>') &&
  customerCrmCss.includes('.tt-crm.has-selection .tt-crm__list{display:none}') &&
  customerCrmCss.includes('#tt-customer-crm #tt-crm-search{font-size:16px!important}') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(customerCrmCss)
);

check('finance shows decisions first and moves analysis behind disclosure',
  accountingJs.includes('<h3>Financial position</h3>') &&
  accountingJs.includes("kpi('Revenue'") &&
  accountingJs.includes("kpi('Estimated gross profit'") &&
  accountingJs.includes("kpi('Accounts receivable'") &&
  accountingJs.includes("kpi('90+ day exposure'") &&
  !accountingJs.includes("kpi('Discounts'") &&
  !accountingJs.includes("kpi('Credit sales'") &&
  accountingJs.indexOf('Needs attention') < accountingJs.indexOf('Branch performance') &&
  accountingJs.includes('<span>Branch performance</span>') &&
  accountingJs.includes('<span>Repair profitability</span>') &&
  accountingJs.includes('<span>How these numbers are calculated</span>') &&
  accountingJs.includes('tt-aiacct__filter-disclosure') &&
  accountingCss.includes('.tt-aiacct__disclosure summary') &&
  accountingCss.includes('.tt-aiacct__filter-disclosure>summary') &&
  accountingCss.includes('#tt-accounting-intelligence #tt-aiacct-start') &&
  accountingCss.includes('font-size:16px!important') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(accountingCss)
);

check('dispatch is queue-first with searchable work and explicit coverage exceptions',
  logisticsJs.includes('function filteredJobs()') &&
  logisticsJs.includes('function focusSearch(') &&
  logisticsJs.includes('function bindShortcuts()') &&
  logisticsJs.includes("e.key==='F2'") &&
  logisticsJs.includes("e.key==='F3'") &&
  logisticsJs.includes('aria-keyshortcuts="/"') &&
  logisticsJs.includes('<span>Needs coverage</span>') &&
  logisticsJs.includes("notice('Dispatch queue refreshed.','success')") &&
  logisticsCss.includes('.tt-li-coverage summary') &&
  logisticsCss.includes('#tt-logistics-intelligence #tt-li-search{font-size:16px!important}') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(logisticsCss)
);

check('dispatch supporting dialogs use the unified product dialog law',
  logisticsFieldJs.includes('tt-logistics-dialog__panel') &&
  logisticsFieldJs.includes('aria-labelledby="tt-field-modal-title"') &&
  logisticsFieldJs.includes("if(e.key==='Tab')") &&
  logisticsFieldJs.includes("previous.focus({preventScroll:true})") &&
  logisticsLocationJs.includes('aria-labelledby="tt-route-modal-title"') &&
  logisticsLocationJs.includes('<label>Latitude<input') &&
  logisticsLocationJs.includes('<label>Zone code<input') &&
  logisticsLocationJs.includes('tt-logistics-dialog__actions') &&
  logisticsLocationJs.includes("if(e.key==='Tab')") &&
  logisticsCss.includes('/* Unified Dispatch dialog law */') &&
  logisticsCss.includes('.tt-field-modal,.tt-route-modal') &&
  logisticsCss.includes('@media(max-width:640px){.tt-field-modal,.tt-route-modal')
);

check('held orders is search-first and preserves deliberate sale boundaries',
  heldSalesJs.includes('function filteredHolds()') &&
  heldSalesJs.includes('function focusSearch(') &&
  heldSalesJs.includes('function bindShortcuts()') &&
  heldSalesJs.includes('aria-keyshortcuts="/"') &&
  !heldSalesJs.includes('if(!state.selected&&state.holds.length)state.selected=state.holds[0].id') &&
  heldSalesJs.includes("title:'Complete recalled sale?'") &&
  heldSalesJs.includes("title:'Cancel held order?'") &&
  heldSalesJs.includes("notice('Cash tendered cannot be less than the current total.','error')") &&
  heldSalesCss.includes('.tt-held.has-selection .tt-held__list{display:none}') &&
  heldSalesCss.includes('#tt-held-sales #tt-held-search') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(heldSalesCss)
);

check('quotes is search-first with quiet filters and history',
  quotationsJs.includes('function focusSearch(') &&
  quotationsJs.includes('function bindShortcuts()') &&
  quotationsJs.includes("e.key==='F2'") &&
  quotationsJs.includes("e.key==='F3'") &&
  quotationsJs.includes('aria-keyshortcuts="/"') &&
  quotationsJs.includes('tt-quotes__filters') &&
  quotationsJs.includes('tt-quotes__history') &&
  quotationsCss.includes('.tt-quotes__filters summary') &&
  quotationsCss.includes('.tt-quotes__history summary') &&
  quotationsCss.includes('#tt-quotes #tt-quotes-search') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(quotationsCss)
);

check('warehouse is queue-first and keeps storage evidence progressively disclosed',
  warehouseJs.includes('function filteredShipments()') &&
  warehouseJs.includes('function bindShortcuts()') &&
  warehouseJs.includes('aria-keyshortcuts="/"') &&
  warehouseJs.includes('wow-storage') &&
  warehouseJs.includes('wow-history') &&
  warehouseCss.includes('.wow-overlay.has-selection .wow-queue{display:none}') &&
  warehouseCss.includes('.wow-storage summary') &&
  warehouseCss.includes('.wow-history summary') &&
  warehouseCss.includes('.wow-overlay #wow-search{font-size:16px!important}') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(warehouseCss)
);

check('warehouse is first-class in the simplified shell and quick command',
  shellJs.includes("['Warehouse','Prepare shipments, find storage locations and manage warehouse flow.','warehouse-operations']") &&
  shellJs.includes("'warehouse-operations':['/warehouse-operations-workspace.css'") &&
  shellJs.includes("'warehouse-operations':'warehouse'") &&
  shellJs.includes("if(key==='warehouse-operations')return'Open warehouse'")
);

check('native support tools attach to progressive disclosure instead of retired shell grid',
  nativeSupportJs.includes("document.getElementById('shell-content')") &&
  nativeSupportJs.includes("content.querySelector('.shell-more')") &&
  nativeSupportJs.includes("className='shell-more'") &&
  !nativeSupportJs.includes("document.getElementById('shell-grid')")
);

check('final shell visual law is warm framed, white canvased and search led',
  shellCss.includes('--tt-frame:#FBF5E9') &&
  shellCss.includes('.shell-search-label') &&
  shellCss.includes('.shell-profile-mark') &&
  shellJs.includes('Search tasks, customers, stock or orders') &&
  shellJs.includes('shell-topbar-avatar') &&
  authority.includes('Shell authority exception: the application frame has its own warm visual law.') &&
  authority.includes('.shell-sidebar{background:#FBF5E9!important') &&
  authority.includes('.shell-nav button.is-active{background:#0B7A3E!important;color:#fff!important') &&
  authority.includes('.shell-main{background:#fff!important') &&
  authority.includes('.shell-command-button{display:flex!important;flex:1 1 auto!important') &&
  authority.includes('.shell-topbar>.shell-command-search,.shell-topbar>.shell-quick-actions,.shell-topbar>.tt-learning-launcher{display:none!important')
);

check('final shell responsive geometry prevents command-bar wrap',
  authority.includes('.shell-topbar{min-height:82px!important') &&
  authority.includes('@media(max-width:1080px){.shell-app{background:#fff!important') &&
  authority.includes('.shell-topbar{min-height:76px!important;padding:12px 20px!important') &&
  authority.includes('@media(max-width:640px){.shell-topbar{min-height:68px!important;padding:10px 12px!important;display:flex!important') &&
  authority.includes('.shell-command-button{width:100%!important;min-width:0!important;height:48px!important')
);

check('Guide Me is a fluent non-modal coach with one canonical entry path',
  guidedModeJs.includes('aria-modal="false"') &&
  guidedModeJs.includes('state.returnFocus') &&
  guidedModeJs.includes("document.getElementById('tt-guide-launcher')?.remove()") &&
  guidedAccessJs.includes("window.TotalToolsGuideMe?.open") &&
  guidedAccessJs.includes("document.getElementById('tt-guide-access')?.remove()") &&
  guidedAccessJs.includes("document.getElementById('tt-guide-quick')?.remove()") &&
  guidedHardeningJs.includes("panel.setAttribute('aria-modal','false')") &&
  guidedHardeningJs.includes('Guide Me is a non-modal coach') &&
  guidedExactJs.includes('function sales()') &&
  guidedExactJs.includes("heading.textContent='Follow the highlighted control'") &&
  authority.includes('Guide Me final authority — one fluent coach surface') &&
  authority.includes('#tt-guide-launcher,#tt-guide-access,#tt-guide-quick{display:none!important}') &&
  authority.includes('#tt-guided-mode .tt-guide__search input{min-width:0!important;height:50px!important') &&
  authority.includes('@media(max-width:900px){') &&
  authority.includes('#tt-guided-mode .tt-guide__search input{font-size:16px!important}') &&
  authority.includes('max-height:min(58dvh,520px)!important')
);

check('accounts receivable is search-first, readable and keeps credit approval controlled',
  accountsReceivableJs.includes('function focusSearch(') &&
  accountsReceivableJs.includes('function bindShortcuts()') &&
  accountsReceivableJs.includes("e.key==='F2'") &&
  accountsReceivableJs.includes('aria-keyshortcuts="/"') &&
  accountsReceivableJs.includes('Manager approval required') &&
  accountsReceivableJs.includes('data-credit-request') &&
  accountsReceivableJs.includes('data-payment') &&
  accountsReceivableCss.includes('.arw-disclosure summary') &&
  accountsReceivableCss.includes('.arw-row em.danger') &&
  accountsReceivableCss.includes('font-size:16px!important') &&
  authority.includes('.arw-overlay.open .arw .arw-toolbar input') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(accountsReceivableCss)
);

check('products and categories is search-first and preserves governed catalog controls',
  catalogAdminJs.includes('Products & Categories') &&
  catalogAdminJs.includes('function focusSearch(') &&
  catalogAdminJs.includes('function bindShortcuts()') &&
  catalogAdminJs.includes("e.key==='F2'") &&
  catalogAdminJs.includes("e.key==='F3'") &&
  catalogAdminJs.includes('aria-keyshortcuts="/"') &&
  catalogAdminJs.includes('Catalog Health') &&
  catalogAdminJs.includes('Consolidate duplicate records') &&
  catalogAdminJs.includes('Type CONSOLIDATE to confirm') &&
  catalogAdminCss.includes('.catalog-admin-shortcuts') &&
  catalogAdminCss.includes('.catalog-admin-table th') &&
  catalogAdminCss.includes('.catalog-admin-health-card.severity-high') &&
  catalogAdminCss.includes('font-size:16px!important') &&
  authority.includes('.catalog-admin-overlay .catalog-admin-shell .catalog-admin-panel .catalog-admin-toolbar input') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(catalogAdminCss)
);

check('technician performance is readable, evidence-led and keeps pay controls explicit',
  technicianCompJs.includes('Technician Performance') &&
  technicianCompJs.includes('Pay & Adjustments') &&
  technicianCompJs.includes('Pay changes always remain controlled.') &&
  technicianCompJs.includes('data-tech-back') &&
  technicianCompJs.includes('Performance evidence never changes pay automatically.') &&
  technicianCompJs.includes('Automatic pay change: No') &&
  technicianCompCss.includes('.tt-tech-pay.has-tech .tt-tech-score__list{display:none}') &&
  technicianCompCss.includes('.tt-tech-score__back') &&
  technicianCompCss.includes('font-size:16px!important') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(technicianCompCss)
);

check('technician team is action-led and uses one-item mobile management flow',
  technicianMgmtJs.includes('See who needs attention, why the issue surfaced, and the next management action.') &&
  technicianMgmtJs.includes('<strong>Needs attention</strong>') &&
  technicianMgmtJs.includes('<strong>Team context</strong>') &&
  technicianMgmtJs.includes('Attention points') &&
  technicianMgmtJs.includes('data-alert-back') &&
  technicianMgmtJs.includes('they never change pay or discipline anyone automatically.') &&
  technicianMgmtCss.includes('.tt-tmi.has-selection .tt-tmi__alerts{display:none}') &&
  technicianMgmtCss.includes('.tt-tmi__queue-back') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(technicianMgmtCss)
);

check('commissions is readable and keeps approval/payment transitions deliberate',
  commissionsJs.includes('Review earned commission, approve verified records, and keep payment status clear.') &&
  commissionsJs.includes('function confirmAction(') &&
  commissionsJs.includes("title:'Approve commission?'") &&
  commissionsJs.includes("title:'Mark commission paid?'") &&
  commissionsJs.includes("title:'Approve all pending commission?'") &&
  commissionsJs.includes("notice('Pending commission approved.','success')") &&
  commissionsJs.includes('cm-disclosure') &&
  !commissionsJs.includes('function showErr(e){alert(') &&
  commissionsCss.includes('.cm-confirm-layer') &&
  commissionsCss.includes('.cm-disclosure summary') &&
  commissionsCss.includes('font-size:16px!important') &&
  authority.includes('.cm-overlay .cm-shell .cm-toolbar input') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(commissionsCss)
);

check('integration credential administration uses audited in-product dialogs without browser prompts',
  integrationAdminJs.includes("const VALID_SCOPES=['products:read'") &&
  integrationAdminJs.includes('function reasonValid(value)') &&
  integrationAdminJs.includes('function actionDialog(') &&
  integrationAdminJs.includes('Security controlled') &&
  integrationAdminJs.includes('Required for the security audit.') &&
  integrationAdminJs.includes("title:'Create API key'") &&
  integrationAdminJs.includes("title:'Rotate API key'") &&
  integrationAdminJs.includes("title:'Revoke API key'") &&
  integrationAdminJs.includes('Shown once') &&
  integrationAdminJs.includes('it cannot be revealed later.') &&
  !integrationAdminJs.includes('prompt(') &&
  !integrationAdminJs.includes('confirm(') &&
  integrationAdminCss.includes('.iaw-dialog-layer') &&
  integrationAdminCss.includes('.iaw-scope-grid') &&
  integrationAdminCss.includes('font-size:16px!important') &&
  authority.includes('.iaw-layer .iaw-metrics{grid-template-columns:1fr 1fr!important') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(integrationAdminCss)
);

check('reports opens with truthful quick choices and progressively disclosed library',
  operationalReportsJs.includes('Start with a common business question') &&
  operationalReportsJs.includes('Every result comes from the live POS data available to your account.') &&
  operationalReportsJs.includes('tt-op-reports__quick-grid') &&
  operationalReportsJs.includes('<details class="tt-op-reports__group"') &&
  operationalReportsJs.includes('Download CSV') &&
  operationalReportsJs.includes('Print / Save PDF') &&
  operationalReportsCss.includes('.tt-op-reports__quick-card') &&
  operationalReportsCss.includes('#tt-op-reports-root .tt-op-reports__controls input') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(operationalReportsCss)
);

check('denomination editor uses the canonical dialog interaction law',
  denominationsJs.includes('role="dialog" aria-modal="true" aria-labelledby="denom-dialog-title"') &&
  denominationsJs.includes("if(e.key==='Tab')") &&
  denominationsJs.includes("previous.focus({preventScroll:true})") &&
  denominationsJs.includes("if(e.target===modal)closeModal()") &&
  denominationsCss.includes('/* Denomination dialog mobile law */') &&
  denominationsCss.includes('.denom-card input,.denom-card select{font-size:16px}')
);

check('settings opens as a plain-language index before exposing configuration forms',
  settingsJs.includes("tab:'',saving:false,error:''") &&
  settingsJs.includes('function settingsHome()') &&
  settingsJs.includes('Choose what you want to manage') &&
  settingsJs.includes('data-setting=') &&
  settingsJs.includes('data-settings-home') &&
  settingsJs.includes('function reasonField()') &&
  settingsJs.includes('Required for integration or credential changes and recorded in the security audit.') &&
  !settingsJs.includes('catch(err){state.saving=false;render();alert(err.message);}') &&
  settingsCss.includes('.tt-settings__menu>button') &&
  settingsCss.includes('#tt-settings .tt-settings__field input{font-size:16px!important}') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(settingsCss)
);

check('customer programs uses the final visual law without weakening pricing authority',
  customerProgramsJs.includes('Customer Benefit Programs') &&
  customerProgramsJs.includes('checkout remains the pricing authority') &&
  customerProgramsJs.includes('function confirmDelete(name)') &&
  customerProgramsJs.includes("notice('Customer program deleted.','success')") &&
  !customerProgramsJs.includes("confirm('Delete") &&
  customerProgramsCss.includes('--cp-green:#0B7A3E') &&
  customerProgramsCss.includes('#tt-customer-programs .tt-cp-modal input{font-size:16px!important}') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(customerProgramsCss)
);

check('e-commerce operations is queue-led and preserves warehouse shipment authority',
  ecommerceJs.includes('<h2>Online Orders</h2>') &&
  ecommerceJs.includes('<h3>Order queue</h3>') &&
  ecommerceJs.includes('function confirmShipment(order)') &&
  ecommerceJs.includes('Stock movement still occurs only through the existing warehouse process.') &&
  ecommerceJs.includes('<details class="ecom-panel ecom-disclosure">') &&
  ecommerceJs.includes("notice('Shipment draft created.','success')") &&
  !ecommerceJs.includes("confirm('Create a draft shipment") &&
  ecommerceCss.includes('--ec-green:#0B7A3E') &&
  ecommerceCss.includes('.ecom-disclosure summary') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(ecommerceCss)
);

check('promotions uses readable campaign flow and in-product code entry',
  promotionsJs.includes('function codeDialog()') &&
  promotionsJs.includes('without bypassing checkout pricing controls') &&
  promotionsJs.includes("root().classList.add('has-selection')") &&
  promotionsJs.includes("notice('Promotion code added.','success')") &&
  !promotionsJs.includes("prompt('Promotion code')") &&
  !promotionsJs.includes("prompt('Usage limit") &&
  promotionsCss.includes('--promo-green:#0B7A3E') &&
  promotionsCss.includes('.tt-promo.has-selection .tt-promo__list{display:none}') &&
  promotionsCss.includes('#tt-promotions .tt-promo-form input') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(promotionsCss)
);

check('financial controls keeps truthful finance boundaries and progressively discloses analysis',
  financialControlsJs.includes('Not a cash-flow statement:') &&
  financialControlsJs.includes('tt-finctl-disclosure') &&
  financialControlsJs.includes('Known commitments ÷ recorded inflow proxy') &&
  financialControlsCss.includes('--fc-green:#0B7A3E') &&
  financialControlsCss.includes('.tt-finctl-disclosure summary') &&
  financialControlsCss.includes('#tt-fin-controls #tt-finctl-start') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(financialControlsCss)
);

check('settlement reconciliation keeps evidence primary and secondary tables on demand',
  settlementJs.includes('Settlement batches') &&
  settlementJs.includes('tt-settlement-section') &&
  settlementJs.includes('POS evidence waiting for settlement matching') &&
  settlementJs.includes("notice(e.message+' — match POS transactions to this batch before reconciliation.','error')") &&
  settlementCss.includes('--sr-green:#0B7A3E') &&
  settlementCss.includes('.tt-settlement-section summary') &&
  settlementCss.includes('#tt-settlement-rec .tt-settlement__filters input') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(settlementCss)
);

check('cashier controls is search-first and preserves deliberate return and void boundaries',
  cashierControlsJs.includes('function confirmAction(') &&
  cashierControlsJs.includes('aria-keyshortcuts="/"') &&
  cashierControlsJs.includes("title:'Process return?'") &&
  cashierControlsJs.includes("title:'Void transaction?'") &&
  cashierControlsJs.includes("notice('Manager override PIN is required.','error')") &&
  cashierControlsJs.includes("notice('Void reason is required.','error')") &&
  !cashierControlsJs.includes("confirm(`Void") &&
  !cashierControlsJs.includes("confirm(`Process this") &&
  cashierControlsCss.includes('--cc-green:#0B7A3E') &&
  cashierControlsCss.includes('.tt-cc.has-selection .tt-cc__list{display:none}') &&
  cashierControlsCss.includes('#tt-cashier-controls #tt-cc-search{font-size:16px!important}') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(cashierControlsCss)
);

check('supplier ledger is readable while payment retries remain idempotent',
  supplierLedgerJs.includes('Formal payables begin only when a supplier invoice is posted.') &&
  supplierLedgerJs.includes("PAYMENT_OPERATION_STORAGE='tt_supplier_payment_operation_v1'") &&
  supplierLedgerJs.includes("headers:{'Idempotency-Key':operationKey}") &&
  supplierLedgerJs.includes('A supplier payment is still awaiting a deterministic retry.') &&
  supplierLedgerJs.includes('tt-supplier-ledger-disclosure') &&
  supplierLedgerCss.includes('--sl-green:#0B7A3E') &&
  supplierLedgerCss.includes('#tt-supplier-ledger #tt-supplier-ledger-branch') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(supplierLedgerCss)
);

check('inventory planning is readable, evidence-led and remains advisory',
  inventoryIntelligenceJs.includes('Suggested actions never change stock automatically.') &&
  inventoryIntelligenceJs.includes('tt-ii-planning') &&
  inventoryIntelligenceJs.includes('data-go-transfer') &&
  inventoryIntelligenceJs.includes('data-go-purchasing') &&
  inventoryIntelligenceCss.includes('--ii-green:#0B7A3E') &&
  inventoryIntelligenceCss.includes('.tt-ii-planning summary') &&
  inventoryIntelligenceCss.includes('#tt-inventory-intelligence #tt-ii-branch') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(inventoryIntelligenceCss)
);

check('inventory operations is readable and preserves audited stock adjustment control',
  inventoryJs.includes('function focusSearch(') &&
  inventoryJs.includes('Reason is required for auditability') &&
  inventoryJs.includes("notice('A reason is required for every stock adjustment.','error')") &&
  inventoryJs.includes("window.TotalToolsShellUI?.confirm?.({title:'Post stock adjustment?'") &&
  inventoryJs.includes('Adjust ${state.selected.name}') &&
  inventoryJs.includes("method:'PATCH'") &&
  inventoryCss.includes('--inv-green:#0B7A3E') &&
  inventoryCss.includes('#tt-inventory-workspace #tt-inv-search') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(inventoryCss)
);

check('accounting ledger is readable and keeps irreversible posting explicit',
  accountingLedgerJs.includes('Balanced journals, trial balance and source-traceable posted entries.') &&
  accountingLedgerJs.includes('function confirmPost(journal)') &&
  accountingLedgerJs.includes('Posted journals are locked and must be corrected by reversal.') &&
  accountingLedgerJs.includes("notice('Journal posted.','success')") &&
  accountingLedgerJs.includes('tt-ledger-disclosure') &&
  !accountingLedgerJs.includes("confirm('Post this balanced journal?") &&
  accountingLedgerCss.includes('--al-green:#0B7A3E') &&
  accountingLedgerCss.includes('.tt-ledger-confirm') &&
  accountingLedgerCss.includes('#tt-accounting-ledger #tt-ledger-end') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(accountingLedgerCss)
);

check('legacy source still declares authoritative ui after feature styles',
  legacy.indexOf('/unified-ui-system.css') > legacy.indexOf('/rental-create-wizard.css')
);

check('legacy runtime strips retired competing themes before rendering',
  server.includes('retiredThemePattern') &&
  server.includes('premium-shell-v2|premium-shell-v3') &&
  server.includes('late-2020s-workspaces') &&
  server.includes('workspace-quality-pass') &&
  server.includes('unified-ui-system)')
);

check('legacy runtime injects a single authoritative stylesheet last',
  server.includes('id="tt-authoritative-ui"') &&
  server.includes("versioned('/unified-ui-system.css')") &&
  server.indexOf("versioned('/unified-ui-system.css')") > server.indexOf("versioned('/employee-assist-ui.css')")
);

check('legacy runtime cache version is advanced for ui v2',
  server.includes("CLIENT_ASSET_VERSION = '20260922-ui-v2-all'")
);

check('staff manual does not publish retired credential guidance',
  !manual.includes('123456') &&
  !manual.includes('stored and checked in plain text') &&
  manual.includes('fresh production installation does not create a usable default administrator password') &&
  manual.includes('Passwords and staff PINs are protected using secure password hashing')
);

check('staff manual describes the simple task-led home',
  manual.includes('<h2 class="module">Home</h2>') &&
  manual.includes('What do you need?') &&
  manual.includes('Today at a glance') &&
  manual.includes('Needs attention') &&
  manual.includes('More tools') &&
  manual.includes('Suppliers, Purchase Orders, Purchase Requests, and Receiving')
);

check('staff manual is governed by ui v2',
  manual.includes('/manual-ui-v2.css?v=20260922-ui-v2-all') &&
  manual.includes('<title>Total Tools — Staff Manual</title>') &&
  manualCss.includes('--manual-green:#0B7A3E') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(manualCss) &&
  manualCss.includes('@media(prefers-reduced-motion:reduce)')
);

check('standalone preview is governed by ui v2',
  preview.includes('/preview-ui-v2.css?v=20260922-ui-v2-all') &&
  preview.includes('Total Tools — UI V2 Preview') &&
  previewCss.includes('--g:#0B7A3E!important') &&
  !/(?:font-size:)\s*(?:[1-9]|10)(?:px)/.test(previewCss) &&
  previewCss.includes('@media(prefers-reduced-motion:reduce)')
);

check('all four html surfaces have an authoritative v2 path',
  shellHtml.includes('/unified-ui-system.css') &&
  server.includes("versioned('/unified-ui-system.css')") &&
  manual.includes('/manual-ui-v2.css') &&
  preview.includes('/preview-ui-v2.css')
);

check('full syntax wall includes authoritative ui contract',pkg.includes('check:unified-ui'));

if(failed){console.error('Authoritative UI contract failed: '+failed);process.exit(1)}
console.log('Authoritative UI contract passed.');
