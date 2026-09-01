// Server-side mirror of App._permissionTree / App.can() in public/index.html
// (search for "_permissionTree:" there). These two must be kept in sync by
// hand — the frontend is a single HTML file, so no code-sharing is possible.
// If you add a permission key to one, add it to the other.
const PERMISSION_TREE = [
  { key: 'dashboard', subs: [] },
  { key: 'pos', subs: [{ key: 'pos_discounts' }, { key: 'pos_refunds' }, { key: 'pos_void_items' }, { key: 'pos_hold' }] },
  { key: 'drawers', subs: [{ key: 'drawers_manage' }, { key: 'drawers_open' }, { key: 'drawers_close' }, { key: 'void_transactions' }] },
  { key: 'inventory', subs: [{ key: 'inventory_add' }, { key: 'inventory_edit' }, { key: 'inventory_delete' }, { key: 'inventory_adjust' }, { key: 'inventory_disposition' }, { key: 'inventory_writeoff_create' }, { key: 'inventory_writeoff_approve' }] },
  { key: 'customers', subs: [{ key: 'customers_add' }, { key: 'customers_edit' }, { key: 'customers_delete' }, { key: 'customers_credit' }, { key: 'customers_sensitive' }] },
  { key: 'transactions', subs: [{ key: 'transactions_export' }, { key: 'transactions_refund' }, { key: 'transactions_returns' }] },
  { key: 'reports', subs: [{ key: 'reports_export' }, { key: 'reports_financial' }] },
  { key: 'employees', subs: [{ key: 'employees_add' }, { key: 'employees_edit' }, { key: 'employees_delete' }, { key: 'employees_salaries' }] },
  { key: 'suppliers', subs: [{ key: 'suppliers_add' }, { key: 'suppliers_edit' }, { key: 'suppliers_delete' }] },
  { key: 'services', subs: [] },
  { key: 'rentals', subs: [{ key: 'rentals_manage_items' }, { key: 'rentals_checkout' }, { key: 'rentals_returns' }, { key: 'rentals_issue' }, { key: 'rentals_pause' }] },
  { key: 'work_orders', subs: [{ key: 'wo_intake' }, { key: 'wo_assess' }, { key: 'wo_assign_parts' }, { key: 'wo_technician' }, { key: 'wo_signoff' }] },
  { key: 'layaway', subs: [{ key: 'layaway_create' }, { key: 'layaway_payments' }, { key: 'layaway_cancel' }] },
  { key: 'purchase_requests', subs: [{ key: 'pr_create' }, { key: 'pr_approve' }, { key: 'pr_convert' }] },
  { key: 'purchasing', subs: [{ key: 'purchasing_create' }, { key: 'purchasing_approve' }, { key: 'purchasing_receive' }] },
  { key: 'transfers', subs: [{ key: 'transfers_create' }, { key: 'transfers_approve' }, { key: 'transfers_pickup' }, { key: 'transfers_dropoff' }] },
  { key: 'dispatch', subs: [{ key: 'dispatch_view' }, { key: 'dispatch_plan' }, { key: 'dispatch_execute' }, { key: 'dispatch_admin' }] },
  { key: 'quotations', subs: [{ key: 'quotations_create' }, { key: 'quotations_approve' }, { key: 'quotations_convert' }] },
  { key: 'accounts', subs: [{ key: 'accounts_create' }, { key: 'accounts_payments' }, { key: 'accounts_writeoff' }] },
  { key: 'crm', subs: [{ key: 'crm_leads' }, { key: 'crm_opportunities' }] },
  { key: 'commissions', subs: [{ key: 'commissions_plans' }, { key: 'commissions_approve' }, { key: 'commissions_pay' }] },
  { key: 'warehouse', subs: [{ key: 'warehouse_bins' }, { key: 'warehouse_assign' }] },
  { key: 'shipping', subs: [{ key: 'shipping_create' }, { key: 'shipping_carriers' }] },
  { key: 'cycle-counts', subs: [{ key: 'cyclecounts_create' }, { key: 'cyclecounts_approve' }] },
  { key: 'branches', subs: [{ key: 'branches_add' }, { key: 'branches_edit' }, { key: 'branches_delete' }] },
  { key: 'security', subs: [{ key: 'security_manage' }, { key: 'security_assign' }] },
  { key: 'promotions', subs: [{ key: 'promotions_create' }, { key: 'promotions_codes' }] },
  { key: 'discount-cards', subs: [] },
  { key: 'cash-back-cards', subs: [] },
  { key: 'settings', subs: [{ key: 'settings_company' }, { key: 'settings_tax' }, { key: 'settings_payment' }, { key: 'settings_integrations' }] },
];

