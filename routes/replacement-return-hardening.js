'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {syncBinQty}=require('../lib/binSync');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryTraceability();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS replacement_fulfillments(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        return_item_id INTEGER NOT NULL REFERENCES return_items(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        transaction_item_id INTEGER NOT NULL REFERENCES transaction_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        variation_id INTEGER REFERENCES product_variations(id),
        branch_id INTEGER REFERENCES branches(id),
        quantity INTEGER NOT NULL,
        unit_cost_at_issue REAL,
        issued_by_employee_id INTEGER REFERENCES employees(id),
        issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(return_item_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS return_quarantine(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        return_item_id INTEGER NOT NULL REFERENCES return_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER REFERENCES branches(id),
        quantity INTEGER NOT NULL,
        unit_cost_at_return REAL,
        disposition_status TEXT NOT NULL DEFAULT 'quarantine',
        disposition_notes TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        UNIQUE(return_item_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_replacement_return ON replacement_fulfillments(return_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_return_quarantine_return ON return_quarantine(return_id)'}
    ],'write');
    const {rows:cols}=await db.execute({sql:'PRAGMA table_info(replacement_fulfillments)',args:[]});
    if(!cols.some(c=>c.name==='variation_id'))await db.execute({sql:'ALTER TABLE replacement_fulfillments ADD COLUMN variation_id INTEGER REFERENCES product_variations(id)',args:[]});
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Replacement return integrity initialization failed',detail:e.message});}});

function money(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):0;}
function conflict(message){const e=new Error(message);e.status=409;return e;}

router.post('/:id/return',requirePermission('transactions_returns'),async(req,res,next)=>{
  if(req.body?.resolution!=='replacement')return next();
  try{
    const transactionId=Number(req.params.id);
    const items=Array.isArray(req.body?.items)?req.body.items:[];
    if(!transactionId)return res.status(400).json({error:'Invalid transaction id'});
    if(!items.length)return res.status(400).json({error:'No items selected for replacement'});
    if(!req.employee)return res.status(401).json({error:'Authenticated employee required for replacement issue'});

    const {rows:[sale]}=await db.execute({sql:'SELECT * FROM transactions WHERE id=?',args:[transactionId]});
    if(!sale)return res.status(404).json({error:'Transaction not found'});
    if(sale.status!=='completed')return res.status(409).json({error:'Only completed transactions can be replaced'});
    const {rows:[linkedRental]}=await db.execute({sql:'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id=? OR settlement_transaction_id=?',args:[sale.id,sale.id]});
    if(linkedRental)return res.status(409).json({error:`This transaction belongs to rental agreement ${linkedRental.agreement_number}; use the Rentals workflow.`});
    const {rows:[linkedRepair]}=await db.execute({sql:'SELECT wo_number FROM work_orders WHERE assessment_transaction_id=? OR deposit_transaction_id=? OR final_transaction_id=?',args:[sale.id,sale.id,sale.id]});
    if(linkedRepair)return res.status(409).json({error:`This transaction belongs to work order ${linkedRepair.wo_number}; use the Repairs workflow.`});

    const {rows:saleItems}=await db.execute({sql:'SELECT * FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[sale.id]});
    const {rows:alreadyReturned}=await db.execute({sql:`SELECT ri.transaction_item_id,COALESCE(SUM(ri.quantity),0) returned_qty
      FROM return_items ri JOIN returns r ON r.id=ri.return_id
      WHERE r.original_transaction_id=? AND COALESCE(r.status,'completed')!='cancelled'
      GROUP BY ri.transaction_item_id`,args:[sale.id]});
    const returnedMap=new Map(alreadyReturned.map(r=>[Number(r.transaction_item_id),Number(r.returned_qty||0)]));

    let subtotal=0,tax=0;const prepared=[];
    for(const requestItem of items){
      const line=saleItems.find(x=>Number(x.id)===Number(requestItem.transaction_item_id));
      if(!line)return res.status(400).json({error:`Item ${requestItem.transaction_item_id} not found in transaction`});
      if(!line.product_id)return res.status(409).json({error:`Replacement cannot be issued for non-inventory line ${line.product_name}`});
      const qty=Number(requestItem.quantity||0),maxQty=Number(line.quantity||0)-Number(returnedMap.get(Number(line.id))||0);
      if(!Number.isInteger(qty)||qty<=0||qty>maxQty)return res.status(409).json({error:`Invalid replacement quantity for ${line.product_name}. Max replaceable: ${Math.max(0,maxQty)}`});

      const profile=await getTrackingProfile(db,Number(line.product_id));
      if(profile.tracking_mode!=='none'){
        return res.status(409).json({
          error:`${line.product_name} is ${profile.tracking_mode}-controlled. A like-for-like replacement must use the controlled identity exchange workflow so the returned identity can be quarantined and the issued identity can be recorded.`,
          control:'replacement_identity_required',tracking_mode:profile.tracking_mode,transaction_item_id:line.id
        });
      }

      const {rows:[product]}=await db.execute({sql:'SELECT id,name,stock_qty,cost FROM products WHERE id=?',args:[line.product_id]});
      if(!product)return res.status(409).json({error:`Replacement product ${line.product_id} no longer exists`});
      let variation=null;
      if(line.variation_id){
        const {rows:[v]}=await db.execute({sql:'SELECT id,product_id,stock_qty FROM product_variations WHERE id=? AND product_id=?',args:[line.variation_id,line.product_id]});
        if(!v)return res.status(409).json({error:`The original variation for ${line.product_name} no longer exists`});
        variation=v;
        if(Number(v.stock_qty||0)<qty)return res.status(409).json({error:`Insufficient variation stock to issue ${qty} replacement unit(s) of ${line.product_name}`});
      }else if(Number(product.stock_qty||0)<qty){
        return res.status(409).json({error:`Insufficient stock to issue ${qty} replacement unit(s) of ${line.product_name}`});
      }
      if(sale.branch_id){
        const {rows:[branchStock]}=await db.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[line.product_id,sale.branch_id]});
        if(!branchStock||Number(branchStock.stock_qty||0)<qty)return res.status(409).json({error:`Insufficient branch stock to issue ${qty} replacement unit(s) of ${line.product_name}`});
      }
      const ratio=qty/Number(line.quantity||1),lineSubtotal=money(Number(line.total||0)*ratio),lineTax=money(Number(line.tax_amount||0)*ratio);
      subtotal=money(subtotal+lineSubtotal);tax=money(tax+lineTax);
      prepared.push({line,product,variation,qty,lineSubtotal,lineTax});
    }

    const total=money(subtotal+tax),returnNumber=await nextNumber(db,'returns','return_number','RET-',6),actorId=req.employee.id;
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[liveSale]}=await tx.execute({sql:'SELECT id,status,branch_id FROM transactions WHERE id=?',args:[sale.id]});
      if(!liveSale||liveSale.status!=='completed')throw conflict('The original sale changed before replacement issue; refresh before trying again');
      const {rows:liveReturned}=await tx.execute({sql:`SELECT ri.transaction_item_id,COALESCE(SUM(ri.quantity),0) returned_qty
        FROM return_items ri JOIN returns r ON r.id=ri.return_id
        WHERE r.original_transaction_id=? AND COALESCE(r.status,'completed')!='cancelled' GROUP BY ri.transaction_item_id`,args:[sale.id]});
      const liveMap=new Map(liveReturned.map(r=>[Number(r.transaction_item_id),Number(r.returned_qty||0)]));
      for(const p of prepared){
        const max=Number(p.line.quantity||0)-Number(liveMap.get(Number(p.line.id))||0);
        if(p.qty>max)throw conflict(`Another return changed ${p.line.product_name}; only ${Math.max(0,max)} unit(s) remain replaceable`);
        if(p.variation){
          const u=await tx.execute({sql:'UPDATE product_variations SET stock_qty=stock_qty-? WHERE id=? AND product_id=? AND stock_qty>=?',args:[p.qty,p.variation.id,p.line.product_id,p.qty]});
          if(Number(u.rowsAffected||0)!==1)throw conflict(`Replacement variation stock changed for ${p.line.product_name}; refresh and retry`);
        }else{
          const u=await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty-? WHERE id=? AND stock_qty>=?',args:[p.qty,p.line.product_id,p.qty]});
          if(Number(u.rowsAffected||0)!==1)throw conflict(`Replacement stock changed for ${p.line.product_name}; refresh and retry`);
        }
        if(sale.branch_id){
          const u=await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND stock_qty>=?',args:[p.qty,p.line.product_id,sale.branch_id,p.qty]});
          if(Number(u.rowsAffected||0)!==1)throw conflict(`Branch stock changed for ${p.line.product_name}; refresh and retry`);
        }
      }

      const rr=await tx.execute({sql:`INSERT INTO returns(return_number,original_transaction_id,customer_id,employee_id,branch_id,resolution,subtotal,tax_amount,total,notes)
        VALUES(?,?,?,?,?,'replacement',?,?,?,?)`,args:[returnNumber,sale.id,sale.customer_id||null,actorId,sale.branch_id||null,subtotal,tax,total,req.body?.notes||null]});
      const returnId=Number(rr.lastInsertRowid);
      for(const p of prepared){
        const ri=await tx.execute({sql:`INSERT INTO return_items(return_id,transaction_item_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total,unit_cost_at_return)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[returnId,p.line.id,p.line.product_id,p.line.product_name,p.line.sku,p.qty,p.line.unit_price,p.lineTax,p.lineSubtotal,p.line.unit_cost_at_sale??null]});
        const returnItemId=Number(ri.lastInsertRowid);
        await tx.execute({sql:`INSERT INTO return_quarantine(return_id,return_item_id,product_id,branch_id,quantity,unit_cost_at_return,disposition_status,disposition_notes)
          VALUES(?,?,?,?,?,?,'quarantine',?)`,args:[returnId,returnItemId,p.line.product_id,sale.branch_id||null,p.qty,p.line.unit_cost_at_sale??null,'Returned unit withheld from sellable inventory pending inspection/disposition']});
        if(sale.branch_id)await syncBinQty(tx,p.line.product_id,sale.branch_id,-p.qty);
        await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason)
          VALUES(?,?,?,'replacement_issue',?,?)`,args:[p.line.product_id,sale.branch_id||null,-p.qty,returnNumber,`Like-for-like replacement issued for transaction ${sale.transaction_number}`]});
        await tx.execute({sql:`INSERT INTO replacement_fulfillments(return_id,return_item_id,original_transaction_id,transaction_item_id,product_id,variation_id,branch_id,quantity,unit_cost_at_issue,issued_by_employee_id)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[returnId,returnItemId,sale.id,p.line.id,p.line.product_id,p.variation?.id||null,sale.branch_id||null,p.qty,Number(p.product.cost||0),actorId]});
      }
      await tx.commit();committed=true;
      const {rows:[ret]}=await db.execute({sql:'SELECT * FROM returns WHERE id=?',args:[returnId]});
      const {rows:retItems}=await db.execute({sql:'SELECT * FROM return_items WHERE return_id=? ORDER BY id',args:[returnId]});
      const {rows:fulfillments}=await db.execute({sql:'SELECT * FROM replacement_fulfillments WHERE return_id=? ORDER BY id',args:[returnId]});
      const {rows:quarantine}=await db.execute({sql:'SELECT * FROM return_quarantine WHERE return_id=? ORDER BY id',args:[returnId]});
      res.status(201).json({...ret,items:retItems,replacement_fulfillments:fulfillments,quarantine});
    }catch(e){if(!committed)await tx.rollback();res.status(e.status||500).json({error:e.message,control:e.status===409?'replacement_concurrency':undefined});}
  }catch(e){res.status(e.status||500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
