const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,can}=require('../lib/permissions');
router.use(requireAuth);
const num=v=>Number(v||0);
function branchClause(alias,branchId,args){if(!branchId)return'';args.push(branchId);return` AND ${alias}.branch_id=?`;}
function allowed(req,keys){return keys.some(k=>can(req.employee?.permissions||{},k));}
router.get('/summary',async(req,res)=>{
  try{
    const workspace=String(req.query.workspace||'').toLowerCase();
    const branchId=req.query.branch_id?Number(req.query.branch_id):(req.employee?.default_branch_id||null);
    if(workspace==='sales'){
      if(!allowed(req,['pos','transactions','drawers']))return res.status(403).json({error:'Sales workspace not permitted'});
      const args=[];const bc=branchClause('t',branchId,args);
      const {rows:[sales]}=await db.execute({sql:`SELECT COUNT(*) transactions,COALESCE(SUM(total),0) revenue,COALESCE(SUM(discount_amount),0) discounts,COALESCE(AVG(total),0) avg_ticket FROM transactions t WHERE status='completed' AND date(created_at)=date('now')${bc}`,args});
      const {rows:[holds]}=await db.execute({sql:`SELECT COUNT(*) held_sales FROM held_sales WHERE 1=1`,args:[]}).catch(()=>({rows:[{held_sales:0}]}));
      res.json({workspace,summary:{transactions:num(sales.transactions),revenue:num(sales.revenue),discounts:num(sales.discounts),avg_ticket:num(sales.avg_ticket),held_sales:num(holds.held_sales)},basis:'Today\'s completed POS transactions; held-sales count is included when the legacy hold table is available.'});return;
    }
    if(workspace==='rentals'){
      if(!allowed(req,['rentals']))return res.status(403).json({error:'Rental workspace not permitted'});
      const args=[];const bc=branchClause('ra',branchId,args);
      const {rows:[r]}=await db.execute({sql:`SELECT COUNT(*) active,COALESCE(SUM(CASE WHEN ra.status='active' AND date(ra.due_date)<date('now') THEN 1 ELSE 0 END),0) overdue,COALESCE(SUM(CASE WHEN ra.status='awaiting_issue' THEN 1 ELSE 0 END),0) awaiting_issue,COALESCE(SUM(CASE WHEN ra.status='returned' AND ra.settlement_transaction_id IS NULL AND (ra.damage_fee_total+ra.duration_adjustment_total-ra.deposit_total+ra.tax_adjustment_total)>0 THEN 1 ELSE 0 END),0) awaiting_payment FROM rental_agreements ra WHERE ra.status IN ('active','awaiting_issue','returned')${bc}`,args});
      const qargs=[];const qbc=branchClause('ra',branchId,qargs);const {rows:queue}=await db.execute({sql:`SELECT ra.id,ra.agreement_number,ra.status,ra.due_date,c.first_name||' '||c.last_name customer_name,CASE WHEN ra.status='active' AND date(ra.due_date)<date('now') THEN 'overdue' ELSE ra.status END display_status FROM rental_agreements ra LEFT JOIN customers c ON c.id=ra.customer_id WHERE ra.status IN ('active','awaiting_issue')${qbc} ORDER BY CASE WHEN ra.status='active' AND date(ra.due_date)<date('now') THEN 0 ELSE 1 END,ra.due_date LIMIT 8`,args:qargs});
      res.json({workspace,summary:r,queue});return;
    }
    if(workspace==='inventory'){
      if(!allowed(req,['inventory','warehouse','transfers']))return res.status(403).json({error:'Inventory workspace not permitted'});
      const args=[];const bc=branchClause('bi',branchId,args);
      const {rows:[s]}=await db.execute({sql:`SELECT COUNT(*) branch_items,COALESCE(SUM(CASE WHEN COALESCE(bi.stock_qty,0)<=0 THEN 1 ELSE 0 END),0) stockouts,COALESCE(SUM(CASE WHEN COALESCE(bi.stock_qty,0)>0 AND COALESCE(bi.stock_qty,0)<=COALESCE(bi.min_stock,p.min_stock,0) THEN 1 ELSE 0 END),0) low_stock,COALESCE(SUM(CASE WHEN COALESCE(bi.stock_qty,0)<0 THEN 1 ELSE 0 END),0) negative_stock,COALESCE(SUM(COALESCE(bi.stock_qty,0)*COALESCE(p.cost,0)),0) inventory_value FROM branch_inventory bi JOIN products p ON p.id=bi.product_id WHERE p.active=1${bc}`,args});
      const qargs=[];const qbc=branchClause('bi',branchId,qargs);const {rows:queue}=await db.execute({sql:`SELECT p.name,p.sku,bi.stock_qty,COALESCE(bi.min_stock,p.min_stock,0) min_stock,b.name branch_name FROM branch_inventory bi JOIN products p ON p.id=bi.product_id LEFT JOIN branches b ON b.id=bi.branch_id WHERE p.active=1 AND COALESCE(bi.stock_qty,0)<=COALESCE(bi.min_stock,p.min_stock,0)${qbc} ORDER BY bi.stock_qty ASC LIMIT 8`,args:qargs});
      res.json({workspace,summary:s,queue});return;
    }
    if(workspace==='purchasing'){
      if(!allowed(req,['purchase_requests','purchasing','suppliers']))return res.status(403).json({error:'Purchasing workspace not permitted'});
      const args=[];const bc=branchClause('pr',branchId,args);const {rows:[s]}=await db.execute({sql:`SELECT COUNT(*) open_requests,COALESCE(SUM(CASE WHEN pr.status='pending' THEN 1 ELSE 0 END),0) awaiting_approval,COALESCE(SUM(CASE WHEN pr.status='approved' AND pr.converted_to_po_id IS NULL THEN 1 ELSE 0 END),0) approved_not_ordered FROM purchase_requests pr WHERE pr.status NOT IN ('rejected','cancelled','converted')${bc}`,args});
      const pargs=[];const pbc=branchClause('po',branchId,pargs);const {rows:[po]}=await db.execute({sql:`SELECT COUNT(*) open_pos,COALESCE(SUM(CASE WHEN po.expected_date IS NOT NULL AND date(po.expected_date)<date('now') AND po.status NOT IN ('received','cancelled') THEN 1 ELSE 0 END),0) overdue_pos FROM purchase_orders po WHERE po.status NOT IN ('received','cancelled')${pbc}`,args:pargs}).catch(()=>({rows:[{open_pos:0,overdue_pos:0}]}));
      const qargs=[];const qbc=branchClause('pr',branchId,qargs);const {rows:queue}=await db.execute({sql:`SELECT pr.id,pr.pr_number,pr.status,pr.required_date,s.name supplier_name,b.name branch_name FROM purchase_requests pr LEFT JOIN suppliers s ON s.id=pr.supplier_id LEFT JOIN branches b ON b.id=pr.branch_id WHERE pr.status NOT IN ('rejected','cancelled','converted')${qbc} ORDER BY COALESCE(pr.required_date,pr.created_at),pr.created_at LIMIT 8`,args:qargs});
      res.json({workspace,summary:{...s,...po},queue});return;
    }
    if(workspace==='finance'){
      if(!allowed(req,['reports','reports_financial','accounts']))return res.status(403).json({error:'Finance workspace not permitted'});
      const args=[];const bc=branchClause('t',branchId,args);const {rows:[today]}=await db.execute({sql:`SELECT COUNT(*) transactions,COALESCE(SUM(total),0) revenue,COALESCE(SUM(discount_amount),0) discounts FROM transactions t WHERE status='completed' AND date(created_at)=date('now')${bc}`,args});
      const {rows:[ar]}=await db.execute({sql:`SELECT COALESCE(SUM(CASE WHEN credit_enabled=1 THEN account_balance ELSE 0 END),0) receivables,COALESCE(SUM(CASE WHEN credit_enabled=1 AND credit_limit>0 AND account_balance>credit_limit THEN 1 ELSE 0 END),0) over_limit_customers FROM customers WHERE active=1`,args:[]});
      const apargs=[];const apbc=branchClause('si',branchId,apargs);const {rows:[ap]}=await db.execute({sql:`SELECT COALESCE(SUM(MAX(0,si.total-COALESCE(a.paid,0))),0) open_ap,COALESCE(SUM(CASE WHEN MAX(0,si.total-COALESCE(a.paid,0))>0.001 AND si.due_date IS NOT NULL AND date(si.due_date)<date('now') THEN MAX(0,si.total-COALESCE(a.paid,0)) ELSE 0 END),0) overdue_ap FROM supplier_invoices si LEFT JOIN (SELECT supplier_invoice_id,SUM(amount) paid FROM supplier_payment_allocations GROUP BY supplier_invoice_id) a ON a.supplier_invoice_id=si.id WHERE si.status!='void'${apbc}`,args:apargs}).catch(()=>({rows:[{open_ap:0,overdue_ap:0}]}));
      res.json({workspace,summary:{...today,...ar,...ap}});return;
    }
    if(workspace==='administration'){
      if(!allowed(req,['employees','branches','security','settings']))return res.status(403).json({error:'Administration workspace not permitted'});
      const {rows:[e]}=await db.execute({sql:`SELECT COUNT(*) employees FROM employees WHERE active=1`,args:[]}).catch(()=>({rows:[{employees:0}]}));
      const {rows:[b]}=await db.execute({sql:`SELECT COUNT(*) branches FROM branches WHERE active=1`,args:[]}).catch(()=>({rows:[{branches:0}]}));
      res.json({workspace,summary:{...e,...b}});return;
    }
    res.status(400).json({error:'Unsupported workspace'});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
