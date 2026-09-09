'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const {ensureBranchVariationInventory}=require('../lib/branch-variation-inventory');

router.use(async(req,res,next)=>{try{await ensureBranchVariationInventory();next();}catch(e){res.status(500).json({error:'Branch variation inventory initialization failed',detail:e.message});}});
function crossBranch(req){return !!req.apiKey||can(req.employee?.permissions,'branches')||can(req.employee?.permissions,'security_manage');}
function ownBranch(req){return req.employee?.default_branch_id==null?null:Number(req.employee.default_branch_id);}
function branchAllowed(req,branchId){const own=ownBranch(req);return crossBranch(req)||own==null||Number(branchId)===own;}
function denyBranch(res,branchId){return res.status(403).json({error:`Branch ${branchId} is outside your assigned branch authority.`,control:'branch_variation_branch_scope'});}

router.get('/migration-status',requirePermission('inventory'),async(req,res)=>{
  try{
    const productId=Number(req.query.product_id||0);if(!productId)return res.status(400).json({error:'product_id is required'});
    const {rows:[product]}=await db.execute({sql:'SELECT id,name,sku,stock_qty FROM products WHERE id=?',args:[productId]});if(!product)return res.status(404).json({error:'Product not found'});
    const {rows:variations}=await db.execute({sql:'SELECT id,name,sku,active,stock_qty FROM product_variations WHERE product_id=? ORDER BY name,id',args:[productId]});if(!variations.length)return res.status(409).json({error:'Product has no catalog variations'});
    const args=[productId,productId];let scope='';if(!crossBranch(req)&&ownBranch(req)!=null){scope=' AND b.id=?';args.push(ownBranch(req));}
    const {rows:branches}=await db.execute({sql:`SELECT b.id,b.name,COALESCE(bi.stock_qty,0) parent_branch_qty,m.status,m.baseline_total,m.counted_at,m.finalized_at,m.reason
      FROM branches b LEFT JOIN branch_inventory bi ON bi.branch_id=b.id AND bi.product_id=? LEFT JOIN branch_variation_migrations m ON m.product_id=? AND m.branch_id=b.id
      WHERE (b.active=1 OR COALESCE(bi.stock_qty,0)<>0)${scope} ORDER BY b.name,b.id`,args});
    const ledgerArgs=[productId];let ledgerScope='';if(!crossBranch(req)&&ownBranch(req)!=null){ledgerScope=' AND bvi.branch_id=?';ledgerArgs.push(ownBranch(req));}
    const {rows:ledger}=await db.execute({sql:`SELECT bvi.branch_id,bvi.variation_id,bvi.stock_qty FROM branch_variation_inventory bvi WHERE bvi.product_id=?${ledgerScope}`,args:ledgerArgs});
    const byBranch=new Map();for(const row of ledger){if(!byBranch.has(Number(row.branch_id)))byBranch.set(Number(row.branch_id),{});byBranch.get(Number(row.branch_id))[Number(row.variation_id)]=Number(row.stock_qty||0);}
    const branchRows=branches.map(b=>{const allocation=byBranch.get(Number(b.id))||{};const exactTotal=Object.values(allocation).reduce((s,n)=>s+Number(n||0),0);return {...b,parent_branch_qty:Number(b.parent_branch_qty||0),exact_variation_total:exactTotal,unallocated_parent_qty:Number((Number(b.parent_branch_qty||0)-exactTotal).toFixed(6)),allocations:variations.map(v=>({variation_id:v.id,variation_name:v.name,sku:v.sku,active:v.active,stock_qty:Number(allocation[Number(v.id)]||0)}))};});
    const counted=branchRows.filter(b=>b.status).length,required=branchRows.filter(b=>Math.abs(Number(b.parent_branch_qty||0))>1e-9||b.status).length;
    const branchVariationTotals={};for(const v of variations)branchVariationTotals[v.id]=branchRows.reduce((s,b)=>s+Number((b.allocations.find(a=>Number(a.variation_id)===Number(v.id))||{}).stock_qty||0),0);
    res.json({product,variations,branches:branchRows,required_branch_count:required,counted_branch_count:counted,can_finalize_product:crossBranch(req),ready_to_finalize:crossBranch(req)&&required>0&&branchRows.filter(b=>Math.abs(Number(b.parent_branch_qty||0))>1e-9||b.status).every(b=>!!b.status),variation_reconciliation:variations.map(v=>({variation_id:v.id,variation_name:v.name,global_variation_qty:Number(v.stock_qty||0),branch_variation_qty:Number(branchVariationTotals[v.id]||0),variance:Number((Number(v.stock_qty||0)-Number(branchVariationTotals[v.id]||0)).toFixed(6))}))});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/opening-balance',requirePermission('inventory_edit'),async(req,res)=>{
  try{
    const productId=Number(req.body?.product_id||0),branchId=Number(req.body?.branch_id||0),reason=String(req.body?.reason||'').trim(),allocations=Array.isArray(req.body?.allocations)?req.body.allocations:[];
    if(!productId||!branchId)return res.status(400).json({error:'product_id and branch_id are required'});if(!branchAllowed(req,branchId))return denyBranch(res,branchId);if(reason.length<8)return res.status(400).json({error:'A specific physical-count reason of at least 8 characters is required'});
    const {rows:[existing]}=await db.execute({sql:'SELECT * FROM branch_variation_migrations WHERE product_id=? AND branch_id=?',args:[productId,branchId]});if(existing)return res.status(409).json({error:'This product/branch already has an authoritative variation opening balance. Use controlled inventory adjustments for later corrections.',control:'branch_variation_already_migrated'});
    const {rows:variations}=await db.execute({sql:'SELECT id,name,sku FROM product_variations WHERE product_id=? ORDER BY id',args:[productId]});if(!variations.length)return res.status(409).json({error:'Product has no variations'});
    const provided=new Map();for(const a of allocations){const id=Number(a.variation_id),qty=Number(a.quantity);if(!id||!Number.isFinite(qty)||qty<0)return res.status(400).json({error:'Every variation allocation requires a valid variation_id and non-negative quantity'});if(provided.has(id))return res.status(400).json({error:`Variation ${id} was supplied more than once`});provided.set(id,qty);}
    if(provided.size!==variations.length||variations.some(v=>!provided.has(Number(v.id))))return res.status(400).json({error:'Opening balance must explicitly count every variation, including zero quantities'});
    const {rows:[branch]}=await db.execute({sql:'SELECT id,name FROM branches WHERE id=?',args:[branchId]});if(!branch)return res.status(404).json({error:'Branch not found'});
    const total=Number([...provided.values()].reduce((s,n)=>s+n,0).toFixed(6));
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[again]}=await tx.execute({sql:'SELECT product_id FROM branch_variation_migrations WHERE product_id=? AND branch_id=?',args:[productId,branchId]});if(again)throw Object.assign(new Error('Another operator already established this opening balance'),{status:409,control:'branch_variation_migration_race'});
      const {rows:[parent]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]});const parentQty=Number(parent?.stock_qty||0);if(Math.abs(total-parentQty)>1e-6)throw Object.assign(new Error(`Physical variation count (${total}) must equal the authoritative branch product quantity (${parentQty}) before migration. Resolve the parent stock discrepancy first.`),{status:409,control:'branch_variation_parent_mismatch'});
      for(const v of variations){const qty=Number(provided.get(Number(v.id))||0);await tx.execute({sql:`INSERT INTO branch_variation_inventory(product_id,variation_id,branch_id,stock_qty,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,variation_id,branch_id) DO UPDATE SET stock_qty=excluded.stock_qty,updated_at=CURRENT_TIMESTAMP`,args:[productId,v.id,branchId,qty]});await tx.execute({sql:`INSERT INTO branch_variation_inventory_events(product_id,variation_id,branch_id,event_type,quantity_change,resulting_qty,reference_type,reference_id,employee_id,reason) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[productId,v.id,branchId,'opening_balance',qty,qty,'branch_variation_migration',`${productId}:${branchId}`,req.employee?.id||null,reason]});}
      await tx.execute({sql:`INSERT INTO branch_variation_migrations(product_id,branch_id,status,baseline_total,counted_by_employee_id,reason) VALUES(?,?,'counted',?,?,?)`,args:[productId,branchId,total,req.employee?.id||null,reason]});await tx.commit();committed=true;
      res.status(201).json({success:true,product_id:productId,branch_id:branchId,branch_name:branch.name,baseline_total:total,status:'counted'});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||500).json({error:e.message,control:e.control});}
});

router.post('/reconcile-product/:productId',requirePermission('inventory_edit'),async(req,res)=>{
  try{
    if(!crossBranch(req))return res.status(403).json({error:'Final product reconciliation spans branches and requires cross-branch administrative authority.',control:'branch_variation_finalize_scope'});
    const productId=Number(req.params.productId||0),reason=String(req.body?.reason||'').trim();if(!productId)return res.status(400).json({error:'Valid product id required'});if(reason.length<8)return res.status(400).json({error:'A reconciliation reason of at least 8 characters is required'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:required}=await tx.execute({sql:`SELECT b.id,b.name,COALESCE(bi.stock_qty,0) qty,m.status FROM branches b LEFT JOIN branch_inventory bi ON bi.branch_id=b.id AND bi.product_id=? LEFT JOIN branch_variation_migrations m ON m.product_id=? AND m.branch_id=b.id WHERE b.active=1 OR COALESCE(bi.stock_qty,0)<>0`,args:[productId,productId]});
      const incomplete=required.filter(b=>(Math.abs(Number(b.qty||0))>1e-9||b.status)&&!b.status);if(incomplete.length)throw Object.assign(new Error(`Variation opening balance is still missing for: ${incomplete.map(x=>x.name).join(', ')}`),{status:409,control:'branch_variation_migration_incomplete'});
      for(const b of required.filter(x=>x.status)){const {rows:[sum]}=await tx.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_variation_inventory WHERE product_id=? AND branch_id=?',args:[productId,b.id]});if(Math.abs(Number(sum?.qty||0)-Number(b.qty||0))>1e-6)throw Object.assign(new Error(`${b.name} branch variation ledger no longer equals parent branch inventory. Reconcile that branch before finalizing.`),{status:409,control:'branch_variation_branch_drift'});}
      const {rows:variations}=await tx.execute({sql:'SELECT id,name,stock_qty FROM product_variations WHERE product_id=? ORDER BY id',args:[productId]});if(!variations.length)throw Object.assign(new Error('Product has no variations'),{status:409});const results=[];
      for(const v of variations){const {rows:[sum]}=await tx.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_variation_inventory WHERE product_id=? AND variation_id=?',args:[productId,v.id]});const qty=Number(sum?.qty||0);await tx.execute({sql:'UPDATE product_variations SET stock_qty=? WHERE id=? AND product_id=?',args:[qty,v.id,productId]});results.push({variation_id:v.id,variation_name:v.name,previous_global_qty:Number(v.stock_qty||0),reconciled_global_qty:qty});}
      const {rows:[parent]}=await tx.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_inventory WHERE product_id=?',args:[productId]});await tx.execute({sql:'UPDATE products SET stock_qty=? WHERE id=?',args:[Number(parent?.qty||0),productId]});await tx.execute({sql:`UPDATE branch_variation_migrations SET status='finalized',finalized_at=CURRENT_TIMESTAMP WHERE product_id=?`,args:[productId]});
      for(const r of results)await tx.execute({sql:`INSERT INTO branch_variation_inventory_events(product_id,variation_id,branch_id,event_type,quantity_change,resulting_qty,reference_type,reference_id,employee_id,reason) SELECT ?,?,bvi.branch_id,'migration_finalize',0,bvi.stock_qty,'product_variation_reconciliation',?,?,? FROM branch_variation_inventory bvi WHERE bvi.product_id=? AND bvi.variation_id=?`,args:[productId,r.variation_id,String(productId),req.employee?.id||null,reason,productId,r.variation_id]});
      await tx.commit();committed=true;res.json({success:true,product_id:productId,parent_global_qty:Number(parent?.qty||0),variations:results,status:'finalized'});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(e.status||500).json({error:e.message,control:e.control});}
});

router.get('/events',requirePermission('inventory'),async(req,res)=>{
  try{const args=[];let sql=`SELECT e.*,p.name product_name,pv.name variation_name,pv.sku variation_sku,b.name branch_name,emp.first_name||' '||emp.last_name employee_name FROM branch_variation_inventory_events e JOIN products p ON p.id=e.product_id JOIN product_variations pv ON pv.id=e.variation_id JOIN branches b ON b.id=e.branch_id LEFT JOIN employees emp ON emp.id=e.employee_id WHERE 1=1`;if(req.query.product_id){sql+=' AND e.product_id=?';args.push(req.query.product_id);}if(req.query.branch_id){if(!branchAllowed(req,req.query.branch_id))return denyBranch(res,req.query.branch_id);sql+=' AND e.branch_id=?';args.push(req.query.branch_id);}else if(!crossBranch(req)&&ownBranch(req)!=null){sql+=' AND e.branch_id=?';args.push(ownBranch(req));}sql+=' ORDER BY e.created_at DESC,e.id DESC LIMIT 500';const {rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
