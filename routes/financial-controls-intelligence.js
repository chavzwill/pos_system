const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

router.use(requirePermission('reports'));

async function tableExists(name) {
  const { rows:[row] } = await db.execute({ sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", args:[name] });
  return !!row;
}
function range(req){
  const end=String(req.query.end||new Date().toISOString().slice(0,10));
  const start=String(req.query.start||new Date(Date.now()-29*86400000).toISOString().slice(0,10));
  const branchId=req.query.branch_id?Number(req.query.branch_id):null;
  return {start,end,branchId};
}

router.get('/command-center', async (req,res)=>{
  try{
    const p=range(req);
    const salesArgs=[p.start,p.end];
    let salesWhere="t.status='completed' AND date(t.created_at) BETWEEN date(?) AND date(?)";
    if(p.branchId){salesWhere+=' AND t.branch_id=?';salesArgs.push(p.branchId);}
    const {rows:[collections]}=await db.execute({sql:`SELECT
      COALESCE(SUM(CASE WHEN t.payment_method!='credit' THEN t.total ELSE 0 END),0) recorded_noncredit_sales,
      COALESCE(SUM(CASE WHEN t.payment_method='credit' THEN t.total ELSE 0 END),0) credit_originated_sales,
      COUNT(*) completed_transactions
      FROM transactions t WHERE ${salesWhere}`,args:salesArgs});

    const apArgs=[];
    let poWhere="po.status NOT IN ('cancelled','received')";
    if(p.branchId){poWhere+=' AND po.branch_id=?';apArgs.push(p.branchId);}
    const {rows:[commitments]}=await db.execute({sql:`SELECT
      COALESCE(SUM(CASE WHEN poi.quantity_ordered>0 THEN MAX(0,poi.quantity_ordered-COALESCE(poi.quantity_received,0))*poi.unit_cost ELSE 0 END),0) open_purchase_commitment,
      COUNT(DISTINCT po.id) open_purchase_orders,
      COALESCE(SUM(CASE WHEN po.expected_date IS NOT NULL AND date(po.expected_date)<date('now') THEN 1 ELSE 0 END),0) overdue_purchase_orders
      FROM purchase_orders po LEFT JOIN purchase_order_items poi ON poi.po_id=po.id WHERE ${poWhere}`,args:apArgs});

    const invArgs=[];
    let invWhere='p.active=1';
    if(p.branchId){invWhere+=' AND bi.branch_id=?';invArgs.push(p.branchId);}
    const {rows:[inventory]}=await db.execute({sql:`SELECT
      COALESCE(SUM(MAX(0,COALESCE(bi.stock_qty,0))*COALESCE(p.cost,0)),0) inventory_cost_value,
      COALESCE(SUM(CASE WHEN COALESCE(bi.stock_qty,0)>COALESCE(bi.min_stock,p.min_stock,0)*3 AND COALESCE(bi.stock_qty,0)>0 THEN COALESCE(bi.stock_qty,0)*COALESCE(p.cost,0) ELSE 0 END),0) excess_stock_cost_signal,
      COUNT(DISTINCT CASE WHEN COALESCE(bi.stock_qty,0)<0 THEN p.id END) negative_stock_items
      FROM products p LEFT JOIN branch_inventory bi ON bi.product_id=p.id WHERE ${invWhere}`,args:invArgs});

    const {rows:[receivables]}=await db.execute({sql:`SELECT
      COALESCE(SUM(CASE WHEN c.credit_enabled=1 THEN c.account_balance ELSE 0 END),0) total_receivables,
      COALESCE(SUM(CASE WHEN c.credit_enabled=1 AND c.credit_limit>0 AND c.account_balance>c.credit_limit THEN c.account_balance-c.credit_limit ELSE 0 END),0) over_limit_exposure
      FROM customers c WHERE c.active=1`,args:[]});

    let technicianPayroll={finalized_payroll:0,finalized_snapshots:0,basis:'No finalized technician payroll snapshots are available yet.'};
    if(await tableExists('technician_pay_snapshots')){
      const payArgs=[p.start,p.end];
      const {rows:[pay]}=await db.execute({sql:`SELECT COALESCE(SUM(payable_total),0) finalized_payroll,COUNT(*) finalized_snapshots
        FROM technician_pay_snapshots WHERE date(period_end)>=date(?) AND date(period_start)<=date(?)`,args:payArgs});
      technicianPayroll={...pay,basis:'Only finalized technician compensation snapshots are included. This is not a company-wide payroll ledger.'};
    }

    let logistics={estimated_dispatch_hours:0,completed_jobs:0,basis:'Dispatch cost rate is not configured, so logistics is expressed in operational hours rather than currency.'};
    if(await tableExists('dispatch_jobs')){
      const logArgs=[p.start,p.end];
      let logWhere="date(created_at) BETWEEN date(?) AND date(?)";
      if(p.branchId){logWhere+=' AND branch_id=?';logArgs.push(p.branchId);}
      const {rows:[row]}=await db.execute({sql:`SELECT COALESCE(SUM(estimated_minutes),0)/60.0 estimated_dispatch_hours,
        COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) completed_jobs FROM dispatch_jobs WHERE ${logWhere}`,args:logArgs});
      logistics={...row,basis:'Dispatch hours use operational estimates; no monetary logistics cost is inferred without an approved cost basis.'};
    }

    const recordedCollections=Number(collections.recorded_noncredit_sales||0);
    const knownCommitments=Number(commitments.open_purchase_commitment||0)+Number(technicianPayroll.finalized_payroll||0);
    const pressureRatio=recordedCollections>0?knownCommitments/recordedCollections:null;
    res.json({
      period:p,
      recorded_collections:{...collections,basis:'Completed non-credit transaction totals are treated as recorded operating inflow proxies; bank settlement timing is not represented.'},
      purchasing_commitments:{...commitments,basis:'Open commitment uses unreceived purchase-order quantity at recorded unit cost. It is not Accounts Payable unless a supplier invoice is formally posted.'},
      inventory_capital:{...inventory,basis:'Inventory cost value uses current product cost multiplied by branch stock. It is operational valuation, not an audited inventory ledger.'},
      receivables,
      technician_payroll:technicianPayroll,
      logistics,
      pressure:{known_commitments:knownCommitments,recorded_inflow_proxy:recordedCollections,commitment_to_inflow_ratio:pressureRatio,basis:'A management pressure indicator only. It is not a cash-flow forecast because bank balances, supplier payment terms, taxes, payroll outside finalized technician snapshots and other liabilities are not yet fully modeled.'}
    });
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/supplier-exposure', async (req,res)=>{
  try{
    const p=range(req),args=[];
    let where="po.status NOT IN ('cancelled','received')";
    if(p.branchId){where+=' AND po.branch_id=?';args.push(p.branchId);}
    const {rows}=await db.execute({sql:`SELECT s.id supplier_id,COALESCE(s.name,'Unassigned supplier') supplier_name,
      COUNT(DISTINCT po.id) open_pos,
      COALESCE(SUM(MAX(0,poi.quantity_ordered-COALESCE(poi.quantity_received,0))*poi.unit_cost),0) open_commitment,
      MIN(po.expected_date) nearest_expected_date,
      COALESCE(SUM(CASE WHEN po.expected_date IS NOT NULL AND date(po.expected_date)<date('now') THEN 1 ELSE 0 END),0) overdue_pos
      FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN purchase_order_items poi ON poi.po_id=po.id
      WHERE ${where} GROUP BY s.id,s.name ORDER BY open_commitment DESC LIMIT 50`,args});
    res.json({basis:'Supplier exposure is open purchase commitment, not posted Accounts Payable. Supplier invoices and payment terms must be captured before this can become ledger-grade AP aging.',rows});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/collections', async (req,res)=>{
  try{
    const p=range(req),args=[p.start,p.end];
    let where="date(ap.created_at) BETWEEN date(?) AND date(?)";
    if(p.branchId){where+=' AND ap.branch_id=?';args.push(p.branchId);}
    const {rows}=await db.execute({sql:`SELECT date(ap.created_at) day,COALESCE(SUM(ap.amount),0) account_collections,COUNT(*) payment_count
      FROM account_payments ap WHERE ${where} GROUP BY date(ap.created_at) ORDER BY day`,args});
    res.json({basis:'These are recorded customer account payments. They do not represent bank-cleared cash unless settlement reconciliation confirms it.',rows});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
