const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, requireAnyPermission } = require('../lib/permissions');

let schemaPromise = null;
async function ensureColumn(table,name,definition){
  const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});
  if(!rows.some(r=>String(r.name)===name))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,args:[]});
}
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async()=>{
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
      LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM supplier_payment_allocations GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
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
        FROM supplier_invoices si LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM supplier_payment_allocations GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
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
      LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM supplier_payment_allocations GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
      WHERE si.status!='void'`;
    if(supplier_id){sql+=' AND si.supplier_id=?';args.push(supplier_id);} if(branch_id){sql+=' AND si.branch_id=?';args.push(branch_id);}
    if(status==='open')sql+=' AND MAX(0,si.total-COALESCE(a.paid,0))>0.001'; else if(status==='paid')sql+=' AND MAX(0,si.total-COALESCE(a.paid,0))<=0.001';
    sql+=' ORDER BY COALESCE(si.due_date,si.invoice_date),si.id DESC LIMIT ?';args.push(Math.min(Math.max(parseInt(limit)||200,1),500));
    const {rows}=await db.execute({sql,args}); res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/invoices', requireAnyPermission('purchasing_approve','reports_financial'), async (req,res)=>{
  try{
    const b=req.body||{};
    const supplierId=Number(b.supplier_id),poId=b.purchase_order_id?Number(b.purchase_order_id):null;
    const subtotal=money(b.subtotal||0),tax=money(b.tax_amount||0),freight=money(b.freight_amount||0),duty=money(b.duty_amount||0),otherLanded=money(b.other_landed_cost_amount||0);
    const components=[subtotal,tax,freight,duty,otherLanded];
    if(components.some(v=>!Number.isFinite(v)||v<0))return res.status(400).json({error:'Supplier invoice monetary components must be non-negative numbers'});
    const calculated=Number(components.reduce((s,v)=>s+v,0).toFixed(2));
    const total=b.total===undefined?calculated:money(b.total);
    if(!supplierId||!String(b.invoice_number||'').trim()||!b.invoice_date||!Number.isFinite(total)||total<=0)return res.status(400).json({error:'supplier_id, invoice_number, invoice_date and a positive total are required'});
    if(Math.abs(total-calculated)>0.01)return res.status(400).json({error:`Invoice components total ${calculated.toFixed(2)} does not match invoice total ${total.toFixed(2)}`});
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
      const r=await tx.execute({sql:`INSERT INTO supplier_invoices(supplier_id,purchase_order_id,branch_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,freight_amount,duty_amount,other_landed_cost_amount,tax_treatment,total,notes,posted_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[supplierId,poId,branchId,String(b.invoice_number).trim(),b.invoice_date,b.due_date||null,subtotal,tax,freight,duty,otherLanded,taxTreatment,total,b.notes||null,actor(req)]});
      const id=Number(r.lastInsertRowid);
      await tx.execute({sql:`INSERT INTO supplier_ledger_events(supplier_id,event_type,entity_type,entity_id,amount,details,actor_employee_id) VALUES(?,?,?,?,?,?,?)`,args:[supplierId,'invoice_posted','supplier_invoice',id,total,`Supplier invoice ${String(b.invoice_number).trim()} posted; merchandise ${subtotal.toFixed(2)}, tax ${tax.toFixed(2)}, landed costs ${(freight+duty+otherLanded).toFixed(2)}`,actor(req)]});
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
        LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM supplier_payment_allocations GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id
        WHERE si.supplier_id=? AND si.status!='void' AND MAX(0,si.total-COALESCE(a.paid,0))>0.001 ORDER BY COALESCE(si.due_date,si.invoice_date),si.id`,args:[supplierId]});
      let left=amount; for(const inv of open){if(left<=0.001)break;const applied=Math.min(left,Number(inv.balance_due));allocations.push({invoice_id:inv.id,amount:Number(applied.toFixed(2))});left=Number((left-applied).toFixed(2));}
    }
    const allocated=Number(allocations.reduce((s,x)=>s+Number(x.amount||0),0).toFixed(2)); if(allocated-amount>0.001)return res.status(400).json({error:'Allocations cannot exceed payment amount'});
    const tx=await db.transaction('write'); try{
      const number=paymentNumber(); const r=await tx.execute({sql:`INSERT INTO supplier_payments(payment_number,supplier_id,branch_id,payment_date,amount,payment_method,reference,notes,recorded_by) VALUES(?,?,?,?,?,?,?,?,?)`,args:[number,supplierId,b.branch_id||null,b.payment_date,amount,b.payment_method||null,b.reference||null,b.notes||null,actor(req)]});
      const paymentId=Number(r.lastInsertRowid);
      for(const a of allocations){const {rows:[inv]}=await tx.execute({sql:'SELECT supplier_id,total FROM supplier_invoices WHERE id=? AND status!=\'void\'',args:[a.invoice_id]});if(!inv||Number(inv.supplier_id)!==supplierId)throw new Error('Payment allocation references an invalid supplier invoice');const {rows:[paid]}=await tx.execute({sql:'SELECT COALESCE(SUM(amount),0) amount FROM supplier_payment_allocations WHERE supplier_invoice_id=?',args:[a.invoice_id]});const balance=Number(inv.total)-Number(paid.amount||0);if(Number(a.amount)-balance>0.001)throw new Error('Payment allocation exceeds invoice balance');await tx.execute({sql:'INSERT INTO supplier_payment_allocations(payment_id,supplier_invoice_id,amount) VALUES(?,?,?)',args:[paymentId,a.invoice_id,a.amount]});}
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
