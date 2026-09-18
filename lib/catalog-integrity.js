'use strict';
const { db }=require('../database');
const { ensureSecurityAuditTable, recordSecurityAudit }=require('./securityAudit');

const SAFE_TABLE=/^[a-zA-Z0-9_]+$/;
function err(code,message,status=409){const e=new Error(message);e.code=code;e.status=status;return e;}
async function referenceTables(){
  const {rows}=await db.execute({sql:`SELECT m.name table_name FROM sqlite_master m
    WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'
      AND EXISTS(SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name='product_id')
    ORDER BY m.name`,args:[]});
  return rows.map(r=>String(r.table_name||'')).filter(x=>SAFE_TABLE.test(x));
}
async function inspectProductCleanup(productId){
  const id=Number(productId);if(!Number.isInteger(id)||id<=0)throw err('CATALOG_PRODUCT_ID_INVALID','A valid product is required.',400);
  const {rows:[product]}=await db.execute({sql:'SELECT id,sku,barcode,name,active,stock_qty FROM products WHERE id=? LIMIT 1',args:[id]});
  if(!product)throw err('CATALOG_PRODUCT_NOT_FOUND','Product not found.',404);
  const {rows:branches}=await db.execute({sql:'SELECT branch_id,stock_qty,min_stock,updated_at FROM branch_inventory WHERE product_id=? ORDER BY branch_id',args:[id]});
  const branchStock=branches.reduce((s,r)=>s+Number(r.stock_qty||0),0);
  const hasBranchStock=branches.some(r=>Math.abs(Number(r.stock_qty||0))>1e-9);
  const references=[];let totalReferences=0;
  for(const table of await referenceTables()){
    if(table==='branch_inventory')continue;
    const {rows:[r]}=await db.execute({sql:`SELECT COUNT(*) c FROM ${table} WHERE product_id=?`,args:[id]});
    const count=Number(r?.c||0);if(count){references.push({table,count});totalReferences+=count;}
  }
  return{product:{...product,active:Boolean(product.active),global_stock_qty:Number(product.stock_qty||0)},
    stock:{branch_stock_qty:branchStock,branches},historical:{reference_count:totalReferences,references},
    can_archive:Math.abs(Number(product.stock_qty||0))<=1e-9&&!hasBranchStock};
}
async function archiveProduct(productId,{actorEmployeeId=null,requestId=null,method=null,path=null}={}){
  const before=await inspectProductCleanup(productId);
  if(!before.can_archive)throw err('CATALOG_PRODUCT_STOCK_PRESENT','Move, sell, return, adjust, or write off all remaining stock before retiring this product.');
  await ensureSecurityAuditTable();
  const tx=await db.transaction('write');let committed=false;
  try{
    const result=await tx.execute({sql:`UPDATE products SET active=0 WHERE id=? AND COALESCE(stock_qty,0)=0
      AND NOT EXISTS(SELECT 1 FROM branch_inventory bi WHERE bi.product_id=products.id AND COALESCE(bi.stock_qty,0)<>0)`,args:[Number(productId)]});
    if(Number(result.rowsAffected||0)!==1)throw err('CATALOG_PRODUCT_STOCK_PRESENT','Stock changed while this product was being retired. Review the quantities and try again.');
    await recordSecurityAudit({
      actorEmployeeId,
      action:'catalog_product_retired',
      targetType:'product',
      targetId:Number(productId),
      oldValue:{active:Boolean(before.product.active),sku:before.product.sku,name:before.product.name},
      newValue:{active:false},
      reason:'Product retired from catalog administration',
      requestId,method,path,control:'catalog_integrity',executor:tx
    });
    const {rows:[product]}=await tx.execute({sql:'SELECT * FROM products WHERE id=?',args:[Number(productId)]});
    await tx.commit();committed=true;
    return{product,historical_references_preserved:before.historical.reference_count};
  }catch(error){
    if(!committed)await tx.rollback();
    throw error;
  }
}
function issue(code,severity,title,why,record,next){return{code,severity,title,why_it_matters:why,record,what_to_do_next:next};}
async function catalogHealth({limit=100}={}){
  const max=Math.min(200,Math.max(1,Number(limit)||100));
  const issues=[];
  const {rows:products}=await db.execute({sql:`SELECT p.id,p.sku,p.name,p.active,p.stock_qty,p.category_id,p.supplier_id,p.online_available,p.image_path,p.is_service,p.is_rental,p.is_non_inventory,
    COALESCE((SELECT SUM(bi.stock_qty) FROM branch_inventory bi WHERE bi.product_id=p.id),0) branch_stock_qty
    FROM products p ORDER BY p.id LIMIT ?`,args:[max]});
  for(const p of products){
    const globalQty=Number(p.stock_qty||0),branchQty=Number(p.branch_stock_qty||0),record={type:'product',id:p.id,sku:p.sku,name:p.name};
    if(!Number(p.active)&&(globalQty!==0||branchQty!==0))issues.push(issue('inactive_with_stock','high','Retired product still has stock','Inactive products should not hold physical inventory.',record,'Review the stock location and use the controlled stock movement or write-off workflow.'));
    if(globalQty!==branchQty)issues.push(issue('stock_balance_mismatch','high','Product stock totals do not agree','Global and branch quantities should reconcile before staff rely on availability.',record,'Open Stock Finder and reconcile the exact branch quantities before changing the product record.'));
    if(Number(p.active)&&!p.category_id)issues.push(issue('missing_category','medium','Product has no category','Categories help staff find products and keep website navigation consistent.',record,'Assign the product to the correct category.'));
    if(Number(p.active)&&!Number(p.is_service)&&!Number(p.is_rental)&&!Number(p.is_non_inventory)&&!p.supplier_id)issues.push(issue('missing_supplier','medium','Product has no supplier','Purchasing and supplier reporting are less reliable without a supplier link.',record,'Assign the normal replenishment supplier.'));
    if(Number(p.active)&&Number(p.online_available)&&!p.image_path)issues.push(issue('online_missing_image','low','Online product has no image','Customers may see an incomplete product listing online.',record,'Add a clear product image before publishing or keep the item offline.'));
  }
  const {rows:dupes}=await db.execute({sql:`SELECT lower(trim(name)) normalized_name,COUNT(*) duplicate_count,group_concat(id) ids,MIN(name) name
    FROM categories GROUP BY lower(trim(name)) HAVING COUNT(*)>1 ORDER BY normalized_name LIMIT ?`,args:[max]});
  for(const c of dupes)issues.push(issue('duplicate_category_name','medium','Duplicate category names','Duplicate categories split reporting and make product selection harder.',{type:'category',name:c.name,ids:String(c.ids).split(',').map(Number)},'Merge or rename the duplicate categories, then reassign affected products.'));
  const counts={};for(const i of issues)counts[i.code]=(counts[i.code]||0)+1;
  return{summary:{needs_attention:issues.length,by_issue:counts},issues:issues.slice(0,max),generated_at:new Date().toISOString()};
}
module.exports={inspectProductCleanup,archiveProduct,catalogHealth};
