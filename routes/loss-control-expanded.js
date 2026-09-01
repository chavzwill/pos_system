'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
const daysAgo=n=>new Date(Date.now()-Math.max(0,Number(n)||0)*86400000).toISOString().slice(0,10);
const key=parts=>crypto.createHash('sha256').update(parts.map(x=>String(x??'')).join('|')).digest('hex');
async function table(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
async function settingNumber(k,d){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[k]});const n=Number(r?.value);return Number.isFinite(n)?n:d;}
function period(req){const end=String(req.query.end||new Date().toISOString().slice(0,10)),days=Number(req.query.days||30),start=String(req.query.start||daysAgo(days)),branchId=Number(req.query.branch_id)||null;return {start,end,branchId};}
function normalizeInvoice(v){return String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');}

async function supplierDuplicateSignals(p){
  if(!(await table('supplier_invoices')))return [];
  const args=[p.start,p.end],where=p.branchId?' AND si.branch_id=?':'';if(p.branchId)args.push(p.branchId);
  const {rows}=await db.execute({sql:`SELECT si.*,s.name supplier_name FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id WHERE si.status!='void' AND date(si.invoice_date) BETWEEN date(?) AND date(?)${where} ORDER BY si.supplier_id,si.invoice_date,si.id`,args});
  const groups=new Map();for(const row of rows){const k=`${row.supplier_id}|${normalizeInvoice(row.invoice_number)}`;if(!normalizeInvoice(row.invoice_number))continue;const a=groups.get(k)||[];a.push(row);groups.set(k,a);}
  const out=[];for(const a of groups.values()){if(a.length<2)continue;const exposure=r2(a.slice(1).reduce((s,x)=>s+Number(x.total||0),0));out.push({signal_key:key(['supplier_duplicate_invoice',a[0].supplier_id,normalizeInvoice(a[0].invoice_number)]),signal_type:'supplier_duplicate_invoice',category:'supplier_ap',severity:exposure>=100000?'high':'medium',supplier_id:a[0].supplier_id,branch_id:a[0].branch_id,estimated_loss:0,at_risk_value:exposure,title:`Potential duplicate supplier invoice: ${a[0].supplier_name}`,evidence:{normalized_invoice_number:normalizeInvoice(a[0].invoice_number),invoice_ids:a.map(x=>x.id),invoice_numbers:a.map(x=>x.invoice_number),totals:a.map(x=>Number(x.total||0))},recommended_action:'Confirm whether these are duplicate billings, legitimate revisions/credit-rebill documents, or separate invoices before any additional payment is released.'});}return out;
}

async function supplierMatchSignals(p){
  if(!(await table('supplier_invoices'))||!(await table('purchase_orders')))return [];
  const hasReceipts=await table('purchase_receipt_items')&&await table('purchase_receipts');
  const args=[p.start,p.end],where=p.branchId?' AND si.branch_id=?':'';if(p.branchId)args.push(p.branchId);
  const receiptExpr=hasReceipts?`COALESCE((SELECT SUM(pri.line_cost) FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id=pri.receipt_id WHERE pr.po_id=po.id),0)`:'0';
  const {rows}=await db.execute({sql:`SELECT si.id invoice_id,si.invoice_number,si.supplier_id,si.branch_id,si.purchase_order_id,si.subtotal invoice_subtotal,si.total invoice_total,s.name supplier_name,po.po_number,po.subtotal po_subtotal,${receiptExpr} received_value,
    COALESCE((SELECT SUM(si2.subtotal) FROM supplier_invoices si2 WHERE si2.purchase_order_id=po.id AND si2.status!='void' AND si2.id<si.id),0) prior_billed
    FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id LEFT JOIN purchase_orders po ON po.id=si.purchase_order_id
    WHERE si.status!='void' AND date(si.invoice_date) BETWEEN date(?) AND date(?)${where} ORDER BY si.id`,args});
  const out=[];for(const x of rows){if(!x.purchase_order_id){out.push({signal_key:key(['supplier_invoice_no_po',x.invoice_id]),signal_type:'supplier_invoice_without_po',category:'supplier_ap',severity:'medium',supplier_id:x.supplier_id,branch_id:x.branch_id,source_type:'supplier_invoice',source_id:x.invoice_id,estimated_loss:0,at_risk_value:r2(x.invoice_total),title:`Supplier invoice has no PO match: ${x.invoice_number}`,evidence:{supplier_name:x.supplier_name,invoice_total:Number(x.invoice_total||0)},recommended_action:'Verify authorization, business purpose, receiving evidence and duplicate status before payment.'});continue;}const remainingPo=r2(Math.max(0,Number(x.po_subtotal||0)-Number(x.prior_billed||0))),remainingReceipt=r2(Math.max(0,Number(x.received_value||0)-Number(x.prior_billed||0))),invoice=r2(x.invoice_subtotal),poOver=r2(Math.max(0,invoice-remainingPo)),receiptOver=hasReceipts?r2(Math.max(0,invoice-remainingReceipt)):0,exposure=Math.max(poOver,receiptOver);if(exposure<=0.01)continue;out.push({signal_key:key(['supplier_invoice_overmatch',x.invoice_id]),signal_type:'supplier_invoice_overmatch',category:'supplier_ap',severity:exposure>=100000?'high':'medium',supplier_id:x.supplier_id,branch_id:x.branch_id,source_type:'supplier_invoice',source_id:x.invoice_id,estimated_loss:0,at_risk_value:exposure,title:`Supplier invoice exceeds PO/receipt evidence: ${x.invoice_number}`,evidence:{supplier_name:x.supplier_name,po_number:x.po_number,invoice_merchandise:invoice,remaining_po_value:remainingPo,remaining_received_value:remainingReceipt,prior_billed:Number(x.prior_billed||0),potential_overbilling:exposure},recommended_action:'Hold payment until Purchasing/AP verifies the invoice against PO terms, receiving evidence, shortages, freight/duty and any approved exception.'});}return out;
}

async function transferSignals(p){
  if(!(await table('branch_transfers'))||!(await table('branch_transfer_items')))return [];
  const staleDays=await settingNumber('loss_control_transfer_in_transit_days',3),args=[daysAgo(staleDays)];let where='';if(p.branchId){where=' AND (t.from_branch_id=? OR t.to_branch_id=?)';args.push(p.branchId,p.branchId);}
  const {rows}=await db.execute({sql:`SELECT t.id,t.transfer_number,t.from_branch_id,t.to_branch_id,t.status,t.created_at,fb.name from_branch,tb.name to_branch,
      COALESCE(SUM(MAX(0,i.quantity_requested-COALESCE(i.quantity_received,0))*COALESCE(p.cost,0)),0) unresolved_cost,
      COALESCE(SUM(MAX(0,i.quantity_requested-COALESCE(i.quantity_received,0))),0) unresolved_qty
    FROM branch_transfers t JOIN branch_transfer_items i ON i.transfer_id=t.id LEFT JOIN products p ON p.id=i.product_id LEFT JOIN branches fb ON fb.id=t.from_branch_id LEFT JOIN branches tb ON tb.id=t.to_branch_id
    WHERE t.status='in_transit' AND date(t.created_at)<=date(?)${where} GROUP BY t.id HAVING unresolved_qty>0 ORDER BY unresolved_cost DESC`,args});
  return rows.map(x=>({signal_key:key(['stale_transfer',x.id]),signal_type:'stale_in_transit_inventory',category:'inventory_transfer',severity:Number(x.unresolved_cost)>=100000?'high':'medium',branch_id:x.to_branch_id,source_type:'branch_transfer',source_id:x.id,estimated_loss:0,at_risk_value:r2(x.unresolved_cost),title:`Transfer remains unresolved: ${x.transfer_number}`,evidence:{from_branch:x.from_branch,to_branch:x.to_branch,unresolved_quantity:Number(x.unresolved_qty||0),unresolved_cost_value:r2(x.unresolved_cost),created_at:x.created_at,threshold_days:staleDays},recommended_action:'Confirm physical custody, dispatch evidence and destination receipt. Escalate aged discrepancies to a cycle count/transfer investigation before writing stock off.'}));
}

async function taxSignals(p){
  if(!(await table('transactions')))return [];
  const args=[p.start,p.end],where=p.branchId?' AND t.branch_id=?':'';if(p.branchId)args.push(p.branchId);
  const {rows}=await db.execute({sql:`SELECT t.id,t.transaction_number,t.branch_id,t.employee_id,t.total,t.subtotal,t.tax_amount,t.tax_exempt,t.tax_exemption_number,t.created_at,b.name branch_name,e.first_name||' '||e.last_name employee_name FROM transactions t LEFT JOIN branches b ON b.id=t.branch_id LEFT JOIN employees e ON e.id=t.employee_id WHERE t.status='completed' AND t.tax_exempt=1 AND date(t.created_at) BETWEEN date(?) AND date(?)${where} AND TRIM(COALESCE(t.tax_exemption_number,''))='' ORDER BY t.total DESC`,args});
  return rows.map(x=>({signal_key:key(['tax_exempt_missing_evidence',x.id]),signal_type:'tax_exemption_missing_evidence',category:'tax_control',severity:'high',branch_id:x.branch_id,employee_id:x.employee_id,source_type:'transaction',source_id:x.id,estimated_loss:0,at_risk_value:r2(x.subtotal),title:`Tax-exempt sale missing exemption evidence: ${x.transaction_number}`,evidence:{sale_total:Number(x.total||0),tax_charged:Number(x.tax_amount||0),employee_name:x.employee_name,branch_name:x.branch_name,created_at:x.created_at},recommended_action:'Verify the customer exemption certificate/number and applicable tax treatment. Correct the transaction/accounting record if the exemption was not valid.'}));
}

async function arSignals(p){
  if(!(await table('customers'))||!(await table('transactions')))return [];
  const overDays=await settingNumber('loss_control_ar_high_risk_days',90);
  const {rows}=await db.execute({sql:`SELECT c.id customer_id,c.customer_number,c.first_name||' '||c.last_name customer_name,c.account_balance,c.credit_limit,
    COALESCE(SUM(CASE WHEN t.payment_method='credit' AND t.status='completed' AND julianday('now')-julianday(t.created_at)>? THEN MAX(0,t.total-COALESCE(a.paid,0)) ELSE 0 END),0) aged_balance
    FROM customers c LEFT JOIN transactions t ON t.customer_id=c.id LEFT JOIN (SELECT transaction_id,SUM(amount) paid FROM payment_allocations GROUP BY transaction_id) a ON a.transaction_id=t.id
    WHERE c.active=1 AND c.credit_enabled=1 GROUP BY c.id HAVING aged_balance>0.01 ORDER BY aged_balance DESC`,args:[overDays]});
  return rows.map(x=>({signal_key:key(['aged_ar',x.customer_id,overDays]),signal_type:'aged_receivable_exposure',category:'accounts_receivable',severity:Number(x.aged_balance)>=100000?'high':'medium',customer_id:x.customer_id,estimated_loss:0,at_risk_value:r2(x.aged_balance),title:`Aged receivable exposure: ${x.customer_name}`,evidence:{customer_number:x.customer_number,aged_balance:r2(x.aged_balance),account_balance:r2(x.account_balance),credit_limit:r2(x.credit_limit),age_threshold_days:overDays},recommended_action:'Review collection activity, credit limit/block status, promised payment dates and whether additional credit sales should remain available.'}));
}

async function collect(p){const groups=await Promise.all([supplierDuplicateSignals(p),supplierMatchSignals(p),transferSignals(p),taxSignals(p),arSignals(p)]);return groups.flat().sort((a,b)=>(Number(b.estimated_loss||0)+Number(b.at_risk_value||0))-(Number(a.estimated_loss||0)+Number(a.at_risk_value||0)));}
async function ensureCaseTables(){if(await table('loss_control_cases'))return;throw new Error('Base loss-control module must initialize before expanded scan can record cases. Open /loss-control/summary once or retry after base initialization.');}
async function upsert(s,employeeId){await ensureCaseTables();const {rows:[existing]}=await db.execute({sql:'SELECT id FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,branch_id=?,employee_id=?,supplier_id=?,customer_id=?,product_id=?,source_type=?,source_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null,existing.id]});return existing.id;}const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,branch_id,employee_id,supplier_id,customer_id,product_id,source_type,source_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.branch_id||null,s.employee_id||null,s.supplier_id||null,s.customer_id||null,s.product_id||null,s.source_type||null,s.source_id||null,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence||{}),s.recommended_action||null]});const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',employeeId||null,'Expanded loss-control signal created from system evidence.']});return id;}

router.get('/expanded-signals',async(req,res)=>{try{const p=period(req),signals=await collect(p);res.json({period:p,count:signals.length,signals,warning:'These are financial-control and operational-risk signals. They require human review and do not establish fraud or misconduct.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/expanded-scan',async(req,res)=>{try{const p=period(req),signals=await collect(p),ids=[];for(const s of signals)ids.push(await upsert(s,req.employee?.id));res.json({period:p,detected:signals.length,case_ids:ids,message:'Expanded loss signals were recorded for human review. No supplier payment, transfer, tax, credit, inventory or disciplinary action was performed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
