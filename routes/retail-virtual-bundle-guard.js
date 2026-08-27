'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureProductComposition,getComposition,buildVirtualSalePlan}=require('../lib/product-composition');

let readyPromise=null;
async function ensureBundleSales(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureProductComposition();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS transaction_virtual_bundle_lines(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        composition_id INTEGER NOT NULL REFERENCES product_compositions(id),
        parent_product_id INTEGER NOT NULL REFERENCES products(id),
        parent_product_name TEXT NOT NULL,
        parent_sku TEXT,
        bundle_quantity REAL NOT NULL,
        bundle_unit_price REAL NOT NULL,
        bundle_line_total REAL NOT NULL,
        tax_rate REAL NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS transaction_virtual_bundle_components(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bundle_line_id INTEGER NOT NULL REFERENCES transaction_virtual_bundle_lines(id),
        transaction_item_id INTEGER REFERENCES transaction_items(id),
        component_product_id INTEGER NOT NULL REFERENCES products(id),
        component_quantity REAL NOT NULL,
        allocated_unit_price REAL NOT NULL,
        allocated_line_total REAL NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS virtual_bundle_reconciliation(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER REFERENCES transactions(id),
        issue_type TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_tx_virtual_bundle_tx ON transaction_virtual_bundle_lines(transaction_id,id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_tx_virtual_bundle_component_line ON transaction_virtual_bundle_components(bundle_line_id,id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

function cleanClientMarkers(line){
  const out={...line};
  for(const key of Object.keys(out))if(key.startsWith('_bundle_'))delete out[key];
  return out;
}

function identityFor(line,productId){
  const rows=Array.isArray(line.bundle_components)?line.bundle_components:[];
  const match=rows.find(x=>Number(x?.product_id||x?.component_product_id)===Number(productId));
  if(!match)return {};
  return {
    serial_numbers:Array.isArray(match.serial_numbers)?match.serial_numbers:undefined,
    lots:Array.isArray(match.lots)?match.lots:undefined
  };
}

async function findVirtualComposition(executor,productId){
  const {rows:[row]}=await executor.execute({sql:`SELECT id FROM product_compositions WHERE parent_product_id=? AND composition_type='virtual_bundle' AND active=1 ORDER BY id DESC LIMIT 1`,args:[productId]});
  return row?getComposition(executor,Number(row.id)):null;
}

async function expand(req){
  await ensureBundleSales();
  const body=req.body||{},branchId=Number(body.branch_id||0),input=Array.isArray(body.items)?body.items:[];
  if(!input.length||!branchId)return;
  const expanded=[],groups=[];
  for(let inputIndex=0;inputIndex<input.length;inputIndex++){
    const original=cleanClientMarkers(input[inputIndex]||{}),productId=Number(original.product_id);
    if(!productId){expanded.push(original);continue;}
    const composition=await findVirtualComposition(db,productId);
    if(!composition){expanded.push(original);continue;}
    if(original.uom_code||original.unit)throw Object.assign(new Error('Virtual bundles must be sold in their base kit unit; alternate packaging UOM is not supported on the virtual parent'),{status:409});
    const bundleQty=Number(original.quantity);
    if(!Number.isInteger(bundleQty)||bundleQty<=0)throw Object.assign(new Error('Virtual bundle quantity must be a positive whole number'),{status:409});
    const {rows:[parent]}=await db.execute({sql:'SELECT id,name,sku,price,tax_rate,active FROM products WHERE id=?',args:[productId]});
    if(!parent||!parent.active)throw Object.assign(new Error('Virtual bundle parent product is unavailable'),{status:409});
    const plan=await buildVirtualSalePlan(db,{composition,branchId,bundleQuantity:bundleQty});
    if(!plan.can_fulfill)throw Object.assign(new Error(`Only ${plan.available_kits} complete ${parent.name} bundle(s) are currently available`),{status:409});
    const componentRows=[];
    for(const p of plan.components){
      const {rows:[product]}=await db.execute({sql:'SELECT id,name,sku,price,tax_rate,active,is_service,is_non_inventory FROM products WHERE id=?',args:[p.product_id]});
      if(!product||!product.active||product.is_service||product.is_non_inventory)throw Object.assign(new Error(`Bundle component ${p.product_id} is not an active physical inventory product`),{status:409});
      if(Math.abs(Number(product.tax_rate||0)-Number(parent.tax_rate||0))>1e-9)throw Object.assign(new Error(`Virtual bundle ${parent.name} cannot mix component tax rates; ${product.name} differs from the bundle tax rate`),{status:409});
      const nested=await findVirtualComposition(db,product.id);if(nested)throw Object.assign(new Error(`Nested virtual bundle component ${product.name} is not supported; flatten the bundle recipe first`),{status:409});
      componentRows.push({plan:p,product,weight:Math.max(0,Number(product.price||0)*Number(p.quantity||0))});
    }
    let totalWeight=componentRows.reduce((s,x)=>s+x.weight,0);if(totalWeight<=0)totalWeight=componentRows.reduce((s,x)=>s+Number(x.plan.quantity||0),0);
    const bundleUnitPrice=Number(parent.price||0),bundleLineTotal=Number((bundleUnitPrice*bundleQty).toFixed(2));let allocated=0;
    const group={input_index:inputIndex,composition_id:composition.id,parent_product_id:productId,parent_product_name:parent.name,parent_sku:parent.sku||'',bundle_quantity:bundleQty,bundle_unit_price:bundleUnitPrice,bundle_line_total:bundleLineTotal,tax_rate:Number(parent.tax_rate||0),component_entries:[]};
    for(let i=0;i<componentRows.length;i++){
      const row=componentRows[i],qty=Number(row.plan.quantity||0);const weight=totalWeight>0?(row.weight>0?row.weight:Number(qty))/totalWeight:1/componentRows.length;
      const lineTotal=i===componentRows.length-1?Number((bundleLineTotal-allocated).toFixed(2)):Number((bundleLineTotal*weight).toFixed(2));allocated=Number((allocated+lineTotal).toFixed(2));
      const unitPrice=qty>0?Number((lineTotal/qty).toFixed(6)):0;const identity=identityFor(original,row.product.id);
      const generated={product_id:row.product.id,product_name:row.product.name,sku:row.product.sku||'',quantity:qty,unit_price:unitPrice,uom_base_unit_price:unitPrice,tax_rate:Number(parent.tax_rate||0),discount:0,...identity,_bundle_server_price:true,_bundle_group_index:groups.length,_bundle_parent_product_id:productId,_bundle_composition_id:composition.id};
      group.component_entries.push({expanded_index:expanded.length,component_product_id:row.product.id,component_quantity:qty,allocated_unit_price:unitPrice,allocated_line_total:lineTotal});
      expanded.push(generated);
    }
    groups.push(group);
  }
  if(groups.length){req.body.items=expanded;req.virtualBundleContext={groups,expanded_count:expanded.length};}
}

async function persistBundleEvidence(req,payload){
  const context=req.virtualBundleContext;if(!context?.groups?.length||!payload?.id)return;
  const {rows:saved}=await db.execute({sql:'SELECT * FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[payload.id]});
  if(saved.length!==context.expanded_count)throw new Error(`Saved transaction item count ${saved.length} does not match expanded bundle plan ${context.expanded_count}`);
  const tx=await db.transaction('write');let committed=false;
  try{
    const bundleLines=[];
    for(const group of context.groups){
      const r=await tx.execute({sql:`INSERT INTO transaction_virtual_bundle_lines(transaction_id,composition_id,parent_product_id,parent_product_name,parent_sku,bundle_quantity,bundle_unit_price,bundle_line_total,tax_rate) VALUES(?,?,?,?,?,?,?,?,?)`,args:[payload.id,group.composition_id,group.parent_product_id,group.parent_product_name,group.parent_sku,group.bundle_quantity,group.bundle_unit_price,group.bundle_line_total,group.tax_rate]});
      const lineId=Number(r.lastInsertRowid);
      for(const c of group.component_entries){const savedItem=saved[c.expanded_index];if(!savedItem||Number(savedItem.product_id)!==Number(c.component_product_id))throw new Error('Expanded bundle component order no longer matches saved transaction evidence');await tx.execute({sql:`INSERT INTO transaction_virtual_bundle_components(bundle_line_id,transaction_item_id,component_product_id,component_quantity,allocated_unit_price,allocated_line_total) VALUES(?,?,?,?,?,?)`,args:[lineId,savedItem.id,c.component_product_id,c.component_quantity,c.allocated_unit_price,c.allocated_line_total]});}
      bundleLines.push({id:lineId,parent_product_id:group.parent_product_id,parent_product_name:group.parent_product_name,parent_sku:group.parent_sku,quantity:group.bundle_quantity,unit_price:group.bundle_unit_price,total:group.bundle_line_total,tax_rate:group.tax_rate});
    }
    await tx.commit();committed=true;payload.bundle_lines=bundleLines;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}

router.use(async(req,res,next)=>{try{await ensureBundleSales();next();}catch(e){res.status(500).json({error:'Virtual bundle initialization failed',detail:e.message});}});
router.post('/',requirePermission('pos'),async(req,res,next)=>{
  try{await expand(req);}catch(e){return res.status(e.status||409).json({error:e.message});}
  if(!req.virtualBundleContext)return next();
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){
    if(handled)return originalJson(payload);handled=true;
    if(res.statusCode>=200&&res.statusCode<300&&payload?.id){
      return persistBundleEvidence(req,payload).then(()=>originalJson(payload)).catch(async e=>{await db.execute({sql:`INSERT INTO virtual_bundle_reconciliation(transaction_id,issue_type,details) VALUES(?, 'bundle_evidence_finalization_failed', ?)`,args:[payload.id,String(e.message||e)]}).catch(()=>{});if(!res.headersSent){res.status(500);return originalJson({error:'Sale posted but virtual bundle evidence finalization failed; reconciliation required',transaction_id:payload.id,detail:e.message});}});
    }
    return originalJson(payload);
  };
  next();
});

module.exports=router;
module.exports.ensureBundleSales=ensureBundleSales;
