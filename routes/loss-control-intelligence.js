'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
const today=()=>new Date().toISOString().slice(0,10);
const daysAgo=n=>new Date(Date.now()-Math.max(0,Number(n)||0)*86400000).toISOString().slice(0,10);
let readyPromise=null;
async function tableExists(executor,name){const {rows:[r]}=await executor.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",args:[name]});return !!r;}
async function settingNumber(key,fallback){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const n=Number(r?.value);return Number.isFinite(n)?n:fallback;}
async function ensureLossControl(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS loss_control_cases(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_key TEXT NOT NULL UNIQUE,
      signal_type TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      branch_id INTEGER REFERENCES branches(id),
      employee_id INTEGER REFERENCES employees(id),
      supplier_id INTEGER REFERENCES suppliers(id),
      customer_id INTEGER REFERENCES customers(id),
      product_id INTEGER REFERENCES products(id),
      source_type TEXT,
      source_id INTEGER,
      title TEXT NOT NULL,
      estimated_loss REAL NOT NULL DEFAULT 0,
      at_risk_value REAL NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      recommended_action TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      recovered_value REAL NOT NULL DEFAULT 0,
      assigned_employee_id INTEGER REFERENCES employees(id),
      first_detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      resolved_by_employee_id INTEGER REFERENCES employees(id)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS loss_control_case_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES loss_control_cases(id),
      event_type TEXT NOT NULL,
      employee_id INTEGER REFERENCES employees(id),
      details TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_loss_cases_status ON loss_control_cases(status,severity,category,last_detected_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_loss_cases_branch ON loss_control_cases(branch_id,category,last_detected_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_loss_case_events_case ON loss_control_case_events(case_id,id)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureLossControl();next();}catch(e){res.status(500).json({error:'Loss-control intelligence initialization failed',detail:e.message});}});
function period(req){const end=String(req.query.end||req.body?.end||today()),days=Number(req.query.days||req.body?.days||30),start=String(req.query.start||req.body?.start||daysAgo(days));const branchId=Number(req.query.branch_id||req.body?.branch_id)||null;return {start,end,branchId};}
function signalKey(parts){return crypto.createHash('sha256').update(parts.map(v=>String(v??'')).join('|')).digest('hex');}
function severityFor(value,{high=100000,medium=25000}={}){const n=Math.abs(Number(value)||0);return n>=high?'high':n>=medium?'medium':'low';}

async function inventoryShrinkageSignals(p){
  if(!(await tableExists(db,'cycle_count_sessions'))||!(await tableExists(db,'cycle_count_items')))return [];
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND cc.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT cc.id session_id,cc.session_number,cc.branch_id,b.name branch_name,ci.id item_id,ci.product_id,ci.product_name,ci.sku,ci.variance,p.cost,p.price,COALESCE(ctl.approved_at,ctl.completed_at,cc.created_at) detected_at
    FROM cycle_count_sessions cc JOIN cycle_count_items ci ON ci.session_id=cc.id LEFT JOIN cycle_count_controls ctl ON ctl.session_id=cc.id LEFT JOIN products p ON p.id=ci.product_id LEFT JOIN branches b ON b.id=cc.branch_id
    WHERE cc.status='committed' AND COALESCE(ci.variance,0)<0 AND date(COALESCE(ctl.approved_at,ctl.completed_at,cc.created_at)) BETWEEN date(?) AND date(?)${branch}
    ORDER BY ABS(ci.variance*COALESCE(p.cost,0)) DESC`,args});
  return rows.map(x=>{const qty=Math.abs(Number(x.variance||0)),loss=r2(qty*Number(x.cost||0)),retail=r2(qty*Number(x.price||0));return {signal_key:signalKey(['cycle_shrink',x.item_id]),signal_type:'cycle_count_shortage',category:'inventory_shrinkage',severity:severityFor(loss),branch_id:x.branch_id,product_id:x.product_id,source_type:'cycle_count_item',source_id:x.item_id,title:`Physical count shortage: ${x.product_name||x.sku||'inventory item'}`,estimated_loss:loss,at_risk_value:Math.max(0,retail-loss),evidence:{session_id:x.session_id,session_number:x.session_number,book_to_physical_variance:Number(x.variance),missing_quantity:qty,cost_per_unit:Number(x.cost||0),retail_per_unit:Number(x.price||0),branch_name:x.branch_name,detected_at:x.detected_at},recommended_action:'Review serial/lot identity, transfers, sales, adjustments and write-offs since the prior verified count. Treat this as an inventory discrepancy, not an employee misconduct finding.'};});
}
async function writeoffSignals(p){
  if(!(await tableExists(db,'inventory_writeoffs')))return [];
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND w.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT w.*,p.name product_name,p.sku,p.cost,b.name branch_name FROM inventory_writeoffs w JOIN products p ON p.id=w.product_id LEFT JOIN branches b ON b.id=w.branch_id
    WHERE w.status='approved' AND date(COALESCE(w.approved_at,w.created_at)) BETWEEN date(?) AND date(?)${branch}
    ORDER BY COALESCE(NULLIF(w.tracked_value,0),w.quantity*COALESCE(p.cost,0)) DESC`,args});
  return rows.map(w=>{const loss=r2(Number(w.tracked_value||0)>0?Number(w.tracked_value):Number(w.quantity||0)*Number(w.cost||0));return {signal_key:signalKey(['writeoff',w.id]),signal_type:'approved_writeoff',category:'inventory_writeoff',severity:severityFor(loss),branch_id:w.branch_id,product_id:w.product_id,source_type:'inventory_writeoff',source_id:w.id,title:`Inventory write-off: ${w.product_name}`,estimated_loss:loss,at_risk_value:0,evidence:{writeoff_number:w.writeoff_number,quantity:Number(w.quantity||0),reason_code:w.reason_code,reason_detail:w.reason_detail,source_status:w.source_status,valuation_status:w.valuation_status,branch_name:w.branch_name},recommended_action:w.reason_code==='expiration'||w.reason_code==='obsolescence'?'Review replenishment, demand forecasting and transfer opportunities before future stock reaches the same state.':'Review the operational cause and whether prevention, recovery, warranty, supplier claim or process correction is available.'};});
}
async function pricingSignals(p){
  if(!(await tableExists(db,'transactions'))||!(await tableExists(db,'transaction_items')))return [];
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND t.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT t.id transaction_id,t.transaction_number,t.branch_id,t.employee_id,t.discount_amount,t.subtotal,t.created_at,b.name branch_name,e.first_name||' '||e.last_name employee_name,
      ti.id item_id,ti.product_id,ti.product_name,ti.sku,ti.quantity,ti.total line_gross,p.cost,
      CASE WHEN COALESCE(t.subtotal,0)>0 THEN COALESCE(t.discount_amount,0)*(COALESCE(ti.total,0)/t.subtotal) ELSE 0 END allocated_order_discount
    FROM transactions t JOIN transaction_items ti ON ti.transaction_id=t.id LEFT JOIN products p ON p.id=ti.product_id LEFT JOIN branches b ON b.id=t.branch_id LEFT JOIN employees e ON e.id=t.employee_id
    WHERE t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${branch}`,args});
  const out=[];for(const x of rows){const cost=r2(Number(x.cost||0)*Number(x.quantity||0)),discount=r2(x.allocated_order_discount),net=r2(Number(x.line_gross||0)-discount),loss=r2(Math.max(0,cost-net));if(loss<=0.009)continue;out.push({signal_key:signalKey(['below_cost',x.item_id]),signal_type:'below_cost_sale',category:'pricing_margin',severity:severityFor(loss,{high:25000,medium:5000}),branch_id:x.branch_id,employee_id:x.employee_id,product_id:x.product_id,source_type:'transaction_item',source_id:x.item_id,title:`Below-cost sale: ${x.product_name}`,estimated_loss:loss,at_risk_value:0,evidence:{transaction_id:x.transaction_id,transaction_number:x.transaction_number,quantity:Number(x.quantity||0),inventory_cost:cost,line_gross:r2(x.line_gross),allocated_order_discount:discount,effective_revenue:net,employee_name:x.employee_name,branch_name:x.branch_name,created_at:x.created_at},recommended_action:'Confirm whether this was an approved clearance, warranty/customer-service decision, promotion, data error or unauthorized margin override. Do not treat the signal alone as misconduct.'});}return out;
}
async function procurementSignals(p){
  if(!(await tableExists(db,'procurement_outcome_snapshots')))return [];
  const {rows}=await db.execute({sql:`SELECT o.*,r.decision_key,r.approved_by_employee_id FROM procurement_outcome_snapshots o JOIN procurement_decision_reviews r ON r.id=o.review_id
    WHERE o.id IN (SELECT MAX(id) FROM procurement_outcome_snapshots WHERE date(captured_at) BETWEEN date(?) AND date(?) GROUP BY review_id) AND COALESCE(o.cost_variance,0)>0 ORDER BY o.cost_variance DESC`,args:[p.start,p.end]});
  return rows.map(o=>({signal_key:signalKey(['procurement_variance',o.review_id,o.id]),signal_type:'adverse_procurement_variance',category:'purchasing',severity:severityFor(o.cost_variance),source_type:'procurement_outcome_snapshot',source_id:o.id,title:`Procurement landed-cost overrun: ${o.decision_key}`,estimated_loss:r2(o.cost_variance),at_risk_value:0,evidence:{review_id:o.review_id,expected_landed_cost:Number(o.expected_landed_cost||0),actual_landed_cost:Number(o.actual_landed_cost||0),variance_pct:Number(o.cost_variance_pct||0),shortage_units:Number(o.shortage_units||0),overage_units:Number(o.overage_units||0),rejected_units:Number(o.rejected_units||0),average_delivery_variance_days:o.average_delivery_variance_days},recommended_action:'Compare the approved supplier recommendation with the PO, receipt, freight/duty evidence and supplier performance to identify the reason for the overrun.'}));
}
async function cashSignals(p){
  if(!(await tableExists(db,'drawer_sessions'))||!(await tableExists(db,'drawer_reconciliations')))return [];
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND ds.branch_id=?';args.push(p.branchId);}
  const hasRefunds=await tableExists(db,'retail_refund_settlements')&&await tableExists(db,'retail_refund_settlement_legs');
  const refundExpr=hasRefunds?`COALESCE((SELECT SUM(rsl.amount) FROM retail_refund_settlement_legs rsl JOIN retail_refund_settlements rs ON rs.id=rsl.settlement_id WHERE rsl.payment_method='cash' AND rs.settled_by_employee_id=ds.employee_id AND COALESCE(rs.branch_id,ds.branch_id)=ds.branch_id AND datetime(rs.settled_at)>=datetime(ds.opened_at) AND datetime(rs.settled_at)<=datetime(COALESCE(ds.closed_at,CURRENT_TIMESTAMP))),0)`:'0';
  const {rows}=await db.execute({sql:`SELECT ds.id session_id,ds.drawer_id,ds.branch_id,ds.employee_id,ds.opening_float,ds.opened_at,ds.closed_at,d.name drawer_name,b.name branch_name,e.first_name||' '||e.last_name employee_name,dr.cash_counted,
      COALESCE((SELECT SUM(amount) FROM transaction_payments tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.drawer_session_id=ds.id AND t.status='completed' AND tp.payment_method='cash'),0)+
      COALESCE((SELECT SUM(t.total) FROM transactions t WHERE t.drawer_session_id=ds.id AND t.status='completed' AND t.payment_method='cash' AND NOT EXISTS(SELECT 1 FROM transaction_payments tp WHERE tp.transaction_id=t.id)),0) cash_sales,
      ${refundExpr} cash_refunds
    FROM drawer_sessions ds JOIN drawer_reconciliations dr ON dr.session_id=ds.id LEFT JOIN cash_drawers d ON d.id=ds.drawer_id LEFT JOIN branches b ON b.id=ds.branch_id LEFT JOIN employees e ON e.id=ds.employee_id
    WHERE ds.status='reconciled' AND date(COALESCE(ds.closed_at,ds.opened_at)) BETWEEN date(?) AND date(?)${branch}`,args});
  const threshold=await settingNumber('loss_control_cash_shortage_threshold',1);const out=[];for(const x of rows){const expected=r2(Number(x.opening_float||0)+Number(x.cash_sales||0)-Number(x.cash_refunds||0)),counted=r2(x.cash_counted),variance=r2(counted-expected);if(variance>=-Math.abs(threshold))continue;const shortage=r2(Math.abs(variance));out.push({signal_key:signalKey(['drawer_shortage',x.session_id]),signal_type:'drawer_cash_shortage',category:'cash_control',severity:severityFor(shortage,{high:10000,medium:2000}),branch_id:x.branch_id,employee_id:x.employee_id,source_type:'drawer_session',source_id:x.session_id,title:`Cash reconciliation shortage: ${x.drawer_name||`drawer ${x.drawer_id}`}`,estimated_loss:shortage,at_risk_value:0,evidence:{opening_float:Number(x.opening_float||0),cash_sales:r2(x.cash_sales),cash_refunds:r2(x.cash_refunds),expected_cash:expected,cash_counted:counted,variance,employee_name:x.employee_name,branch_name:x.branch_name,opened_at:x.opened_at,closed_at:x.closed_at,refund_assignment_basis:hasRefunds?'Cash refunds are inferred from the same employee/branch inside the drawer-session time window.':'Refund settlement tables unavailable.'},recommended_action:'Recount the drawer and review cash sales, cash refunds, handoffs and any documented cash movements for this session. Repeated shortages warrant process investigation; this signal does not by itself establish theft.'});}return out;
}
async function returnRiskSignals(p){
  if(!(await tableExists(db,'returns'))||!(await tableExists(db,'retail_return_allocations')))return [];
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND r.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT r.employee_id,e.first_name||' '||e.last_name employee_name,r.branch_id,b.name branch_name,COUNT(*) return_count,COALESCE(SUM(a.customer_entitlement_total),0) return_value,
      COALESCE((SELECT SUM(t.total) FROM transactions t WHERE t.employee_id=r.employee_id AND t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)${p.branchId?' AND t.branch_id=?':''}),0) employee_sales
    FROM returns r JOIN retail_return_allocations a ON a.return_id=r.id LEFT JOIN employees e ON e.id=r.employee_id LEFT JOIN branches b ON b.id=r.branch_id
    WHERE COALESCE(r.status,'completed')!='cancelled' AND date(r.created_at) BETWEEN date(?) AND date(?)${branch} GROUP BY r.employee_id,r.branch_id ORDER BY return_value DESC`,args:[p.start,p.end,...(p.branchId?[p.branchId]:[]),...args]});
  const threshold=await settingNumber('loss_control_return_rate_threshold_pct',15);const minimum=await settingNumber('loss_control_return_value_threshold',10000);return rows.filter(x=>Number(x.return_value||0)>=minimum&&Number(x.employee_sales||0)>0&&100*Number(x.return_value)/Number(x.employee_sales)>=threshold).map(x=>{const rate=Number((100*Number(x.return_value)/Number(x.employee_sales)).toFixed(2));return {signal_key:signalKey(['return_concentration',x.employee_id,x.branch_id,p.start,p.end]),signal_type:'return_value_concentration',category:'returns_refunds',severity:rate>=30?'high':rate>=20?'medium':'low',branch_id:x.branch_id,employee_id:x.employee_id,source_type:'employee_return_period',source_id:x.employee_id,title:`High return/refund concentration for ${x.employee_name||'employee'}`,estimated_loss:0,at_risk_value:r2(x.return_value),evidence:{period_start:p.start,period_end:p.end,return_count:Number(x.return_count||0),return_value:r2(x.return_value),completed_sales_value:r2(x.employee_sales),return_to_sales_pct:rate,branch_name:x.branch_name},recommended_action:'Review the underlying returns for product/customer patterns, valid service reasons, serial/lot evidence and refund settlement. A high rate is an anomaly signal, not proof of improper behavior.'};});
}
async function deadStockSignals(p){
  if(!(await tableExists(db,'branch_inventory'))||!(await tableExists(db,'transaction_items')))return [];
  const staleDays=await settingNumber('loss_control_dead_stock_days',180),cutoff=daysAgo(staleDays);const args=[];let branch='';if(p.branchId){branch=' AND bi.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT bi.product_id,bi.branch_id,bi.stock_qty,p.name product_name,p.sku,p.cost,p.price,b.name branch_name,MAX(CASE WHEN t.status='completed' THEN t.created_at END) last_sale_at
    FROM branch_inventory bi JOIN products p ON p.id=bi.product_id LEFT JOIN branches b ON b.id=bi.branch_id LEFT JOIN transaction_items ti ON ti.product_id=p.id LEFT JOIN transactions t ON t.id=ti.transaction_id AND t.branch_id=bi.branch_id
    WHERE p.active=1 AND COALESCE(p.is_service,0)=0 AND COALESCE(p.is_non_inventory,0)=0 AND COALESCE(bi.stock_qty,0)>0${branch}
    GROUP BY bi.product_id,bi.branch_id HAVING last_sale_at IS NULL OR date(last_sale_at)<date(?) ORDER BY bi.stock_qty*COALESCE(p.cost,0) DESC LIMIT 500`,args:[...args,cutoff]});
  return rows.map(x=>{const cash=r2(Number(x.stock_qty||0)*Number(x.cost||0));return {signal_key:signalKey(['dead_stock',x.product_id,x.branch_id]),signal_type:'dead_stock_capital',category:'working_capital',severity:severityFor(cash),branch_id:x.branch_id,product_id:x.product_id,source_type:'branch_inventory',source_id:x.product_id,title:`Dead/slow stock capital: ${x.product_name}`,estimated_loss:0,at_risk_value:cash,evidence:{quantity:Number(x.stock_qty||0),unit_cost:Number(x.cost||0),retail_value:r2(Number(x.stock_qty||0)*Number(x.price||0)),last_sale_at:x.last_sale_at,stale_days_threshold:staleDays,branch_name:x.branch_name},recommended_action:'Check demand, duplicate/superseded SKU status and other-branch demand. Consider transfer, bundle, markdown, supplier return or reorder suppression before writing the stock off.'};});
}
async function collectSignals(p){const groups=await Promise.all([inventoryShrinkageSignals(p),writeoffSignals(p),pricingSignals(p),procurementSignals(p),cashSignals(p),returnRiskSignals(p),deadStockSignals(p)]);return groups.flat().sort((a,b)=>(Number(b.estimated_loss)+Number(b.at_risk_value))-(Number(a.estimated_loss)+Number(a.at_risk_value)));}
async function upsertSignal(s,actor){
  const {rows:[existing]}=await db.execute({sql:'SELECT id,status FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});
  if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,branch_id=?,employee_id=?,supplier_id=?,customer_id=?,product_id=?,source_type=?,source_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null,existing.id]});return existing.id;}
  const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,branch_id,employee_id,supplier_id,customer_id,product_id,source_type,source_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null]});const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',actor||null,'Loss-control signal created from system evidence.']});return id;
}
router.get('/signals',async(req,res)=>{try{const p=period(req),signals=await collectSignals(p);res.json({period:p,count:signals.length,signals,warning:'Signals identify financial discrepancies, realized losses, or risk patterns. They are not employee misconduct determinations.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/scan',async(req,res)=>{try{const p=period(req),signals=await collectSignals(p),ids=[];for(const s of signals)ids.push(await upsertSignal(s,req.employee?.id));res.json({period:p,detected:signals.length,case_ids:ids,message:'Signals were recorded for human review; no disciplinary, purchasing, inventory, refund, or accounting action was performed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
router.get('/summary',async(req,res)=>{try{const p=period(req),signals=await collectSignals(p),loss=r2(signals.reduce((s,x)=>s+Number(x.estimated_loss||0),0)),risk=r2(signals.reduce((s,x)=>s+Number(x.at_risk_value||0),0));const byCategory={};for(const x of signals){const c=byCategory[x.category]||(byCategory[x.category]={signals:0,detected_loss:0,at_risk_value:0});c.signals++;c.detected_loss=r2(c.detected_loss+Number(x.estimated_loss||0));c.at_risk_value=r2(c.at_risk_value+Number(x.at_risk_value||0));}const {rows:[cases]}=await db.execute({sql:`SELECT COUNT(*) unresolved_cases,COALESCE(SUM(CASE WHEN status='resolved' THEN recovered_value ELSE 0 END),0) recovered_value FROM loss_control_cases`,args:[]});res.json({period:p,detected_loss:loss,at_risk_value:risk,recovered_value:r2(cases?.recovered_value),unresolved_cases:Number(cases?.unresolved_cases||0),signal_count:signals.length,by_category:byCategory,basis:'Detected loss includes evidence-backed shortages, approved write-offs, below-cost sales, adverse procurement outcome variance and drawer shortages. At-risk value includes anomaly exposure such as concentrated returns and dead/slow inventory; it is not assumed to be lost.',warning:'This control center identifies anomalies and financial evidence. It must not be used as a standalone determination of employee wrongdoing.'});}catch(e){res.status(500).json({error:e.message});}});
router.get('/cases',async(req,res)=>{try{const args=[];let sql=`SELECT c.*,b.name branch_name,e.first_name||' '||e.last_name employee_name,s.name supplier_name,p.name product_name FROM loss_control_cases c LEFT JOIN branches b ON b.id=c.branch_id LEFT JOIN employees e ON e.id=c.employee_id LEFT JOIN suppliers s ON s.id=c.supplier_id LEFT JOIN products p ON p.id=c.product_id WHERE 1=1`;if(req.query.status){sql+=' AND c.status=?';args.push(req.query.status);}if(req.query.category){sql+=' AND c.category=?';args.push(req.query.category);}if(req.query.branch_id){sql+=' AND c.branch_id=?';args.push(req.query.branch_id);}sql+=' ORDER BY CASE c.severity WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END,(c.estimated_loss+c.at_risk_value) DESC,c.last_detected_at DESC LIMIT 1000';const {rows}=await db.execute({sql,args});for(const r of rows){try{r.evidence=JSON.parse(r.evidence_json||'{}');}catch{r.evidence={};}delete r.evidence_json;}res.json(rows);}catch(e){res.status(500).json({error:e.message});}});
router.get('/cases/:id',async(req,res)=>{try{const {rows:[row]}=await db.execute({sql:'SELECT * FROM loss_control_cases WHERE id=?',args:[req.params.id]});if(!row)return res.status(404).json({error:'Loss-control case not found'});const {rows:events}=await db.execute({sql:'SELECT * FROM loss_control_case_events WHERE case_id=? ORDER BY id',args:[row.id]});try{row.evidence=JSON.parse(row.evidence_json||'{}');}catch{row.evidence={};}delete row.evidence_json;row.events=events;res.json(row);}catch(e){res.status(500).json({error:e.message});}});
router.patch('/cases/:id',async(req,res)=>{try{const allowed=new Set(['open','investigating','resolved','dismissed']);const status=String(req.body?.status||'').trim();if(status&&!allowed.has(status))return res.status(400).json({error:'status must be open, investigating, resolved, or dismissed'});const {rows:[row]}=await db.execute({sql:'SELECT * FROM loss_control_cases WHERE id=?',args:[req.params.id]});if(!row)return res.status(404).json({error:'Loss-control case not found'});const recovered=req.body?.recovered_value==null?Number(row.recovered_value||0):Number(req.body.recovered_value);if(!Number.isFinite(recovered)||recovered<0)return res.status(400).json({error:'recovered_value must be zero or greater'});const nextStatus=status||row.status,note=String(req.body?.resolution_note??row.resolution_note??'').trim()||null,assigned=req.body?.assigned_employee_id==null?row.assigned_employee_id:Number(req.body.assigned_employee_id)||null;await db.execute({sql:`UPDATE loss_control_cases SET status=?,resolution_note=?,recovered_value=?,assigned_employee_id=?,resolved_at=CASE WHEN ? IN ('resolved','dismissed') THEN COALESCE(resolved_at,CURRENT_TIMESTAMP) ELSE NULL END,resolved_by_employee_id=CASE WHEN ? IN ('resolved','dismissed') THEN ? ELSE NULL END WHERE id=?`,args:[nextStatus,note,r2(recovered),assigned,nextStatus,nextStatus,req.employee?.id||null,row.id]});await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[row.id,'status_changed',req.employee?.id||null,JSON.stringify({from:row.status,to:nextStatus,recovered_value:r2(recovered),note})]});const {rows:[saved]}=await db.execute({sql:'SELECT * FROM loss_control_cases WHERE id=?',args:[row.id]});res.json(saved);}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
module.exports.ensureLossControl=ensureLossControl;
module.exports.collectSignals=collectSignals;
