'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,requirePermission}=require('../lib/permissions');
const {ensureBundleSales}=require('./retail-virtual-bundle-guard');

let readyPromise=null;
async function ensureBundleLifecycle(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureBundleSales();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS return_virtual_bundle_lines(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        original_bundle_line_id INTEGER NOT NULL REFERENCES transaction_virtual_bundle_lines(id),
        composition_id INTEGER NOT NULL REFERENCES product_compositions(id),
        parent_product_id INTEGER NOT NULL REFERENCES products(id),
        parent_product_name TEXT NOT NULL,
        bundle_quantity REAL NOT NULL,
        bundle_unit_price REAL NOT NULL,
        bundle_line_total REAL NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS return_virtual_bundle_components(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_bundle_line_id INTEGER NOT NULL REFERENCES return_virtual_bundle_lines(id),
        return_item_id INTEGER REFERENCES return_items(id),
        original_transaction_item_id INTEGER NOT NULL REFERENCES transaction_items(id),
        component_product_id INTEGER NOT NULL REFERENCES products(id),
        component_quantity REAL NOT NULL,
        allocated_unit_price REAL NOT NULL,
        allocated_line_total REAL NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_return_bundle_return ON return_virtual_bundle_lines(return_id,id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_return_bundle_original ON return_virtual_bundle_lines(original_transaction_id,original_bundle_line_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_return_bundle_component ON return_virtual_bundle_components(return_bundle_line_id,id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function loadBundleLine(executor,transactionId,bundleLineId){
  const {rows:[line]}=await executor.execute({sql:`SELECT * FROM transaction_virtual_bundle_lines WHERE id=? AND transaction_id=?`,args:[bundleLineId,transactionId]});
  if(!line)return null;
  const {rows:components}=await executor.execute({sql:`SELECT c.*,ti.product_name,ti.sku,ti.quantity sold_transaction_quantity,ti.unit_price sold_component_unit_price
    FROM transaction_virtual_bundle_components c JOIN transaction_items ti ON ti.id=c.transaction_item_id
    WHERE c.bundle_line_id=? ORDER BY c.id`,args:[bundleLineId]});
  line.components=components;return line;
}

async function returnedByTransactionItem(executor,transactionId){
  const {rows}=await executor.execute({sql:`SELECT ri.transaction_item_id,COALESCE(SUM(ri.quantity),0) returned_qty
    FROM return_items ri JOIN returns r ON r.id=ri.return_id
    WHERE r.original_transaction_id=? AND r.status!='cancelled'
    GROUP BY ri.transaction_item_id`,args:[transactionId]});
  return new Map(rows.map(r=>[Number(r.transaction_item_id),Number(r.returned_qty||0)]));
}

function identityFor(bundleRequest,component){
  const rows=Array.isArray(bundleRequest?.components)?bundleRequest.components:[];
  const match=rows.find(x=>Number(x?.transaction_item_id)===Number(component.transaction_item_id)||Number(x?.product_id||x?.component_product_id)===Number(component.component_product_id));
  if(!match)return {};
  return {
    serial_numbers:Array.isArray(match.serial_numbers)?match.serial_numbers:undefined,
    lots:Array.isArray(match.lots)?match.lots:undefined
  };
}

async function prepareBundleReturns(req){
  await ensureBundleLifecycle();
  const transactionId=Number(req.params.id),bundleRequests=Array.isArray(req.body?.bundle_returns)?req.body.bundle_returns:[];
  if(!transactionId||!bundleRequests.length)return;
  const {rows:[sale]}=await db.execute({sql:`SELECT id,status FROM transactions WHERE id=?`,args:[transactionId]});
  if(!sale)throw Object.assign(new Error('Original transaction not found'),{status:404});
  if(sale.status!=='completed')throw Object.assign(new Error('Only completed transactions can have bundle returns'),{status:409});
  const returned=await returnedByTransactionItem(db,transactionId);
  const generated=[];const evidence=[];const seenItems=new Set((Array.isArray(req.body.items)?req.body.items:[]).map(x=>Number(x.transaction_item_id)).filter(Boolean));
  const seenBundleLines=new Set();
  for(const request of bundleRequests){
    const bundleLineId=Number(request.bundle_line_id),qty=Number(request.quantity);
    if(!bundleLineId||!Number.isInteger(qty)||qty<=0)throw Object.assign(new Error('Each bundle return requires bundle_line_id and a positive whole-number quantity'),{status:400});
    if(seenBundleLines.has(bundleLineId))throw Object.assign(new Error(`Bundle line ${bundleLineId} is listed more than once`),{status:400});seenBundleLines.add(bundleLineId);
    const line=await loadBundleLine(db,transactionId,bundleLineId);if(!line)throw Object.assign(new Error(`Bundle line ${bundleLineId} does not belong to transaction ${transactionId}`),{status:409});
    let maxBundles=Number(line.bundle_quantity||0);
    for(const c of line.components){
      const perBundle=Number(c.component_quantity||0)/Number(line.bundle_quantity||1);if(!(perBundle>0))throw new Error('Bundle component evidence has an invalid per-bundle quantity');
      const sold=Number(c.component_quantity||0),already=Number(returned.get(Number(c.transaction_item_id))||0),remaining=Math.max(0,sold-already);
      maxBundles=Math.min(maxBundles,Math.floor((remaining+1e-9)/perBundle));
    }
    if(qty>maxBundles)throw Object.assign(new Error(`Only ${maxBundles} complete ${line.parent_product_name} bundle(s) remain returnable from this transaction`),{status:409});
    const group={bundle_line_id:bundleLineId,composition_id:Number(line.composition_id),parent_product_id:Number(line.parent_product_id),parent_product_name:line.parent_product_name,bundle_quantity:qty,bundle_unit_price:Number(line.bundle_unit_price||0),bundle_line_total:Number((Number(line.bundle_unit_price||0)*qty).toFixed(2)),components:[]};
    for(const c of line.components){
      const transactionItemId=Number(c.transaction_item_id);if(seenItems.has(transactionItemId))throw Object.assign(new Error(`${c.product_name} is included in both an explicit item return and a bundle return; choose one return path`),{status:409});seenItems.add(transactionItemId);
      const perBundle=Number(c.component_quantity||0)/Number(line.bundle_quantity||1),componentQty=Number((perBundle*qty).toFixed(6));
      const commercialShare=Number(line.bundle_quantity||0)>0?Number(c.allocated_line_total||0)/Number(line.bundle_quantity||1):0;
      const allocatedLineTotal=Number((commercialShare*qty).toFixed(2));
      const generatedLine={transaction_item_id:transactionItemId,quantity:componentQty,...identityFor(request,c)};
      generated.push(generatedLine);
      group.components.push({transaction_item_id:transactionItemId,component_product_id:Number(c.component_product_id),component_quantity:componentQty,allocated_unit_price:Number(c.allocated_unit_price||0),allocated_line_total:allocatedLineTotal});
    }
    evidence.push(group);
  }
  req.body.items=[...(Array.isArray(req.body.items)?req.body.items:[]),...generated];
  req.virtualBundleReturnContext={groups:evidence};
  delete req.body.bundle_returns;
}

async function persistBundleReturn(req,payload){
  const context=req.virtualBundleReturnContext;if(!payload?.id||!context?.groups?.length)return;
  const {rows:returnItems}=await db.execute({sql:'SELECT * FROM return_items WHERE return_id=? ORDER BY id',args:[payload.id]});
  const byTxItem=new Map(returnItems.map(x=>[Number(x.transaction_item_id),x]));
  const tx=await db.transaction('write');let committed=false;
  try{
    const presentation=[];
    for(const group of context.groups){
      const r=await tx.execute({sql:`INSERT INTO return_virtual_bundle_lines(return_id,original_transaction_id,original_bundle_line_id,composition_id,parent_product_id,parent_product_name,bundle_quantity,bundle_unit_price,bundle_line_total)
        VALUES(?,?,?,?,?,?,?,?,?)`,args:[payload.id,Number(req.params.id),group.bundle_line_id,group.composition_id,group.parent_product_id,group.parent_product_name,group.bundle_quantity,group.bundle_unit_price,group.bundle_line_total]});
      const returnBundleLineId=Number(r.lastInsertRowid);
      for(const c of group.components){
        const item=byTxItem.get(Number(c.transaction_item_id));if(!item)throw new Error(`Returned bundle component transaction item ${c.transaction_item_id} was not persisted`);
        await tx.execute({sql:`INSERT INTO return_virtual_bundle_components(return_bundle_line_id,return_item_id,original_transaction_item_id,component_product_id,component_quantity,allocated_unit_price,allocated_line_total) VALUES(?,?,?,?,?,?,?)`,args:[returnBundleLineId,item.id,c.transaction_item_id,c.component_product_id,c.component_quantity,c.allocated_unit_price,c.allocated_line_total]});
      }
      presentation.push({id:returnBundleLineId,parent_product_id:group.parent_product_id,parent_product_name:group.parent_product_name,quantity:group.bundle_quantity,unit_price:group.bundle_unit_price,total:group.bundle_line_total});
    }
    await tx.commit();committed=true;payload.bundle_lines=presentation;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}

router.use(async(req,res,next)=>{try{await ensureBundleLifecycle();next();}catch(e){res.status(500).json({error:'Virtual bundle lifecycle initialization failed',detail:e.message});}});

router.get('/:id/bundles',requireAuth,async(req,res)=>{
  try{
    const transactionId=Number(req.params.id);const {rows:lines}=await db.execute({sql:`SELECT * FROM transaction_virtual_bundle_lines WHERE transaction_id=? ORDER BY id`,args:[transactionId]});
    const returned=await returnedByTransactionItem(db,transactionId);
    for(const line of lines){
      const full=await loadBundleLine(db,transactionId,line.id);line.components=full?.components||[];
      let returnable=Number(line.bundle_quantity||0);
      for(const c of line.components){const per=Number(c.component_quantity||0)/Number(line.bundle_quantity||1),remaining=Math.max(0,Number(c.component_quantity||0)-Number(returned.get(Number(c.transaction_item_id))||0));returnable=Math.min(returnable,Math.floor((remaining+1e-9)/per));c.returned_quantity=Number(returned.get(Number(c.transaction_item_id))||0);}
      line.returnable_bundle_quantity=Math.max(0,returnable);
      const {rows:serials}=await db.execute({sql:`SELECT e.product_id,s.serial_number,e.event_type,e.created_at FROM inventory_identity_events e JOIN inventory_serials s ON s.id=e.serial_id WHERE e.reference_type='transaction' AND e.reference_id=? AND e.event_type='sold' AND e.product_id IN (${line.components.map(()=>'?').join(',')||'NULL'}) ORDER BY e.id`,args:[String(transactionId),...line.components.map(c=>c.component_product_id)]});
      line.serial_identity=serials;
    }
    res.json(lines);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/:id/returns/:returnId/bundles',requireAuth,async(req,res)=>{
  try{const {rows:lines}=await db.execute({sql:`SELECT * FROM return_virtual_bundle_lines WHERE original_transaction_id=? AND return_id=? ORDER BY id`,args:[Number(req.params.id),Number(req.params.returnId)]});for(const line of lines){const {rows:components}=await db.execute({sql:`SELECT c.*,ri.product_name,ri.sku FROM return_virtual_bundle_components c LEFT JOIN return_items ri ON ri.id=c.return_item_id WHERE c.return_bundle_line_id=? ORDER BY c.id`,args:[line.id]});line.components=components;}res.json(lines);}catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/return',requirePermission('transactions_returns'),async(req,res,next)=>{
  try{await prepareBundleReturns(req);}catch(e){return res.status(e.status||409).json({error:e.message});}
  if(!req.virtualBundleReturnContext)return next();
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return persistBundleReturn(req,payload).then(()=>originalJson(payload)).catch(async e=>{await db.execute({sql:`INSERT INTO virtual_bundle_reconciliation(transaction_id,issue_type,details) VALUES(?, 'bundle_return_evidence_failed', ?)`,args:[Number(req.params.id),String(e.message||e)]}).catch(()=>{});if(!res.headersSent){res.status(500);return originalJson({error:'Return posted but bundle return evidence finalization failed; reconciliation required',return_id:payload.id,detail:e.message});}});return originalJson(payload);};
  next();
});

module.exports=router;
module.exports.ensureBundleLifecycle=ensureBundleLifecycle;
