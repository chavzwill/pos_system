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
async function setProductLifecycle(productId,{status,reason,actorEmployeeId=null,requestId=null,method=null,path=null}={}){
  const id=Number(productId),next=String(status||'').trim().toLowerCase(),why=String(reason||'').trim();
  if(!Number.isInteger(id)||id<=0)throw err('CATALOG_PRODUCT_ID_INVALID','A valid product is required.',400);
  if(!['active','discontinued','obsolete'].includes(next))throw err('CATALOG_LIFECYCLE_INVALID','Choose Active, Discontinued, or Obsolete.',400);
  if(why.length<5)throw err('CATALOG_LIFECYCLE_REASON_REQUIRED','Enter a meaningful reason for this lifecycle change.',400);
  if(!Number.isInteger(Number(actorEmployeeId))||Number(actorEmployeeId)<=0)throw err('CATALOG_LIFECYCLE_ACTOR_REQUIRED','An authenticated employee is required.',401);
  const {rows:[before]}=await db.execute({sql:"SELECT id,sku,name,active,COALESCE(catalog_status,'active') catalog_status,stock_qty FROM products WHERE id=?",args:[id]});
  if(!before)throw err('CATALOG_PRODUCT_NOT_FOUND','Product not found.',404);
  if(before.catalog_status===next)return{product:before,changed:false};
  await ensureSecurityAuditTable();
  const tx=await db.transaction('write');let committed=false;
  try{
    const result=await tx.execute({sql:"UPDATE products SET catalog_status=?,catalog_status_reason=?,catalog_status_changed_at=CURRENT_TIMESTAMP,catalog_status_changed_by=? WHERE id=? AND COALESCE(catalog_status,'active')=?",args:[next,why,Number(actorEmployeeId),id,before.catalog_status]});
    if(Number(result.rowsAffected||0)!==1)throw err('CATALOG_LIFECYCLE_STALE','This product lifecycle changed while you were reviewing it. Refresh and try again.');
    await tx.execute({sql:'INSERT INTO catalog_product_lifecycle_events(product_id,from_status,to_status,reason,changed_by) VALUES(?,?,?,?,?)',args:[id,before.catalog_status,next,why,Number(actorEmployeeId)]});
    await recordSecurityAudit({actorEmployeeId:Number(actorEmployeeId),action:'catalog_product_lifecycle_changed',targetType:'product',targetId:id,oldValue:{catalog_status:before.catalog_status},newValue:{catalog_status:next},reason:why,requestId,method,path,control:'catalog_quality_lifecycle',executor:tx});
    const {rows:[product]}=await tx.execute({sql:'SELECT * FROM products WHERE id=?',args:[id]});
    await tx.commit();committed=true;return{product,changed:true};
  }catch(error){if(!committed)await tx.rollback();throw error;}
}
const SEVERITY_ORDER={critical:0,high:1,medium:2,low:3};
function issue(code,severity,title,why,record,next){return{code,severity,title,why_it_matters:why,record,what_to_do_next:next};}
function recordKey(record={}){
  if(record.type==='product'&&record.id!=null)return `product:${Number(record.id)}`;
  if(record.type==='category')return `category:${String(record.ids?.[0]??record.name??'unknown')}`;
  if(record.type==='product_group')return `product_group:${(record.product_ids||[]).map(Number).sort((a,b)=>a-b).join(',')}`;
  return `${record.type||'record'}:${record.id??record.name??'unknown'}`;
}
function buildRemediationQueue(issues=[]){
  const groups=new Map();
  for(const item of issues){
    const key=recordKey(item.record),rank=SEVERITY_ORDER[item.severity]??99;
    if(!groups.has(key))groups.set(key,{key,record:item.record,severity:item.severity,rank,issues:[],codes:[],issue_count:0});
    const group=groups.get(key);group.issues.push(item);group.codes.push(item.code);group.issue_count++;
    if(rank<group.rank){group.rank=rank;group.severity=item.severity;}
  }
  const items=[...groups.values()].map(group=>({...group,codes:[...new Set(group.codes)],titles:group.issues.map(x=>x.title),next_actions:[...new Set(group.issues.map(x=>x.what_to_do_next))]}));
  items.sort((a,b)=>a.rank-b.rank||String(a.key).localeCompare(String(b.key)));
  const by_severity={critical:0,high:0,medium:0,low:0};
  for(const item of items)by_severity[item.severity]=(by_severity[item.severity]||0)+1;
  return{total_records:items.length,by_severity,items};
}
function normalizeProductName(value){return String(value||'').trim().toLowerCase().replace(/\s+/g,' ');}
function normalizeSku(value){return String(value||'').trim().toLowerCase().replace(/[\s._\-/]+/g,'');}
function duplicateProductIssues(products){
  const issues=[],byName=new Map(),bySku=new Map();
  for(const p of products.filter(x=>Number(x.active))){
    const nameKey=normalizeProductName(p.name);
    if(nameKey){if(!byName.has(nameKey))byName.set(nameKey,[]);byName.get(nameKey).push(p);}
    const skuKey=normalizeSku(p.sku);
    if(skuKey){if(!bySku.has(skuKey))bySku.set(skuKey,[]);bySku.get(skuKey).push(p);}
  }
  for(const group of byName.values())if(group.length>1){
    issues.push(issue('duplicate_product_name','medium','Possible duplicate products','These active products have the same normalized name and may split stock, purchasing or reporting.',{type:'product_group',product_ids:group.map(x=>Number(x.id)),products:group.map(x=>({id:Number(x.id),sku:x.sku,name:x.name}))},'Review the products side by side. Confirm whether they are genuinely separate before using governed catalog maintenance.'));
  }
  for(const group of bySku.values()){
    const distinctSkus=new Set(group.map(x=>String(x.sku||'').trim().toLowerCase()));
    if(group.length>1&&distinctSkus.size>1)issues.push(issue('probable_duplicate_sku','medium','Possible duplicate SKUs','These active SKU values differ only by common separators or formatting and may refer to the same item.',{type:'product_group',product_ids:group.map(x=>Number(x.id)),products:group.map(x=>({id:Number(x.id),sku:x.sku,name:x.name}))},'Review the products side by side. Confirm whether they are genuinely separate before using governed catalog maintenance.'));
  }
  return issues;
}
async function catalogHealth({limit=100}={}){
  const max=Math.min(200,Math.max(1,Number(limit)||100));
  const issues=[];
  const {rows:products}=await db.execute({sql:`SELECT p.id,p.sku,p.barcode,p.name,p.active,p.stock_qty,p.category_id,p.brand_id,p.supplier_id,p.online_available,p.image_path,p.is_service,p.is_rental,p.is_non_inventory,p.unit,p.created_at,COALESCE(p.catalog_status,'active') catalog_status,
    COALESCE((SELECT SUM(bi.stock_qty) FROM branch_inventory bi WHERE bi.product_id=p.id),0) branch_stock_qty,
    (SELECT MAX(t.created_at) FROM transaction_items ti JOIN transactions t ON t.id=ti.transaction_id WHERE ti.product_id=p.id AND lower(COALESCE(t.status,''))='completed') last_sale_at,
    (SELECT MAX(COALESCE(po.received_at,po.created_at)) FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.po_id WHERE poi.product_id=p.id) last_purchase_at,
    (SELECT MAX(sm.created_at) FROM stock_movements sm WHERE sm.product_id=p.id) last_movement_at
    FROM products p ORDER BY p.id LIMIT ?`,args:[max]});
  for(const p of products){
    const globalQty=Number(p.stock_qty||0),branchQty=Number(p.branch_stock_qty||0),record={type:'product',id:p.id,sku:p.sku,name:p.name};
    if(!Number(p.active)&&(globalQty!==0||branchQty!==0))issues.push(issue('inactive_with_stock','high','Retired product still has stock','Inactive products should not hold physical inventory.',record,'Review the stock location and use the controlled stock movement or write-off workflow.'));
    if(globalQty!==branchQty)issues.push(issue('stock_balance_mismatch','high','Product stock totals do not agree','Global and branch quantities should reconcile before staff rely on availability.',record,'Open Stock Finder and reconcile the exact branch quantities before changing the product record.'));
    if(Number(p.active)&&!p.category_id)issues.push(issue('missing_category','medium','Product has no category','Categories help staff find products and keep website navigation consistent.',record,'Assign the product to the correct category.'));
    if(Number(p.active)&&!p.brand_id)issues.push(issue('missing_brand','medium','Product has no brand','Brands help staff identify products and keep website browsing and supplier reporting consistent.',record,'Assign the correct brand to this product.'));
    if(Number(p.active)&&!Number(p.is_service)&&!Number(p.is_rental)&&!Number(p.is_non_inventory)&&!p.supplier_id)issues.push(issue('missing_supplier','medium','Product has no supplier','Purchasing and supplier reporting are less reliable without a supplier link.',record,'Assign the normal replenishment supplier.'));
    if(Number(p.active)&&Number(p.online_available)&&!p.image_path)issues.push(issue('online_missing_image','low','Online product has no image','Customers may see an incomplete product listing online.',record,'Add a clear product image before publishing or keep the item offline.'));
    const physical=Number(p.active)&&!Number(p.is_service)&&!Number(p.is_rental)&&!Number(p.is_non_inventory);
    if(Number(p.active)&&!String(p.sku||'').trim())issues.push(issue('missing_sku','high','Product has no usable SKU','Staff, purchasing and integrations need a stable item code.',record,'Assign a unique SKU before using this product in normal operations.'));
    if(physical&&!String(p.unit||'').trim())issues.push(issue('missing_unit','medium','Product has no unit of measure','Without a unit, staff can misread what one quantity means when selling, ordering or counting stock.',record,'Set the correct unit, such as each, box, pair, metre or litre.'));
    if(physical&&!String(p.barcode||'').trim())issues.push(issue('missing_barcode','low','Product has no barcode','A missing barcode slows scanning and increases manual item lookup.',record,'Add the manufacturer barcode when one exists. Leave it blank only when the item genuinely has no barcode.'));
    if(Number(p.active)&&p.catalog_status==='obsolete'&&(globalQty!==0||branchQty!==0))issues.push(issue('obsolete_with_stock','high','Obsolete product still has stock','Obsolete stock still needs an explicit business decision; classification alone does not move or remove inventory.',record,'Review remaining stock and use a controlled sale, transfer, return, adjustment or write-off workflow.'));
    if(Number(p.active)&&p.catalog_status==='discontinued'&&globalQty===0&&branchQty===0)issues.push(issue('discontinued_zero_stock','low','Discontinued product has no stock','A discontinued zero-stock item may be ready for retirement if there is no business reason to keep it active.',record,'Review history and website needs, then retire it through the governed product retirement action if appropriate.'));
    if(physical&&p.catalog_status==='active'){
      const cutoff=Date.now()-365*86400000,created=Date.parse(p.created_at||'');
      const activity=[p.last_sale_at,p.last_purchase_at,p.last_movement_at].map(x=>Date.parse(x||'')).filter(Number.isFinite);
      const last=activity.length?Math.max(...activity):0;
      if(Number.isFinite(created)&&created<cutoff&&last<cutoff)issues.push(issue('stale_catalog_activity','low','Product has had no recent activity','No completed sale, purchase-order activity, or stock movement was found in the last 365 days. This is advisory only and does not automatically make it obsolete or retire it.',record,'Review demand, stock, supplier status and business use before changing its lifecycle.'));
    }
  }
  issues.push(...duplicateProductIssues(products));
  const {rows:dupes}=await db.execute({sql:`SELECT lower(trim(name)) normalized_name,COUNT(*) duplicate_count,group_concat(id) ids,MIN(name) name
    FROM categories GROUP BY lower(trim(name)) HAVING COUNT(*)>1 ORDER BY normalized_name LIMIT ?`,args:[max]});
  for(const c of dupes)issues.push(issue('duplicate_category_name','medium','Duplicate category names','Duplicate categories split reporting and make product selection harder.',{type:'category',name:c.name,ids:String(c.ids).split(',').map(Number)},'Merge or rename the duplicate categories, then reassign affected products.'));
  const counts={};for(const i of issues)counts[i.code]=(counts[i.code]||0)+1;
  const queue=buildRemediationQueue(issues);
  return{summary:{needs_attention:issues.length,records_needing_attention:queue.total_records,by_issue:counts,by_severity:queue.by_severity},remediation_queue:queue.items,issues:issues.slice(0,max),generated_at:new Date().toISOString()};
}
module.exports={inspectProductCleanup,archiveProduct,setProductLifecycle,catalogHealth,buildRemediationQueue,recordKey,duplicateProductIssues,normalizeProductName,normalizeSku};