const PERMISSION_ALIASES = { rentals_manage: 'rentals_manage_items' };
// These authorities intentionally do not inherit from their broad parent
// module. They protect high-sensitivity data/action boundaries.
const EXPLICIT_ONLY_PERMISSIONS = new Set(['customers_sensitive']);
const DISPATCH_KEYS=['dispatch','dispatch_view','dispatch_plan','dispatch_execute','dispatch_admin'];
function hasExplicitDispatch(permissions){return DISPATCH_KEYS.some(k=>Object.prototype.hasOwnProperty.call(permissions||{},k));}
function legacyDispatch(permissions,key){
  if(hasExplicitDispatch(permissions))return false;
  const full=!!permissions?.transfers,create=!!permissions?.transfers_create,approve=!!permissions?.transfers_approve,pickup=!!permissions?.transfers_pickup,dropoff=!!permissions?.transfers_dropoff;
  if(key==='dispatch_view')return full||create||approve||pickup||dropoff;
  if(key==='dispatch_plan')return full||create||approve;
  if(key==='dispatch_execute')return full||pickup||dropoff;
  if(key==='dispatch_admin')return full||approve;
  if(key==='dispatch')return full||create||approve||pickup||dropoff;
  return false;
}
function can(permissions, key) {
  if (!permissions) return false;
  key = PERMISSION_ALIASES[key] || key;
  if (EXPLICIT_ONLY_PERMISSIONS.has(key)) return permissions[key] === true;
  if(DISPATCH_KEYS.includes(key)&&legacyDispatch(permissions,key))return true;
  const mod = PERMISSION_TREE.find(m => m.key === key);
  if (mod) return !!permissions[key] || mod.subs.some(s => !!permissions[s.key]);
  const parent = PERMISSION_TREE.find(m => m.subs.some(s => s.key === key));
  if (parent) {
    if (Object.prototype.hasOwnProperty.call(permissions, key)) return !!permissions[key];
    return !!permissions[parent.key];
  }
  return !!permissions[key];
}

function dispatchRequirement(req){
  const url=String(req.originalUrl||'').split('?')[0];
  if(!url.startsWith('/api/logistics-intelligence'))return null;
  const p=url.slice('/api/logistics-intelligence'.length)||'/';
  if(/^\/from-(purchase-order|sales-invoice|rental|repair)\//.test(p))return 'source_handoff';
  if((req.method==='GET'||req.method==='HEAD')&&/^\/jobs\/\d+\/source-document(?:\/|$)/.test(p))return 'source_document';
  if(req.method==='GET'||req.method==='HEAD')return 'dispatch_view';
  if(/^\/vehicles(?:\/|$)/.test(p)||/^\/service-zones(?:\/|$)/.test(p)||/^\/locations\/\d+\/verify$/.test(p)||/^\/travel-evidence(?:\/|$)/.test(p))return 'dispatch_admin';
  if(/^\/jobs\/\d+\/(stage\/|proof|complete|failed|reschedule)/.test(p)||/^\/routes\/\d+\/(start|close|stops\/\d+\/(complete|skip|stage|proof))/.test(p))return 'dispatch_execute';
  if(p==='/jobs'||/^\/from-transfer\//.test(p)||/^\/jobs\/\d+$/.test(p)||/^\/jobs\/\d+\/assign$/.test(p)||/^\/routes(?:\/|$)/.test(p)||/^\/driver-shifts(?:\/|$)/.test(p))return 'dispatch_plan';
  return 'dispatch_unclassified';
}
function enforceDispatch(req,res){
  const required=dispatchRequirement(req);if(!required)return 'not_dispatch';
  if(required==='source_handoff')return 'continue';
  if(req.apiKey){res.status(403).json({error:'API keys cannot operate internal Dispatch workflows',control:'dispatch_rbac'});return 'denied';}
  if(!req.employee){res.status(401).json({error:'Authentication required'});return 'denied';}
  if(required==='source_document'){
    if(['dispatch_view','dispatch_plan','dispatch_execute','dispatch_admin','purchasing','transactions','rentals','work_orders'].some(k=>can(req.employee.permissions,k)))return 'allow';
    res.status(403).json({error:'Missing permission to view this Dispatch source document',control:'dispatch_rbac'});return 'denied';
  }
  if(required==='dispatch_unclassified'){
    res.status(403).json({error:'Dispatch mutation is not classified for RBAC',control:'dispatch_rbac_unclassified'});return 'denied';
  }
  const allowed=required==='dispatch_view'?[required,'dispatch_plan','dispatch_execute','dispatch_admin']:
    required==='dispatch_execute'?[required,'dispatch_plan','dispatch_admin']:[required,'dispatch_admin'];
  if(allowed.some(k=>can(req.employee.permissions,k)))return 'allow';
  res.status(403).json({error:`Missing permission: ${required}`,control:'dispatch_rbac'});return 'denied';
}

function requireAuth(req, res, next) {
  if (req.apiKey) return next();
  if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
  next();
}
function requirePermission(key) {
  return (req, res, next) => {
    const dispatch=enforceDispatch(req,res);
    if(dispatch==='denied')return;
    if(dispatch==='allow')return next();
    if (req.apiKey) return next();
    if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
    if (!can(req.employee.permissions, key)) return res.status(403).json({ error: `Missing permission: ${key}` });
    next();
  };
}
function requireAnyPermission(...keys) {
  return (req, res, next) => {
    const dispatch=enforceDispatch(req,res);
    if(dispatch==='denied')return;
    if(dispatch==='allow')return next();
    if (req.apiKey) return next();
    if (!req.employee) return res.status(401).json({ error: 'Authentication required' });
    if (!keys.some(key => can(req.employee.permissions, key))) return res.status(403).json({ error: `Missing permission: one of ${keys.join(', ')}` });
    next();
  };
}
module.exports = { PERMISSION_TREE, EXPLICIT_ONLY_PERMISSIONS, can, requireAuth, requirePermission, requireAnyPermission, dispatchRequirement, enforceDispatch };