const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can}=require('../lib/permissions');

const CONTEXT_PERMISSIONS={
  inventory:['inventory'],
  pos:['pos','transactions'],
  quote:['quotations'],
  purchase_request:['purchase_requests','purchasing'],
  purchase_order:['purchasing'],
  receiving:['purchasing_receive','purchasing']
};
function allowed(req,context){
  if(req.apiKey)return true;
  if(!req.employee)return false;
  const keys=CONTEXT_PERMISSIONS[context]||[];
  return keys.some(k=>can(req.employee.permissions,k));
}
function guard(req,res,next){const context=String(req.body?.context||req.query?.context||'inventory');if(!allowed(req,context))return res.status(403).json({error:`Not permitted to use catalog workflow from ${context}`});req.catalogContext=context;next();}
function num(v,d=0){const n=Number(v);return Number.isFinite(n)?n:d;}
async function ensureSchema(){
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS inventory_item_creation_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      source_context TEXT NOT NULL,
      employee_id INTEGER REFERENCES employees(id),
      branch_id INTEGER REFERENCES branches(id),
      source_reference TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_inventory_item_creation_context ON inventory_item_creation_events(source_context,created_at)'}
  ],'write');
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Catalog workflow initialization failed',detail:e.message});}});

router.get('/search',guard,async(req,res)=>{
  try{
    const q=String(req.query.q||'').trim();const branchId=req.query.branch_id||null;const limit=Math.min(100,Math.max(1,Number(req.query.limit||30)));
    const args=[];let stock='p.stock_qty';let join='';
    if(branchId){join=' LEFT JOIN branch_inventory bi ON bi.product_id=p.id AND bi.branch_id=?';args.push(branchId);stock='COALESCE(bi.stock_qty,0)';}
    let sql=`SELECT p.id,p.sku,p.barcode,p.name,p.description,p.price,p.cost,p.tax_rate,p.stock_qty global_stock_qty,${stock} stock_qty,p.min_stock,p.active,p.supplier_id,p.category_id,p.unit FROM products p${join} WHERE p.active=1`;
    if(q){sql+=` AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.description LIKE ?)`;const like=`%${q}%`;args.push(like,like,like,like);}
    sql+=' ORDER BY CASE WHEN lower(p.sku)=lower(?) THEN 0 WHEN lower(p.barcode)=lower(?) THEN 1 WHEN lower(p.name)=lower(?) THEN 2 WHEN lower(p.name) LIKE lower(?) THEN 3 ELSE 4 END,p.name LIMIT ?';
    args.push(q,q,q,`${q}%`,limit);
    const {rows}=await db.execute({sql,args});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/items',guard,async(req,res)=>{
  try{
    const b=req.body||{};const name=String(b.name||'').trim();let sku=String(b.sku||'').trim();const barcode=String(b.barcode||'').trim()||null;
    if(!name)return res.status(400).json({error:'Item name is required'});
    if(!sku)sku=`NEW-${Date.now().toString(36).toUpperCase()}`;
    const price=Math.max(0,num(b.price));const cost=Math.max(0,num(b.cost));const tax=Math.max(0,num(b.tax_rate,8.5));const minStock=Math.max(0,Math.floor(num(b.min_stock,0)));const opening=Math.max(0,Math.floor(num(b.opening_qty,0)));const branchId=b.branch_id||null;
    const tx=await db.transaction('write');let committed=false;
    try{
      const r=await tx.execute({sql:`INSERT INTO products(sku,barcode,name,description,category_id,price,cost,tax_rate,stock_qty,min_stock,active,supplier_id,unit) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`,args:[sku,barcode,name,b.description||null,b.category_id||null,price,cost,tax,opening,minStock,b.supplier_id||null,b.unit||'each']});
      const productId=Number(r.lastInsertRowid);
      if(branchId){await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=excluded.stock_qty,min_stock=excluded.min_stock,updated_at=CURRENT_TIMESTAMP`,args:[productId,branchId,opening,minStock]});}
      if(opening>0)await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,'opening_balance',?,?)`,args:[productId,branchId,opening,`CAT-${productId}`,`Opening quantity created through ${req.catalogContext} catalog workflow`]});
      await tx.execute({sql:`INSERT INTO inventory_item_creation_events(product_id,source_context,employee_id,branch_id,source_reference) VALUES(?,?,?,?,?)`,args:[productId,req.catalogContext,req.employee?.id||null,branchId,b.source_reference||null]});
      await tx.commit();committed=true;
      const {rows:[product]}=await db.execute({sql:'SELECT * FROM products WHERE id=?',args:[productId]});res.status(201).json(product);
    }catch(e){if(!committed)await tx.rollback();if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'SKU or barcode already exists'});throw e;}
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/purchase-orders/:poId/items',guard,async(req,res)=>{
  try{
    if(!['purchase_order','receiving'].includes(req.catalogContext))return res.status(400).json({error:'Invalid context for purchase-order item add'});
    const {rows:[po]}=await db.execute({sql:'SELECT * FROM purchase_orders WHERE id=?',args:[req.params.poId]});if(!po)return res.status(404).json({error:'Purchase order not found'});if(['received','cancelled'].includes(po.status))return res.status(409).json({error:'Purchase order is closed'});
    const productId=Number(req.body.product_id);const qty=Math.max(1,Math.floor(num(req.body.quantity,1)));const {rows:[p]}=await db.execute({sql:'SELECT * FROM products WHERE id=? AND active=1',args:[productId]});if(!p)return res.status(404).json({error:'Catalog item not found'});const unitCost=Math.max(0,num(req.body.unit_cost,p.cost));const total=Number((qty*unitCost).toFixed(2));
    const r=await db.execute({sql:`INSERT INTO purchase_order_items(po_id,product_id,product_name,sku,quantity_ordered,quantity_received,unit_cost,total) VALUES(?,?,?,?,?,0,?,?)`,args:[po.id,p.id,p.name,p.sku,qty,unitCost,total]});await db.execute({sql:`UPDATE purchase_orders SET subtotal=(SELECT COALESCE(SUM(total),0) FROM purchase_order_items WHERE po_id=?),total=(SELECT COALESCE(SUM(total),0) FROM purchase_order_items WHERE po_id=?) WHERE id=?`,args:[po.id,po.id,po.id]});res.status(201).json({id:Number(r.lastInsertRowid),product_id:p.id,product_name:p.name,sku:p.sku,quantity_ordered:qty,quantity_received:0,unit_cost:unitCost,total});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/purchase-requests/:prId/items',guard,async(req,res)=>{
  try{
    if(req.catalogContext!=='purchase_request')return res.status(400).json({error:'Invalid context for purchase-request item add'});
    const {rows:[pr]}=await db.execute({sql:'SELECT * FROM purchase_requests WHERE id=?',args:[req.params.prId]});if(!pr)return res.status(404).json({error:'Purchase request not found'});if(!['draft','submitted','approved'].includes(pr.status))return res.status(409).json({error:'Purchase request cannot accept new items in its current status'});
    const productId=Number(req.body.product_id);const qty=Math.max(1,Math.floor(num(req.body.quantity,1)));const {rows:[p]}=await db.execute({sql:'SELECT * FROM products WHERE id=? AND active=1',args:[productId]});if(!p)return res.status(404).json({error:'Catalog item not found'});const unitCost=Math.max(0,num(req.body.unit_cost,p.cost));const total=Number((qty*unitCost).toFixed(2));const r=await db.execute({sql:`INSERT INTO purchase_request_items(pr_id,product_id,product_name,quantity,unit_cost,item_type,total) VALUES(?,?,?,?,?,'sale',?)`,args:[pr.id,p.id,p.name,qty,unitCost,total]});res.status(201).json({id:Number(r.lastInsertRowid),product_id:p.id,product_name:p.name,quantity:qty,unit_cost:unitCost,total});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/purchase-order-items/:itemId/link',guard,async(req,res)=>{
  try{
    if(req.catalogContext!=='receiving')return res.status(400).json({error:'Receiving context required'});const {rows:[line]}=await db.execute({sql:`SELECT poi.*,po.status FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.po_id WHERE poi.id=?`,args:[req.params.itemId]});if(!line)return res.status(404).json({error:'Purchase-order line not found'});if(['received','cancelled'].includes(line.status))return res.status(409).json({error:'Purchase order is closed'});const {rows:[p]}=await db.execute({sql:'SELECT id,name,sku FROM products WHERE id=? AND active=1',args:[req.body.product_id]});if(!p)return res.status(404).json({error:'Catalog item not found'});await db.execute({sql:'UPDATE purchase_order_items SET product_id=?,product_name=?,sku=? WHERE id=?',args:[p.id,p.name,p.sku,line.id]});res.json({success:true,product:p});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
