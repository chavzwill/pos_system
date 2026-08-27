'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureProductComposition,getComposition,buildVirtualSalePlan}=require('../lib/product-composition');

let readyPromise=null;
async function ensureQuoteBundleSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureProductComposition();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS quotation_virtual_bundle_lines(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quote_id INTEGER NOT NULL REFERENCES quotations(id),
        composition_id INTEGER NOT NULL REFERENCES product_compositions(id),
        parent_product_id INTEGER NOT NULL REFERENCES products(id),
        parent_product_name TEXT NOT NULL,
        parent_sku TEXT,
        bundle_quantity REAL NOT NULL,
        bundle_unit_price REAL NOT NULL,
        bundle_line_total REAL NOT NULL,
        tax_rate REAL NOT NULL DEFAULT 0,
        branch_available_kits REAL,
        availability_snapshot TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS quotation_virtual_bundle_components(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bundle_line_id INTEGER NOT NULL REFERENCES quotation_virtual_bundle_lines(id),
        quotation_item_id INTEGER REFERENCES quotation_items(id),
        component_product_id INTEGER NOT NULL REFERENCES products(id),
        component_quantity REAL NOT NULL,
        allocated_unit_price REAL NOT NULL,
        allocated_line_total REAL NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_quote_bundle_quote ON quotation_virtual_bundle_lines(quote_id,id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_quote_bundle_component ON quotation_virtual_bundle_components(bundle_line_id,id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function stripMarkers(line){const out={...line};for(const k of Object.keys(out))if(k.startsWith('_bundle_'))delete out[k];return out;}
async function findComposition(executor,productId){
  const {rows:[row]}=await executor.execute({sql:`SELECT id FROM product_compositions WHERE parent_product_id=? AND composition_type='virtual_bundle' AND active=1 ORDER BY id DESC LIMIT 1`,args:[productId]});
  return row?getComposition(executor,Number(row.id)):null;
}
async function expandQuote(req){
  await ensureQuoteBundleSchema();
  const input=Array.isArray(req.body?.items)?req.body.items:[];if(!input.length)return;
  const branchId=Number(req.body?.branch_id||0),expanded=[],groups=[];
  for(let inputIndex=0;inputIndex<input.length;inputIndex++){
    const original=stripMarkers(input[inputIndex]||{}),productId=Number(original.product_id||0);
    if(!productId){expanded.push(original);continue;}
    const composition=await findComposition(db,productId);if(!composition){expanded.push(original);continue;}
    if(original.uom_code||original.unit)throw Object.assign(new Error('Virtual bundle quotations use the kit unit; alternate parent UOM is not supported'),{status:409});
    const bundleQty=Number(original.quantity);if(!Number.isInteger(bundleQty)||bundleQty<=0)throw Object.assign(new Error('Virtual bundle quote quantity must be a positive whole number'),{status:409});
    const {rows:[parent]}=await db.execute({sql:'SELECT id,name,sku,price,tax_rate,active FROM products WHERE id=?',args:[productId]});
    if(!parent||!parent.active)throw Object.assign(new Error('Virtual bundle parent product is unavailable'),{status:409});
    const availability=branchId?await buildVirtualSalePlan(db,{composition,branchId,bundleQuantity:bundleQty}):null;
    const componentRows=[];
    for(const c of composition.components){
      const {rows:[p]}=await db.execute({sql:'SELECT id,name,sku,price,tax_rate,active,is_service,is_non_inventory FROM products WHERE id=?',args:[c.component_product_id]});
      if(!p||!p.active||p.is_service||p.is_non_inventory)throw Object.assign(new Error(`Bundle component ${c.component_product_id} is not an active physical inventory product`),{status:409});
      if(Math.abs(Number(p.tax_rate||0)-Number(parent.tax_rate||0))>1e-9)throw Object.assign(new Error(`Virtual bundle ${parent.name} cannot mix tax rates; ${p.name} differs from the parent`),{status:409});
      if(await findComposition(db,p.id))throw Object.assign(new Error(`Nested virtual bundle component ${p.name} is not supported; flatten the recipe first`),{status:409});
      const quantity=Number(c.quantity_per_parent||0)*bundleQty;
      componentRows.push({component:c,product:p,quantity,weight:Math.max(0,Number(p.price||0)*quantity)});
    }
    let weightTotal=componentRows.reduce((s,x)=>s+x.weight,0);if(weightTotal<=0)weightTotal=componentRows.reduce((s,x)=>s+x.quantity,0);
    const bundleUnitPrice=Number(parent.price||0),bundleLineTotal=Number((bundleUnitPrice*bundleQty).toFixed(2));let allocated=0;
    const group={input_index:inputIndex,composition_id:composition.id,parent_product_id:parent.id,parent_product_name:parent.name,parent_sku:parent.sku||'',bundle_quantity:bundleQty,bundle_unit_price:bundleUnitPrice,bundle_line_total:bundleLineTotal,tax_rate:Number(parent.tax_rate||0),branch_available_kits:availability?.available_kits??null,availability_snapshot:availability?JSON.stringify(availability):null,component_entries:[]};
    for(let i=0;i<componentRows.length;i++){
      const row=componentRows[i],share=weightTotal>0?(row.weight>0?row.weight:row.quantity)/weightTotal:1/componentRows.length;
      const lineTotal=i===componentRows.length-1?Number((bundleLineTotal-allocated).toFixed(2)):Number((bundleLineTotal*share).toFixed(2));allocated=Number((allocated+lineTotal).toFixed(2));
      const unitPrice=row.quantity>0?Number((lineTotal/row.quantity).toFixed(6)):0;
      const generated={product_id:row.product.id,product_name:row.product.name,sku:row.product.sku||'',quantity:row.quantity,unit_price:unitPrice,discount:0,_bundle_server_price:true,_bundle_group_index:groups.length,_bundle_parent_product_id:parent.id,_bundle_composition_id:composition.id};
      group.component_entries.push({expanded_index:expanded.length,component_product_id:row.product.id,component_quantity:row.quantity,allocated_unit_price:unitPrice,allocated_line_total:lineTotal});expanded.push(generated);
    }
    groups.push(group);
  }
  if(groups.length){req.body.items=expanded;req.quoteVirtualBundleContext={groups,expanded_count:expanded.length};}
}
async function persist(req,payload){
  const context=req.quoteVirtualBundleContext;if(!context?.groups?.length||!payload?.id)return;
  const quoteId=Number(payload.id);const {rows:saved}=await db.execute({sql:'SELECT * FROM quotation_items WHERE quote_id=? ORDER BY id',args:[quoteId]});
  if(saved.length!==context.expanded_count)throw new Error(`Saved quotation item count ${saved.length} does not match expanded bundle plan ${context.expanded_count}`);
  const tx=await db.transaction('write');let committed=false;
  try{
    await tx.execute({sql:`DELETE FROM quotation_virtual_bundle_components WHERE bundle_line_id IN (SELECT id FROM quotation_virtual_bundle_lines WHERE quote_id=?)`,args:[quoteId]});
    await tx.execute({sql:'DELETE FROM quotation_virtual_bundle_lines WHERE quote_id=?',args:[quoteId]});
    const bundleLines=[];
    for(const g of context.groups){
      const r=await tx.execute({sql:`INSERT INTO quotation_virtual_bundle_lines(quote_id,composition_id,parent_product_id,parent_product_name,parent_sku,bundle_quantity,bundle_unit_price,bundle_line_total,tax_rate,branch_available_kits,availability_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[quoteId,g.composition_id,g.parent_product_id,g.parent_product_name,g.parent_sku,g.bundle_quantity,g.bundle_unit_price,g.bundle_line_total,g.tax_rate,g.branch_available_kits,g.availability_snapshot]});
      const lineId=Number(r.lastInsertRowid);
      for(const c of g.component_entries){const item=saved[c.expanded_index];if(!item||Number(item.product_id)!==Number(c.component_product_id))throw new Error('Bundle quote component order no longer matches saved quotation evidence');await tx.execute({sql:`INSERT INTO quotation_virtual_bundle_components(bundle_line_id,quotation_item_id,component_product_id,component_quantity,allocated_unit_price,allocated_line_total) VALUES(?,?,?,?,?,?)`,args:[lineId,item.id,c.component_product_id,c.component_quantity,c.allocated_unit_price,c.allocated_line_total]});}
      bundleLines.push({id:lineId,parent_product_id:g.parent_product_id,parent_product_name:g.parent_product_name,parent_sku:g.parent_sku,quantity:g.bundle_quantity,unit_price:g.bundle_unit_price,total:g.bundle_line_total,tax_rate:g.tax_rate,branch_available_kits:g.branch_available_kits});
    }
    await tx.commit();committed=true;payload.bundle_lines=bundleLines;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}
function guard(){return async(req,res,next)=>{
  try{await expandQuote(req);}catch(e){return res.status(e.status||409).json({error:e.message});}
  if(!req.quoteVirtualBundleContext)return next();
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return persist(req,payload).then(()=>originalJson(payload)).catch(e=>{if(!res.headersSent){res.status(500);return originalJson({error:'Quotation saved but bundle evidence finalization failed; reconciliation required',quote_id:payload.id,detail:e.message});}});return originalJson(payload);};next();
};}
router.use(async(req,res,next)=>{try{await ensureQuoteBundleSchema();next();}catch(e){res.status(500).json({error:'Quotation bundle initialization failed',detail:e.message});}});
router.post('/',guard());
router.put('/:id',guard());
router.get('/:id/bundles',async(req,res,next)=>{
  try{const {rows:lines}=await db.execute({sql:'SELECT * FROM quotation_virtual_bundle_lines WHERE quote_id=? ORDER BY id',args:[req.params.id]});if(!lines.length)return next();for(const line of lines){const {rows:components}=await db.execute({sql:`SELECT c.*,qi.product_name,qi.sku FROM quotation_virtual_bundle_components c LEFT JOIN quotation_items qi ON qi.id=c.quotation_item_id WHERE c.bundle_line_id=? ORDER BY c.id`,args:[line.id]});for(const component of components){const {rows:sources}=await db.execute({sql:'SELECT * FROM quotation_item_sources WHERE quotation_item_id=? ORDER BY id',args:[component.quotation_item_id]});component.sources=sources;}line.components=components;}res.json(lines);}catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
module.exports.ensureQuoteBundleSchema=ensureQuoteBundleSchema;
