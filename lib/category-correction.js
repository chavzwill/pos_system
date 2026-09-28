'use strict';
const {db}=require('../database');
const {ensureSecurityAuditTable,recordSecurityAudit}=require('./securityAudit');

function fault(code,message,status=400){const e=new Error(message);e.code=code;e.status=status;return e;}
async function ensureSchema(){
  await db.execute({sql:`CREATE TABLE IF NOT EXISTS catalog_category_correction_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('details_corrected','products_reclassified')),
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor_employee_id INTEGER NOT NULL REFERENCES employees(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,args:[]});
  await db.execute({sql:`CREATE TRIGGER IF NOT EXISTS catalog_category_correction_events_no_update
    BEFORE UPDATE ON catalog_category_correction_events BEGIN
      SELECT RAISE(ABORT,'category correction events are append-only');
    END`,args:[]});
  await db.execute({sql:`CREATE TRIGGER IF NOT EXISTS catalog_category_correction_events_no_delete
    BEFORE DELETE ON catalog_category_correction_events BEGIN
      SELECT RAISE(ABORT,'category correction events are append-only');
    END`,args:[]});
}
async function snapshotCategory(categoryId,executor=db){
  const id=Number(categoryId);
  if(!Number.isInteger(id)||id<=0)throw fault('CATEGORY_ID_INVALID','Choose a valid category.',400);
  const {rows:[row]}=await executor.execute({sql:`SELECT c.id,c.name,c.description,COUNT(p.id) product_count
    FROM categories c LEFT JOIN products p ON p.category_id=c.id WHERE c.id=? GROUP BY c.id`,args:[id]});
  if(!row)throw fault('CATEGORY_NOT_FOUND','Category not found.',404);
  return{id:Number(row.id),name:row.name,description:row.description||null,product_count:Number(row.product_count||0)};
}
async function previewReclassification({sourceCategoryId,targetCategoryId,productIds=[]}={}){
  const source=await snapshotCategory(sourceCategoryId),target=await snapshotCategory(targetCategoryId);
  if(source.id===target.id)throw fault('CATEGORY_RECLASSIFICATION_SAME_CATEGORY','Choose a different destination category.',400);
  const ids=[...new Set((productIds||[]).map(Number).filter(Number.isInteger))].sort((a,b)=>a-b);
  const args=[source.id],where=['category_id=?'];
  if(ids.length){where.push(`id IN (${ids.map(()=>'?').join(',')})`);args.push(...ids);}
  const {rows:products}=await db.execute({sql:`SELECT id,sku,name,category_id FROM products WHERE ${where.join(' AND ')} ORDER BY id`,args});
  if(ids.length&&products.length!==ids.length)throw fault('CATEGORY_RECLASSIFICATION_STALE','Some selected products no longer belong to the source category. Refresh and try again.',409);
  return{source,target,products:products.map(p=>({id:Number(p.id),sku:p.sku||null,name:p.name})),product_count:products.length,expected_source_product_count:source.product_count,read_only:true};
}
async function correctCategoryDetails({categoryId,name,description,reason,expectedName,actorEmployeeId,requestId=null,method=null,path=null}={}){
  await ensureSchema();await ensureSecurityAuditTable();
  const id=Number(categoryId),clean=String(name||'').trim(),why=String(reason||'').trim(),actor=Number(actorEmployeeId);
  if(!clean)throw fault('CATEGORY_NAME_REQUIRED','Category name is required.',400);
  if(why.length<5)throw fault('CATEGORY_CORRECTION_REASON_REQUIRED','Enter a meaningful reason for this correction.',400);
  if(!Number.isInteger(actor)||actor<=0)throw fault('CATEGORY_CORRECTION_ACTOR_REQUIRED','An authenticated employee is required.',401);
  const tx=await db.transaction('write');let committed=false;
  try{
    const before=await snapshotCategory(id,tx);
    if(expectedName!=null&&String(expectedName)!==String(before.name))throw fault('CATEGORY_CORRECTION_STALE','This category changed while you were reviewing it. Refresh and try again.',409);
    const {rows:[dupe]}=await tx.execute({sql:'SELECT id FROM categories WHERE id<>? AND lower(trim(name))=lower(trim(?)) LIMIT 1',args:[id,clean]});
    if(dupe)throw fault('CATEGORY_NAME_EXISTS','A category with this name already exists. Use duplicate-category consolidation instead.',409);
    const after={...before,name:clean,description:String(description||'').trim()||null};
    if(before.name===after.name&&before.description===after.description){await tx.rollback();return{changed:false,category:before};}
    await tx.execute({sql:'UPDATE categories SET name=?,description=? WHERE id=?',args:[after.name,after.description,id]});
    await tx.execute({sql:'INSERT INTO catalog_category_correction_events(category_id,action,old_value,new_value,reason,actor_employee_id) VALUES(?,?,?,?,?,?)',args:[id,'details_corrected',JSON.stringify(before),JSON.stringify(after),why,actor]});
    await recordSecurityAudit({actorEmployeeId:actor,action:'catalog_category_corrected',targetType:'category',targetId:String(id),oldValue:before,newValue:after,reason:why,requestId,method,path,control:'catalog_category_correction',executor:tx});
    await tx.commit();committed=true;return{changed:true,category:after};
  }catch(e){if(!committed)try{await tx.rollback();}catch(_){}throw e;}
}
async function reclassifyProducts({sourceCategoryId,targetCategoryId,productIds=[],reason,expectedSourceProductCount,actorEmployeeId,requestId=null,method=null,path=null}={}){
  await ensureSchema();await ensureSecurityAuditTable();
  const why=String(reason||'').trim(),actor=Number(actorEmployeeId);
  if(why.length<5)throw fault('CATEGORY_RECLASSIFICATION_REASON_REQUIRED','Enter a meaningful reason for this reclassification.',400);
  if(!Number.isInteger(actor)||actor<=0)throw fault('CATEGORY_RECLASSIFICATION_ACTOR_REQUIRED','An authenticated employee is required.',401);
  const preview=await previewReclassification({sourceCategoryId,targetCategoryId,productIds});
  if(expectedSourceProductCount!=null&&Number(expectedSourceProductCount)!==Number(preview.source.product_count))throw fault('CATEGORY_RECLASSIFICATION_STALE','The source category changed while you were reviewing it. Refresh and try again.',409);
  if(!preview.products.length)return{changed:false,moved_product_ids:[],source:preview.source,target:preview.target};
  const ids=preview.products.map(p=>p.id),tx=await db.transaction('write');let committed=false;
  try{
    const result=await tx.execute({sql:`UPDATE products SET category_id=? WHERE category_id=? AND id IN (${ids.map(()=>'?').join(',')})`,args:[preview.target.id,preview.source.id,...ids]});
    if(Number(result.rowsAffected||0)!==ids.length)throw fault('CATEGORY_RECLASSIFICATION_STALE','Product assignments changed during reclassification. Refresh and try again.',409);
    const oldValue={source_category_id:preview.source.id,product_ids:ids};
    const newValue={target_category_id:preview.target.id,product_ids:ids};
    await tx.execute({sql:'INSERT INTO catalog_category_correction_events(category_id,action,old_value,new_value,reason,actor_employee_id) VALUES(?,?,?,?,?,?)',args:[preview.source.id,'products_reclassified',JSON.stringify(oldValue),JSON.stringify(newValue),why,actor]});
    await recordSecurityAudit({actorEmployeeId:actor,action:'catalog_products_reclassified',targetType:'category',targetId:String(preview.source.id),oldValue,newValue,reason:why,requestId,method,path,control:'catalog_category_reclassification',executor:tx});
    await tx.commit();committed=true;return{changed:true,moved_product_ids:ids,source:preview.source,target:preview.target};
  }catch(e){if(!committed)try{await tx.rollback();}catch(_){}throw e;}
}
module.exports={ensureSchema,snapshotCategory,previewReclassification,correctCategoryDetails,reclassifyProducts};
