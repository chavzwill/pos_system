'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    const {rows}=await db.execute({sql:'PRAGMA table_info(purchase_order_items)',args:[]});
    if(!rows.some(x=>x.name==='variation_id'))await db.execute({sql:'ALTER TABLE purchase_order_items ADD COLUMN variation_id INTEGER REFERENCES product_variations(id)',args:[]});
    await db.execute({sql:'CREATE INDEX IF NOT EXISTS idx_purchase_order_items_variation ON purchase_order_items(product_id,variation_id)',args:[]});
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Purchase-order variation authority initialization failed',detail:e.message});}});

async function resolveVariation(executor,item){
  const productId=Number(item.product_id||0),variationId=Number(item.variation_id||0);
  if(!productId){if(variationId)throw Object.assign(new Error('A variation cannot be selected for a free-typed PO item'),{status:409});return null;}
  const {rows:[product]}=await executor.execute({sql:'SELECT id,name,sku,cost FROM products WHERE id=?',args:[productId]});
  if(!product)throw Object.assign(new Error(`Product ${productId} was not found`),{status:409});
  const {rows:[count]}=await executor.execute({sql:'SELECT COUNT(*) count FROM product_variations WHERE product_id=? AND active=1',args:[productId]});
  if(Number(count?.count||0)>0&&!variationId)throw Object.assign(new Error(`${product.name} has active variations. Select the exact variation before creating the purchase order.`),{status:409,control:'po_variation_required'});
  if(!variationId)return {product,variation:null};
  const {rows:[variation]}=await executor.execute({sql:'SELECT id,product_id,name,sku,cost,active FROM product_variations WHERE id=? AND product_id=?',args:[variationId,productId]});
  if(!variation||Number(variation.active)!==1)throw Object.assign(new Error(`Selected variation does not belong to ${product.name} or is inactive`),{status:409,control:'po_variation_invalid'});
  return {product,variation};
}

router.post('/',requirePermission('purchasing_create'),async(req,res,next)=>{
  try{
    const {supplier_id,branch_id,employee_id,items,notes,expected_date}=req.body||{};
    if(!supplier_id)return res.status(400).json({error:'A supplier is required for a purchase order'});
    if(!branch_id)return res.status(400).json({error:'A receiving branch is required for a purchase order'});
    if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'No items in PO'});
    const prepared=[];let subtotal=0;
    for(const item of items){
      const qty=Number(item.quantity_ordered??item.quantity??0);if(!Number.isInteger(qty)||qty<=0)return res.status(400).json({error:'Every PO line requires a positive whole-number quantity'});
      const resolved=await resolveVariation(db,item);
      const product=resolved?.product||null,variation=resolved?.variation||null;
      const suppliedCost=item.unit_cost===undefined||item.unit_cost===null||item.unit_cost===''?NaN:Number(item.unit_cost);
      const fallback=variation?.cost??product?.cost??0;const unitCost=Number.isFinite(suppliedCost)?suppliedCost:Number(fallback||0);
      if(!Number.isFinite(unitCost)||unitCost<0)return res.status(400).json({error:'PO unit cost cannot be negative'});
      const lineTotal=Number((qty*unitCost).toFixed(2));subtotal=Number((subtotal+lineTotal).toFixed(2));
      prepared.push({product_id:product?.id||null,variation_id:variation?.id||null,product_name:item.product_name||product?.name||'Unknown',sku:variation?.sku||item.sku||product?.sku||'',quantity_ordered:qty,unit_cost:unitCost,total:lineTotal});
    }
    const poNumber=await nextNumber(db,'purchase_orders','po_number','PO-',6);const tx=await db.transaction('write');let committed=false;
    try{
      const r=await tx.execute({sql:'INSERT INTO purchase_orders(po_number,supplier_id,branch_id,employee_id,subtotal,total,notes,expected_date) VALUES(?,?,?,?,?,?,?,?)',args:[poNumber,supplier_id,branch_id,employee_id||req.employee?.id||null,subtotal,subtotal,notes||null,expected_date||null]});
      const poId=Number(r.lastInsertRowid);
      for(const item of prepared)await tx.execute({sql:'INSERT INTO purchase_order_items(po_id,product_id,variation_id,product_name,sku,quantity_ordered,unit_cost,total) VALUES(?,?,?,?,?,?,?,?)',args:[poId,item.product_id,item.variation_id,item.product_name,item.sku,item.quantity_ordered,item.unit_cost,item.total]});
      await tx.commit();committed=true;
      const {rows:[po]}=await db.execute({sql:`SELECT po.*,s.name supplier_name,b.name branch_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id WHERE po.id=?`,args:[poId]});
      const {rows:poItems}=await db.execute({sql:`SELECT poi.*,pv.name variation_name,pv.sku variation_sku FROM purchase_order_items poi LEFT JOIN product_variations pv ON pv.id=poi.variation_id WHERE poi.po_id=? ORDER BY poi.id`,args:[poId]});
      po.items=poItems;return res.status(201).json(po);
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){return res.status(e.status||400).json({error:e.message,control:e.control});}
});

router.get('/:id',async(req,res,next)=>{
  if(!/^\d+$/.test(String(req.params.id)))return next();
  try{
    const {rows:[po]}=await db.execute({sql:`SELECT po.*,s.name supplier_name,s.contact_name supplier_contact,s.email supplier_email,b.name branch_name,e.first_name||' '||e.last_name employee_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id LEFT JOIN employees e ON e.id=po.employee_id WHERE po.id=?`,args:[req.params.id]});
    if(!po)return res.status(404).json({error:'Not found'});
    const {rows:items}=await db.execute({sql:`SELECT poi.*,pv.name variation_name,pv.sku variation_sku,pv.attributes variation_attributes,pv.active variation_active,(SELECT COUNT(*) FROM product_variations x WHERE x.product_id=poi.product_id AND x.active=1) active_variation_count FROM purchase_order_items poi LEFT JOIN product_variations pv ON pv.id=poi.variation_id WHERE poi.po_id=? ORDER BY poi.id`,args:[req.params.id]});
    po.items=items;return res.json(po);
  }catch(e){return res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
