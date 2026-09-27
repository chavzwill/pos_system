const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission } = require('../lib/permissions');
const { ensureCostAllocationSchema, recordInvoiceReconciliation } = require('../lib/cost-allocations');
const { ensureSupplierRecoverablesSchema } = require('../lib/supplier-recoverables');
const supplierCreditNotes = require('./supplier-credit-notes');

let schemaPromise = null;
async function ensureColumn(table,name,definition){
  const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});
  if(!rows.some(r=>String(r.name)===name))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,args:[]});
}
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async()=>{
    await ensureCostAllocationSchema();
    await ensureSupplierRecoverablesSchema();
    if (supplierCreditNotes.ensureSchema) await supplierCreditNotes.ensureSchema();
    await db.batch([
      { sql: `CREATE TABLE IF NOT EXISTS supplier_invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        purchase_order_id INTEGER REFERENCES purchase_orders(id),
        branch_id INTEGER REFERENCES branches(id),
        invoice_number TEXT NOT NULL,
        invoice_date DATE NOT NULL,
        due_date DATE,
        subtotal REAL NOT NULL DEFAULT 0,
        tax_amount REAL NOT NULL DEFAULT 0,
        freight_amount REAL NOT NULL DEFAULT 0,
        duty_amount REAL NOT NULL DEFAULT 0,
        other_landed_cost_amount REAL NOT NULL DEFAULT 0,
        tax_treatment TEXT,
        total REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'posted',
        notes TEXT,
        posted_by INTEGER REFERENCES employees(id),
        posted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(supplier_id, invoice_number)
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS supplier_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_number TEXT NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        branch_id INTEGER REFERENCES branches(id),
        payment_date DATE NOT NULL,
        amount REAL NOT NULL,
        payment_method TEXT,
        reference TEXT,
        notes TEXT,
        recorded_by INTEGER REFERENCES employees(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL REFERENCES supplier_payments(id),
        supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
        amount REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(payment_id, supplier_invoice_id)
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS supplier_ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        amount REAL,
        details TEXT,
        actor_employee_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_supplier_invoices_due ON supplier_invoices(status,due_date,supplier_id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id,payment_date)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_supplier_ledger_events_supplier ON supplier_ledger_events(supplier_id,created_at)' },
    ], 'write');
    await ensureColumn('supplier_invoices','freight_amount','REAL NOT NULL DEFAULT 0');
    await ensureColumn('supplier_invoices','duty_amount','REAL NOT NULL DEFAULT 0');
    await ensureColumn('supplier_invoices','other_landed_cost_amount','REAL NOT NULL DEFAULT 0');
    await ensureColumn('supplier_invoices','tax_treatment','TEXT');
    await ensureColumn('supplier_invoices','payment_terms_reference','TEXT');
    await ensureColumn('supplier_invoices','discount_deadline','DATE');
    await ensureColumn('supplier_invoices','discount_amount','REAL NOT NULL DEFAULT 0');
    await ensureColumn('supplier_invoices','late_fee_effective_date','DATE');
    await ensureColumn('supplier_invoices','late_fee_amount','REAL NOT NULL DEFAULT 0');
  })().catch(err => { schemaPromise = null; throw err; });
  return schemaPromise;
}

router.use(async (req,res,next)=>{ try { await ensureSchema(); next(); } catch(e) { res.status(500).json({error:'Supplier ledger initialization failed',detail:e.message}); } });

function actor(req){ return req.employee?.id || req.user?.employee_id || null; }
function paymentNumber(){ return `SP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`; }
function money(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):NaN;}

router.get('/overview', requirePermission('reports_financial'), async (req,res)=>{
  try {
    const branchId=req.query.branch_id?Number(req.query.branch_id):null;
    const args=[]; let branchWhere='1=1'; if(branchId){branchWhere='si.branch_id=?';args.push(branchId);}
    const {rows:[summary]}=await db.execute({sql:`SELECT
      COUNT(*) posted_invoices,
      COALESCE(SUM(si.total),0) invoiced_total,
      COALESCE(SUM(MAX(0,si.total-COALESCE(a.paid,0))),0) open_ap,
      COALESCE(SUM(CASE WHEN MAX(0,si.total-COALESCE(a.paid,0))>0.001 AND si.due_date IS NOT NULL AND date(si.due_date)<date('now') THEN MAX(0,si.total-COALESCE(a.paid,0)) ELSE 0 END),0) overdue_ap,
      COALESCE(SUM(CASE WHEN MAX(0,si.total-COALESCE(a.paid,0))>0.001 AND (si.due_date IS NULL OR date(si.due_date)>=date('now')) THEN MAX(0,si.total-COALESCE(a.paid,0)) ELSE 0 END),0) not_yet_due_ap
      FROM supplier_invoices si
      LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM (SELECT supplier_invoice_id,amount FROM supplier_payment_allocations UNION ALL SELECT supplier_invoice_id,amount FROM supplier_recoverable_ap_allocations) applied GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
      WHERE si.status!='void' AND ${branchWhere}`,args});
    const agingArgs=[]; let agingWhere="si.status!='void'"; if(branchId){agingWhere+=' AND si.branch_id=?';agingArgs.push(branchId);}
    const {rows:[aging]}=await db.execute({sql:`SELECT
      COALESCE(SUM(CASE WHEN age_days<=0 THEN balance ELSE 0 END),0) current_due,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 1 AND 30 THEN balance ELSE 0 END),0) days_1_30,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 31 AND 60 THEN balance ELSE 0 END),0) days_31_60,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 61 AND 90 THEN balance ELSE 0 END),0) days_61_90,
      COALESCE(SUM(CASE WHEN age_days>90 THEN balance ELSE 0 END),0) over_90
      FROM (
        SELECT si.id, MAX(0,si.total-COALESCE(a.paid,0)) balance,
          CASE WHEN si.due_date IS NULL THEN 0 ELSE CAST(julianday('now')-julianday(si.due_date) AS INTEGER) END age_days
        FROM supplier_invoices si LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM (SELECT supplier_invoice_id,amount FROM supplier_payment_allocations UNION ALL SELECT supplier_invoice_id,amount FROM supplier_recoverable_ap_allocations) applied GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
        WHERE ${agingWhere}
      ) x WHERE balance>0.001`,args:agingArgs});
    res.json({summary,aging,basis:'AP includes only supplier invoices formally posted in this ledger. Open purchase orders remain commitments and are not counted as payables until invoiced.'});
  } catch(e){res.status(500).json({error:e.message});}
});

router.get('/invoices', requirePermission('reports_financial'), async (req,res)=>{
  try{
    const {supplier_id,branch_id,status='open',limit=200}=req.query; const args=[];
    let sql=`SELECT si.*,s.name supplier_name,b.name branch_name,po.po_number,
      COALESCE(a.paid,0) paid_amount,MAX(0,si.total-COALESCE(a.paid,0)) balance_due
      FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id
      LEFT JOIN branches b ON b.id=si.branch_id LEFT JOIN purchase_orders po ON po.id=si.purchase_order_id
      LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM (SELECT supplier_invoice_id,amount FROM supplier_payment_allocations UNION ALL SELECT supplier_invoice_id,amount FROM supplier_recoverable_ap_allocations) applied GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
      WHERE si.status!='void'`;
    if(supplier_id){sql+=' AND si.supplier_id=?';args.push(supplier_id);} if(branch_id){sql+=' AND si.branch_id=?';args.push(branch_id);}
    if(status==='open')sql+=' AND MAX(0,si.total-COALESCE(a.paid,0))>0.001'; else if(status==='paid')sql+=' AND MAX(0,si.total-COALESCE(a.paid,0))<=0.001';
    sql+=' ORDER BY COALESCE(si.due_date,si.invoice_date),si.id DESC LIMIT ?';args.push(Math.min(Math.max(parseInt(limit)||200,1),500));
    const {rows}=await db.execute({sql,args}); res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/cash-forecast', requirePermission('reports_financial'), async (req,res)=>{
  try{
    const branchId=req.query.branch_id?Number(req.query.branch_id):null;
    const horizon=Math.min(Math.max(Number(req.query.horizon_days)||30,1),90);
    const invoiceArgs=[];let invoiceBranch='';
    if(branchId){invoiceBranch=' AND si.branch_id=?';invoiceArgs.push(branchId);}
    const {rows:invoices}=await db.execute({sql:`SELECT si.*,s.name supplier_name,
      COALESCE(a.paid,0) paid_amount,MAX(0,si.total-COALESCE(a.paid,0)) balance_due
      FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id
      LEFT JOIN (
        SELECT supplier_invoice_id,SUM(amount) paid FROM (
          SELECT supplier_invoice_id,amount FROM supplier_payment_allocations
          UNION ALL SELECT supplier_invoice_id,amount FROM supplier_recoverable_ap_allocations
        ) x GROUP BY supplier_invoice_id
      ) a ON a.supplier_invoice_id=si.id
      WHERE si.status!='void' AND MAX(0,si.total-COALESCE(a.paid,0))>0.001${invoiceBranch}
      ORDER BY si.supplier_id,CASE WHEN si.due_date IS NULL THEN 1 ELSE 0 END,si.due_date,si.invoice_date,si.id`,args:invoiceArgs});
    const recoverableArgs=[];let recoverableBranch='';
    if(branchId){recoverableBranch=' AND (c.branch_id=? OR c.branch_id IS NULL)';recoverableArgs.push(branchId);}
    const {rows:recoverables}=await db.execute({sql:`SELECT c.supplier_id,
      COALESCE(SUM(MAX(0,c.confirmed_amount-c.recovered_amount-COALESCE(r.reserved,0))),0) amount
      FROM supplier_recoverable_claims c
      JOIN supplier_recoverable_accounting_basis b ON b.claim_id=c.id
      LEFT JOIN (
        SELECT claim_id,SUM(MAX(0,amount-settled_amount)) reserved
        FROM supplier_credit_note_applications GROUP BY claim_id
      ) r ON r.claim_id=c.id
      WHERE c.status IN ('confirmed','partially_recovered')${recoverableBranch}
      GROUP BY c.supplier_id`,args:recoverableArgs});
    const creditArgs=[];let creditBranch='';
    if(branchId){creditBranch=' AND (n.branch_id=? OR n.branch_id IS NULL)';creditArgs.push(branchId);}
    const {rows:credits}=await db.execute({sql:`SELECT n.supplier_id,
      COALESCE(SUM(MAX(0,n.amount-n.applied_amount)),0) amount
      FROM supplier_credit_notes n
      WHERE MAX(0,n.amount-n.applied_amount)>0.001${creditBranch}
      GROUP BY n.supplier_id`,args:creditArgs});
    const recoverableMap=new Map(recoverables.map(x=>[Number(x.supplier_id),money(x.amount)]));
    const creditMap=new Map(credits.map(x=>[Number(x.supplier_id),money(x.amount)]));
    const bySupplier=new Map();
    for(const inv of invoices){
      const id=Number(inv.supplier_id);
      if(!bySupplier.has(id))bySupplier.set(id,{supplier_id:id,supplier_name:inv.supplier_name,invoices:[]});
      bySupplier.get(id).invoices.push(inv);
    }
    const today=Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z');
    const daysUntil=date=>{if(!date)return null;const t=Date.parse(String(date)+'T00:00:00Z');return Number.isFinite(t)?Math.ceil((t-today)/86400000):null;};
    const suppliers=[];
    for(const s of bySupplier.values()){
      const offsetReady=money(recoverableMap.get(s.supplier_id)||0);
      const unmatchedCredit=money(creditMap.get(s.supplier_id)||0);
      let offsetLeft=offsetReady;
      let openAp=0,due7=0,due14=0,due30=0,dueHorizon=0,overdue=0,notYetDue=0,actionableDiscount=0,lateFeeExposure=0;
      const planned=[];
      for(const inv of s.invoices){
        const balance=money(inv.balance_due);openAp=money(openAp+balance);
        const offset=money(Math.min(balance,offsetLeft));
        offsetLeft=money(offsetLeft-offset);
        const cashRemaining=money(balance-offset);
        const dueIn=daysUntil(inv.due_date);
        const discountIn=daysUntil(inv.discount_deadline);
        const lateFeeIn=daysUntil(inv.late_fee_effective_date);
        const discount=money(inv.discount_amount||0),paid=money(inv.paid_amount||0),lateFee=money(inv.late_fee_amount||0);
        const discountActionable=discount>0&&discountIn!==null&&discountIn>=0&&paid<=0.009;
        if(discountActionable)actionableDiscount=money(actionableDiscount+Math.min(discount,cashRemaining));
        if(cashRemaining>0.009&&lateFee>0&&lateFeeIn!==null&&lateFeeIn<=horizon)lateFeeExposure=money(lateFeeExposure+lateFee);
        if(dueIn!==null){
          if(dueIn<0)overdue=money(overdue+cashRemaining);
          else{
            notYetDue=money(notYetDue+cashRemaining);
            if(dueIn<=7)due7=money(due7+cashRemaining);
            if(dueIn<=14)due14=money(due14+cashRemaining);
            if(dueIn<=30)due30=money(due30+cashRemaining);
            if(dueIn<=horizon)dueHorizon=money(dueHorizon+cashRemaining);
          }
        }
        planned.push({
          invoice_id:inv.id,invoice_number:inv.invoice_number,due_date:inv.due_date,days_until_due:dueIn,
          balance_due:balance,planned_recoverable_offset:offset,planned_cash:cashRemaining,
          discount_deadline:inv.discount_deadline||null,discount_amount:discount,discount_actionable:discountActionable,
          late_fee_effective_date:inv.late_fee_effective_date||null,late_fee_amount:lateFee
        });
      }
      suppliers.push({
        supplier_id:s.supplier_id,supplier_name:s.supplier_name,open_ap:money(openAp),
        offset_ready_recoverables:offsetReady,planned_recoverable_offsets:money(offsetReady-offsetLeft),
        unmatched_formal_credit_notes:unmatchedCredit,
        minimum_cash_total:money(Math.max(0,openAp-(offsetReady-offsetLeft))),
        cash_due_7_days:due7,cash_due_14_days:due14,cash_due_30_days:due30,cash_due_horizon:dueHorizon,
        overdue_cash:overdue,not_yet_due_cash:notYetDue,actionable_discount_total:actionableDiscount,
        stated_late_fee_exposure_within_horizon:lateFeeExposure,
        invoices:planned
      });
    }
    suppliers.sort((a,b)=>b.cash_due_horizon-a.cash_due_horizon||b.overdue_cash-a.overdue_cash||a.supplier_name.localeCompare(b.supplier_name));
    const sum=k=>money(suppliers.reduce((n,x)=>n+Number(x[k]||0),0));
    res.json({
      as_of:new Date().toISOString(),branch_id:branchId||null,horizon_days:horizon,
      summary:{
        open_ap:sum('open_ap'),
        offset_ready_recoverables:sum('planned_recoverable_offsets'),
        unmatched_formal_credit_notes:sum('unmatched_formal_credit_notes'),
        minimum_cash_total:sum('minimum_cash_total'),
        cash_due_7_days:sum('cash_due_7_days'),
        cash_due_14_days:sum('cash_due_14_days'),
        cash_due_30_days:sum('cash_due_30_days'),
        cash_due_horizon:sum('cash_due_horizon'),
        overdue_cash:sum('overdue_cash'),
        actionable_discount_total:sum('actionable_discount_total'),
        stated_late_fee_exposure_within_horizon:sum('stated_late_fee_exposure_within_horizon')
      },
      suppliers,
      basis:'Read-only cash forecast. Eligible recoverables are applied to earliest supplier obligations for planning only. Unmatched credit notes, undocumented discounts, and unconfirmed claims do not reduce forecast cash.'
    });
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/payment-timing', requirePermission('reports_financial'), async (req,res)=>{
  try{
    const supplierId=req.query.supplier_id?Number(req.query.supplier_id):null;
    const branchId=req.query.branch_id?Number(req.query.branch_id):null;
    const args=[];let where="si.status!='void'";
    if(supplierId){where+=' AND si.supplier_id=?';args.push(supplierId);}
    if(branchId){where+=' AND si.branch_id=?';args.push(branchId);}
    const {rows}=await db.execute({sql:`SELECT si.*,s.name supplier_name,
      COALESCE(a.paid,0) paid_amount,MAX(0,si.total-COALESCE(a.paid,0)) balance_due
      FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id
      LEFT JOIN (
        SELECT supplier_invoice_id,SUM(amount) paid FROM (
          SELECT supplier_invoice_id,amount FROM supplier_payment_allocations
          UNION ALL SELECT supplier_invoice_id,amount FROM supplier_recoverable_ap_allocations
        ) x GROUP BY supplier_invoice_id
      ) a ON a.supplier_invoice_id=si.id
      WHERE ${where} AND MAX(0,si.total-COALESCE(a.paid,0))>0.001
      ORDER BY COALESCE(si.due_date,si.invoice_date),si.id`,args});
    const now=new Date();const today=now.toISOString().slice(0,10);
    const days=(date)=>{if(!date)return null;const t=Date.parse(String(date)+'T00:00:00Z');const b=Date.parse(today+'T00:00:00Z');return Number.isFinite(t)?Math.ceil((t-b)/86400000):null;};
    let actionableDiscount=0,lateFeeExposure=0,notYetDue=0,overdue=0;
    const invoices=rows.map(x=>{
      const balance=money(x.balance_due),paid=money(x.paid_amount),discount=money(x.discount_amount||0),lateFee=money(x.late_fee_amount||0);
      const dueIn=days(x.due_date),discountIn=days(x.discount_deadline),lateFeeIn=days(x.late_fee_effective_date);
      const discountActionable=discount>0&&x.discount_deadline&&discountIn!==null&&discountIn>=0&&paid<=0.009;
      const partialDiscountNeedsVerification=discount>0&&x.discount_deadline&&discountIn!==null&&discountIn>=0&&paid>0.009;
      if(discountActionable)actionableDiscount=money(actionableDiscount+Math.min(discount,balance));
      if(lateFee>0&&x.late_fee_effective_date)lateFeeExposure=money(lateFeeExposure+Math.min(lateFee,balance+lateFee));
      if(dueIn!==null&&dueIn>0)notYetDue=money(notYetDue+balance);
      if(dueIn!==null&&dueIn<0)overdue=money(overdue+balance);
      return {
        invoice_id:x.id,invoice_number:x.invoice_number,supplier_id:x.supplier_id,supplier_name:x.supplier_name,branch_id:x.branch_id,
        balance_due:balance,paid_amount:paid,due_date:x.due_date,days_until_due:dueIn,payment_terms_reference:x.payment_terms_reference||null,
        discount_deadline:x.discount_deadline||null,discount_amount:discount,days_until_discount_deadline:discountIn,
        discount_actionable:discountActionable,partial_discount_needs_verification:partialDiscountNeedsVerification,
        late_fee_effective_date:x.late_fee_effective_date||null,late_fee_amount:lateFee,days_until_late_fee:lateFeeIn,
        timing_status:discountActionable?'capture_discount':(dueIn!==null&&dueIn<0?'overdue':(lateFee>0&&lateFeeIn!==null&&lateFeeIn<=3?'late_fee_risk':(dueIn!==null&&dueIn>0?'not_yet_due':'due')))
      };
    });
    res.json({
      summary:{
        actionable_discount_total:money(actionableDiscount),
        stated_late_fee_exposure:money(lateFeeExposure),
        not_yet_due_ap:money(notYetDue),
        overdue_ap:money(overdue),
        invoices_with_partial_discount_terms:invoices.filter(x=>x.partial_discount_needs_verification).length
      },
      invoices,
      basis:'Timing guidance uses only explicit supplier invoice terms. Discounts on partially paid invoices require verification; late-fee amounts are exposure only and are not posted as liabilities.'
    });
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/invoices', requireAnyPermission('purchasing_approve','reports_financial'), async (req,res)=>{
  try{
    const b=req.body||{};
    const supplierId=Number(b.supplier_id),poId=b.purchase_order_id?Number(b.purchase_order_id):null;
    const subtotal=money(b.subtotal||0),tax=money(b.tax_amount||0),freight=money(b.freight_amount||0),duty=money(b.duty_amount||0),otherLanded=money(b.other_landed_cost_amount||0);
    const discountAmount=money(b.discount_amount||0),lateFeeAmount=money(b.late_fee_amount||0);
    const components=[subtotal,tax,freight,duty,otherLanded];
    if(components.some(v=>!Number.isFinite(v)||v<0)||!Number.isFinite(discountAmount)||discountAmount<0||!Number.isFinite(lateFeeAmount)||lateFeeAmount<0)return res.status(400).json({error:'Supplier invoice monetary components and payment-term amounts must be non-negative numbers'});
    const termsReference=String(b.payment_terms_reference||'').trim();
    if(discountAmount>0&&!b.discount_deadline)return res.status(400).json({error:'A documented discount deadline is required when an early-payment discount amount is recorded'});
    if(lateFeeAmount>0&&!b.late_fee_effective_date)return res.status(400).json({error:'A documented late-fee effective date is required when a late-fee amount is recorded'});
    if((discountAmount>0||lateFeeAmount>0)&&!termsReference)return res.status(400).json({error:'Supplier payment-term reference is required for documented discount or late-fee amounts'});
    if(b.discount_deadline&&Date.parse(String(b.discount_deadline)+'T00:00:00Z')<Date.parse(String(b.invoice_date)+'T00:00:00Z'))return res.status(400).json({error:'Discount deadline cannot be before supplier invoice date'});
    if(b.late_fee_effective_date&&Date.parse(String(b.late_fee_effective_date)+'T00:00:00Z')<Date.parse(String(b.invoice_date)+'T00:00:00Z'))return res.status(400).json({error:'Late-fee effective date cannot be before supplier invoice date'});
    const calculated=Number(components.reduce((s,v)=>s+v,0).toFixed(2));
    const total=b.total===undefined?calculated:money(b.total);
    if(!supplierId||!String(b.invoice_number||'').trim()||!b.invoice_date||!Number.isFinite(total)||total<=0)return res.status(400).json({error:'supplier_id, invoice_number, invoice_date and a positive total are required'});
    if(Math.abs(total-calculated)>0.01)return res.status(400).json({error:`Invoice components total ${calculated.toFixed(2)} does not match invoice total ${total.toFixed(2)}`});
    if(discountAmount-total>0.01)return res.status(400).json({error:'Documented early-payment discount cannot exceed supplier invoice total'});
    let taxTreatment=null;
    if(tax>0){
      taxTreatment=String(b.tax_treatment||'').trim().toLowerCase();
      if(!['recoverable','landed_cost','expense'].includes(taxTreatment))return res.status(400).json({error:'tax_treatment is required when supplier tax is present: recoverable, landed_cost, or expense'});
    }
    let po=null;
    if(poId){
      const result=await db.execute({sql:'SELECT * FROM purchase_orders WHERE id=?',args:[poId]});po=result.rows[0];
      if(!po)return res.status(404).json({error:'Purchase order not found'});
      if(Number(po.supplier_id||0)&&Number(po.supplier_id)!==supplierId)return res.status(409).json({error:'Supplier invoice supplier does not match purchase order supplier'});
      if(b.branch_id&&po.branch_id&&Number(b.branch_id)!==Number(po.branch_id))return res.status(409).json({error:'Supplier invoice branch does not match purchase order receiving branch'});
    }
    const branchId=b.branch_id||po?.branch_id||null;
    const tx=await db.transaction('write'); try{
      const r=await tx.execute({sql:`INSERT INTO supplier_invoices(supplier_id,purchase_order_id,branch_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,freight_amount,duty_amount,other_landed_cost_amount,tax_treatment,total,payment_terms_reference,discount_deadline,discount_amount,late_fee_effective_date,late_fee_amount,notes,posted_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[supplierId,poId,branchId,String(b.invoice_number).trim(),b.invoice_date,b.due_date||null,subtotal,tax,freight,duty,otherLanded,taxTreatment,total,termsReference||null,b.discount_deadline||null,discountAmount,b.late_fee_effective_date||null,lateFeeAmount,b.notes||null,actor(req)]});
      const id=Number(r.lastInsertRowid);
      await tx.execute({sql:`INSERT INTO supplier_ledger_events(supplier_id,event_type,entity_type,entity_id,amount,details,actor_employee_id) VALUES(?,?,?,?,?,?,?)`,args:[supplierId,'invoice_posted','supplier_invoice',id,total,`Supplier invoice ${String(b.invoice_number).trim()} posted; merchandise ${subtotal.toFixed(2)}, tax ${tax.toFixed(2)}, landed costs ${(freight+duty+otherLanded).toFixed(2)}`,actor(req)]});
      if(poId) await recordInvoiceReconciliation(tx,{supplierInvoiceId:id,purchaseOrderId:poId,invoiceSubtotal:subtotal});
      await tx.commit(); const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_invoices WHERE id=?',args:[id]}); res.status(201).json(row);
    }catch(e){await tx.rollback();throw e;}
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/payments', requirePermission('reports_financial'), async (req,res)=>{
  try{
    const b=req.body||{},supplierId=Number(b.supplier_id),amount=Number(b.amount);
    if(!supplierId||!Number.isFinite(amount)||amount<=0||!b.payment_date)return res.status(400).json({error:'supplier_id, payment_date and positive amount are required'});
    let allocations=Array.isArray(b.allocations)?b.allocations.filter(x=>Number(x.amount)>0).map(x=>({invoice_id:Number(x.invoice_id),amount:Number(x.amount)})):[];
    if(!allocations.length){
      const {rows:open}=await db.execute({sql:`SELECT si.id,MAX(0,si.total-COALESCE(a.paid,0)) balance_due FROM supplier_invoices si
        LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM (SELECT supplier_invoice_id,amount FROM supplier_payment_allocations UNION ALL SELECT supplier_invoice_id,amount FROM supplier_recoverable_ap_allocations) applied GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
        WHERE si.supplier_id=? AND si.status!='void' AND MAX(0,si.total-COALESCE(a.paid,0))>0.001 ORDER BY COALESCE(si.due_date,si.invoice_date),si.id`,args:[supplierId]});
      let left=amount; for(const inv of open){if(left<=0.001)break;const applied=Math.min(left,Number(inv.balance_due));allocations.push({invoice_id:inv.id,amount:Number(applied.toFixed(2))});left=Number((left-applied).toFixed(2));}
    }
    const allocated=Number(allocations.reduce((s,x)=>s+Number(x.amount||0),0).toFixed(2)); if(allocated-amount>0.001)return res.status(400).json({error:'Allocations cannot exceed payment amount'});
    const tx=await db.transaction('write'); try{
      const number=paymentNumber(); const r=await tx.execute({sql:`INSERT INTO supplier_payments(payment_number,supplier_id,branch_id,payment_date,amount,payment_method,reference,notes,recorded_by) VALUES(?,?,?,?,?,?,?,?,?)`,args:[number,supplierId,b.branch_id||null,b.payment_date,amount,b.payment_method||null,b.reference||null,b.notes||null,actor(req)]});
      const paymentId=Number(r.lastInsertRowid);
      for(const a of allocations){const {rows:[inv]}=await tx.execute({sql:'SELECT supplier_id,total FROM supplier_invoices WHERE id=? AND status!=\'void\'',args:[a.invoice_id]});if(!inv||Number(inv.supplier_id)!==supplierId)throw new Error('Payment allocation references an invalid supplier invoice');const {rows:[paid]}=await tx.execute({sql:`SELECT COALESCE(SUM(amount),0) amount FROM (SELECT amount FROM supplier_payment_allocations WHERE supplier_invoice_id=? UNION ALL SELECT amount FROM supplier_recoverable_ap_allocations WHERE supplier_invoice_id=?)`,args:[a.invoice_id,a.invoice_id]});const balance=Number(inv.total)-Number(paid.amount||0);if(Number(a.amount)-balance>0.001)throw new Error('Payment allocation exceeds invoice balance');await tx.execute({sql:'INSERT INTO supplier_payment_allocations(payment_id,supplier_invoice_id,amount) VALUES(?,?,?)',args:[paymentId,a.invoice_id,a.amount]});}
      await tx.execute({sql:`INSERT INTO supplier_ledger_events(supplier_id,event_type,entity_type,entity_id,amount,details,actor_employee_id) VALUES(?,?,?,?,?,?,?)`,args:[supplierId,'payment_recorded','supplier_payment',paymentId,amount,`Supplier payment ${number} recorded`,actor(req)]});
      await tx.commit(); const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_payments WHERE id=?',args:[paymentId]}); res.status(201).json({...row,allocated_amount:allocated,unallocated_amount:Number((amount-allocated).toFixed(2))});
    }catch(e){await tx.rollback();throw e;}
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/supplier/:id', requirePermission('reports_financial'), async (req,res)=>{
  try{
    const {rows:[supplier]}=await db.execute({sql:'SELECT * FROM suppliers WHERE id=?',args:[req.params.id]}); if(!supplier)return res.status(404).json({error:'Supplier not found'});
    const {rows:events}=await db.execute({sql:`SELECT sle.*,e.first_name||' '||e.last_name actor_name FROM supplier_ledger_events sle LEFT JOIN employees e ON e.id=sle.actor_employee_id WHERE sle.supplier_id=? ORDER BY sle.created_at DESC,sle.id DESC LIMIT 200`,args:[req.params.id]});
    res.json({supplier,events});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
