'use strict';
const { db }=require('../database');
const { ensureSecurityAuditTable, recordSecurityAudit }=require('./securityAudit');
const { code:normalizeUomCode }=require('./unit-of-measure');

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
  const items=[...groups.values()].map(group=>{group.issues.sort((a,b)=>(SEVERITY_ORDER[a.severity]??99)-(SEVERITY_ORDER[b.severity]??99)||String(a.code).localeCompare(String(b.code)));return{...group,codes:[...new Set(group.codes)].sort(),titles:group.issues.map(x=>x.title),next_actions:[...new Set(group.issues.map(x=>x.what_to_do_next))]};});
  items.sort((a,b)=>a.rank-b.rank||String(a.key).localeCompare(String(b.key)));
  const by_severity={critical:0,high:0,medium:0,low:0};
  for(const item of items)by_severity[item.severity]=(by_severity[item.severity]||0)+1;
  return{total_records:items.length,by_severity,items};
}
function normalizeProductName(value){return String(value||'').trim().toLowerCase().replace(/\s+/g,' ');}
function normalizeSku(value){return String(value||'').trim().toLowerCase().replace(/[\s._\-/]+/g,'');}
function duplicateCandidateKey(code,productIds=[]){return `${String(code||'')}:${[...new Set(productIds.map(Number).filter(Number.isInteger))].sort((a,b)=>a-b).join(',')}`;}
function duplicateProductIssues(products,reviews=new Map()){
  const issues=[],byName=new Map(),bySku=new Map();
  for(const p of products.filter(x=>Number(x.active))){
    const nameKey=normalizeProductName(p.name);
    if(nameKey){if(!byName.has(nameKey))byName.set(nameKey,[]);byName.get(nameKey).push(p);}
    const skuKey=normalizeSku(p.sku);
    if(skuKey){if(!bySku.has(skuKey))bySku.set(skuKey,[]);bySku.get(skuKey).push(p);}
  }
  for(const group of byName.values())if(group.length>1){
    const ids=group.map(x=>Number(x.id)),candidateKey=duplicateCandidateKey('duplicate_product_name',ids),review=reviews.get(candidateKey);
    if(review?.decision==='not_duplicate')continue;
    const confirmed=review?.decision==='confirmed_duplicate';
    issues.push(issue('duplicate_product_name',confirmed?'high':'medium',confirmed?'Confirmed duplicate products need consolidation':'Possible duplicate products',confirmed?'Staff confirmed these records represent the same catalog item. They still need a controlled consolidation decision; no stock or history has been changed.':'These active products have the same normalized name and may split stock, purchasing or reporting.',{type:'product_group',candidate_key:candidateKey,review_decision:review?.decision||null,review_version:Number(review?.version||0),product_ids:ids,products:group.map(x=>({id:Number(x.id),sku:x.sku,name:x.name}))},confirmed?'Review stock, history and downstream references before using a controlled merge or relink workflow.':'Review the products side by side. Confirm whether they are genuinely separate before using governed catalog maintenance.'));
  }
  for(const group of bySku.values()){
    const distinctSkus=new Set(group.map(x=>String(x.sku||'').trim().toLowerCase()));
    if(group.length>1&&distinctSkus.size>1){
      const ids=group.map(x=>Number(x.id)),candidateKey=duplicateCandidateKey('probable_duplicate_sku',ids),review=reviews.get(candidateKey);
      if(review?.decision==='not_duplicate')continue;
      const confirmed=review?.decision==='confirmed_duplicate';
      issues.push(issue('probable_duplicate_sku',confirmed?'high':'medium',confirmed?'Confirmed duplicate products need consolidation':'Possible duplicate SKUs',confirmed?'Staff confirmed these records represent the same catalog item. They still need a controlled consolidation decision; no stock or history has been changed.':'These active SKU values differ only by common separators or formatting and may refer to the same item.',{type:'product_group',candidate_key:candidateKey,review_decision:review?.decision||null,review_version:Number(review?.version||0),product_ids:ids,products:group.map(x=>({id:Number(x.id),sku:x.sku,name:x.name}))},confirmed?'Review stock, history and downstream references before using a controlled merge or relink workflow.':'Review the products side by side. Confirm whether they are genuinely separate before using governed catalog maintenance.'));
    }
  }
  return issues;
}
async function reviewDuplicateCandidate({candidateKey,decision,reason,actorEmployeeId,expectedVersion=0,requestId=null,method=null,path=null}={}){
  const key=String(candidateKey||'').trim(),next=String(decision||'').trim().toLowerCase(),why=String(reason||'').trim(),actor=Number(actorEmployeeId),expected=Number(expectedVersion);
  if(!/^(duplicate_product_name|probable_duplicate_sku):\d+(,\d+)+$/.test(key))throw err('CATALOG_DUPLICATE_REVIEW_KEY_INVALID','Choose a current duplicate candidate to review.',400);
  if(!['confirmed_duplicate','not_duplicate','needs_more_info'].includes(next))throw err('CATALOG_DUPLICATE_REVIEW_DECISION_INVALID','Choose Confirm same item, Not a duplicate, or Needs more info.',400);
  if(why.length<5)throw err('CATALOG_DUPLICATE_REVIEW_REASON_REQUIRED','Enter a meaningful reason for this duplicate review.',400);
  if(!Number.isInteger(actor)||actor<=0)throw err('CATALOG_DUPLICATE_REVIEW_ACTOR_REQUIRED','An authenticated employee is required.',401);
  if(!Number.isInteger(expected)||expected<0)throw err('CATALOG_DUPLICATE_REVIEW_VERSION_INVALID','Refresh the duplicate candidate and try again.',400);
  const {rows:activeProducts}=await db.execute({sql:'SELECT id,sku,name,active FROM products WHERE active=1 ORDER BY id',args:[]});
  const live=duplicateProductIssues(activeProducts,new Map()).find(x=>x.record?.candidate_key===key);
  if(!live)throw err('CATALOG_DUPLICATE_REVIEW_CANDIDATE_STALE','This duplicate candidate has changed. Refresh Catalog Health before reviewing it.',409);
  await ensureSecurityAuditTable();
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[current]}=await tx.execute({sql:'SELECT * FROM catalog_duplicate_reviews WHERE candidate_key=?',args:[key]});
    if(Number(current?.version||0)!==expected)throw err('CATALOG_DUPLICATE_REVIEW_STALE','Another review changed this candidate. Refresh and try again.',409);
    if(current&&current.decision===next&&current.reason===why){await tx.rollback();return{review:current,changed:false};}
    const newVersion=expected+1;
    if(current){
      const result=await tx.execute({sql:'UPDATE catalog_duplicate_reviews SET decision=?,reason=?,reviewed_by=?,version=?,updated_at=CURRENT_TIMESTAMP WHERE candidate_key=? AND version=?',args:[next,why,actor,newVersion,key,expected]});
      if(Number(result.rowsAffected||0)!==1)throw err('CATALOG_DUPLICATE_REVIEW_STALE','Another review changed this candidate. Refresh and try again.',409);
    }else{
      if(expected!==0)throw err('CATALOG_DUPLICATE_REVIEW_STALE','Another review changed this candidate. Refresh and try again.',409);
      try{await tx.execute({sql:'INSERT INTO catalog_duplicate_reviews(candidate_key,decision,reason,reviewed_by,version) VALUES(?,?,?,?,?)',args:[key,next,why,actor,newVersion]});}
      catch(e){if(/unique|constraint/i.test(String(e.message||'')))throw err('CATALOG_DUPLICATE_REVIEW_STALE','Another review changed this candidate. Refresh and try again.',409);throw e;}
    }
    await tx.execute({sql:'INSERT INTO catalog_duplicate_review_events(candidate_key,from_decision,to_decision,reason,reviewed_by,version) VALUES(?,?,?,?,?,?)',args:[key,current?.decision||null,next,why,actor,newVersion]});
    await recordSecurityAudit({actorEmployeeId:actor,action:'catalog_duplicate_review_changed',targetType:'catalog_duplicate_candidate',targetId:key,oldValue:current?{decision:current.decision,version:Number(current.version)}:null,newValue:{decision:next,version:newVersion},reason:why,requestId,method,path,control:'catalog_duplicate_review',executor:tx});
    const {rows:[review]}=await tx.execute({sql:'SELECT * FROM catalog_duplicate_reviews WHERE candidate_key=?',args:[key]});
    await tx.commit();committed=true;return{review,changed:true};
  }catch(error){if(!committed)try{await tx.rollback();}catch(_){}throw error;}
}
async function planDuplicateConsolidation(candidateKey){
  const key=String(candidateKey||'').trim();
  if(!/^(duplicate_product_name|probable_duplicate_sku):\d+(,\d+)+$/.test(key))throw err('CATALOG_DUPLICATE_REVIEW_KEY_INVALID','Choose a current duplicate candidate.',400);
  const {rows:[review]}=await db.execute({sql:'SELECT candidate_key,decision,version FROM catalog_duplicate_reviews WHERE candidate_key=?',args:[key]});
  if(!review||review.decision!=='confirmed_duplicate')throw err('CATALOG_DUPLICATE_NOT_CONFIRMED','Confirm that these records represent the same item before planning consolidation.',409);
  const {rows:activeProducts}=await db.execute({sql:'SELECT id,sku,name,active FROM products WHERE active=1 ORDER BY id',args:[]});
  const live=duplicateProductIssues(activeProducts,new Map()).find(x=>x.record?.candidate_key===key);
  if(!live)throw err('CATALOG_DUPLICATE_CANDIDATE_STALE','This duplicate candidate has changed. Refresh Catalog Health before planning consolidation.',409);
  const ids=live.record.product_ids.map(Number);
  const plans=[];
  for(const id of ids){
    const cleanup=await inspectProductCleanup(id);
    const {rows:[product]}=await db.execute({sql:`SELECT id,sku,barcode,name,price,cost,unit,category_id,brand_id,supplier_id,COALESCE(catalog_status,'active') catalog_status,online_available,image_path FROM products WHERE id=?`,args:[id]});
    plans.push({product,stock:{global_stock_qty:Number(cleanup.product.global_stock_qty||0),branch_stock_qty:Number(cleanup.stock.branch_stock_qty||0),branches:cleanup.stock.branches},history:{reference_count:Number(cleanup.historical.reference_count||0)},completeness:['sku','barcode','unit','category_id','brand_id','supplier_id'].reduce((n,f)=>n+(product?.[f]!=null&&String(product[f]).trim()!==''?1:0),0)});
  }
  const distinct=field=>[...new Set(plans.map(x=>x.product?.[field]).filter(v=>v!=null&&String(v)!=='').map(v=>String(v)))];
  const fields=[['sku','SKU'],['barcode','Barcode'],['unit','Unit of measure'],['category_id','Category'],['brand_id','Brand'],['supplier_id','Supplier'],['catalog_status','Lifecycle'],['price','Selling price']];
  const conflicts=fields.map(([field,label])=>({field,label,values:distinct(field)})).filter(x=>x.values.length>1);
  const withStock=plans.filter(x=>Math.abs(x.stock.global_stock_qty)>1e-9||Math.abs(x.stock.branch_stock_qty)>1e-9);
  const ranked=[...plans].sort((a,b)=>b.history.reference_count-a.history.reference_count||b.completeness-a.completeness||Number(a.product.id)-Number(b.product.id));
  const suggested=ranked[0]||null;
  const blockers=[];
  if(withStock.length>1)blockers.push('More than one duplicate record still holds stock. Stock must be reconciled through controlled inventory workflows before consolidation.');
  if(conflicts.length)blockers.push('The duplicate records contain conflicting master data that staff must resolve before consolidation.');
  return{candidate_key:key,review_version:Number(review.version||0),records:plans,conflicts,blockers,suggested_primary:suggested?{product_id:Number(suggested.product.id),reason:'This record has the most historical references; ties use master-data completeness, then the lowest product ID.'}:null,read_only:true};
}
function dependencyDomain(table){
  const t=String(table||'').toLowerCase();
  if(/transaction|return|refund|sale|held_sale/.test(t))return'Sales & returns';
  if(/purchase|supplier|procurement|receipt/.test(t))return'Purchasing';
  if(/inventory|stock|transfer|cycle|bin|reservation|traceability|lot|serial/.test(t))return'Inventory & transfers';
  if(/quote|quotation/.test(t))return'Quotes';
  if(/work_order|repair|service/.test(t))return'Service & repairs';
  if(/rental|fleet/.test(t))return'Rentals';
  if(/commerce|website|sync|integration|ecommerce/.test(t))return'Website/integrations';
  return'Other history';
}
async function inspectDuplicateConsolidation(candidateKey){
  const key=String(candidateKey||'').trim();
  if(!/^(duplicate_product_name|probable_duplicate_sku):\d+(,\d+)+$/.test(key))throw err('CATALOG_CONSOLIDATION_KEY_INVALID','Choose a confirmed duplicate candidate.',400);
  const {rows:[review]}=await db.execute({sql:'SELECT candidate_key,decision,version,reason,updated_at FROM catalog_duplicate_reviews WHERE candidate_key=?',args:[key]});
  if(!review||review.decision!=='confirmed_duplicate')throw err('CATALOG_CONSOLIDATION_NOT_CONFIRMED','Confirm that these records are the same item before reviewing consolidation impact.',409);
  const {rows:activeProducts}=await db.execute({sql:'SELECT id,sku,name,active FROM products WHERE active=1 ORDER BY id',args:[]});
  const live=duplicateProductIssues(activeProducts,new Map()).find(x=>x.record?.candidate_key===key);
  if(!live)throw err('CATALOG_CONSOLIDATION_CANDIDATE_STALE','This duplicate group has changed. Refresh Catalog Health and review the current group.',409);
  const ids=live.record.product_ids.map(Number),marks=ids.map(()=>'?').join(',');
  const {rows:[uomTable]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name='product_uom_profiles'",args:[]});
  const uomSql=uomTable?"(SELECT pup.base_uom FROM product_uom_profiles pup WHERE pup.product_id=p.id)":"NULL";
  const {rows:productRows}=await db.execute({sql:`SELECT p.id,p.sku,p.barcode,p.name,p.price,p.cost,p.unit,p.active,COALESCE(p.catalog_status,'active') catalog_status,
    p.category_id,c.name category_name,p.brand_id,b.name brand_name,p.supplier_id,s.name supplier_name,p.stock_qty global_stock_qty,
    ${uomSql} explicit_base_uom
    FROM products p
    LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN brands b ON b.id=p.brand_id
    LEFT JOIN suppliers s ON s.id=p.supplier_id
    WHERE p.id IN (${marks}) ORDER BY p.id`,args:ids});
  if(productRows.length!==ids.length)throw err('CATALOG_CONSOLIDATION_CANDIDATE_STALE','One of these product records is no longer available. Refresh Catalog Health.',409);
  const tables=await referenceTables(),products=[];
  for(const row of productRows){
    const {rows:branches}=await db.execute({sql:'SELECT branch_id,stock_qty,min_stock FROM branch_inventory WHERE product_id=? ORDER BY branch_id',args:[row.id]});
    const branch_stock=branches.map(x=>({branch_id:Number(x.branch_id),stock_qty:Number(x.stock_qty||0),min_stock:Number(x.min_stock||0)}));
    const dependency_domains={'Sales & returns':0,'Purchasing':0,'Inventory & transfers':0,'Quotes':0,'Service & repairs':0,'Rentals':0,'Website/integrations':0,'Other history':0};
    for(const table of tables){
      if(table==='branch_inventory')continue;
      const {rows:[countRow]}=await db.execute({sql:`SELECT COUNT(*) c FROM ${table} WHERE product_id=?`,args:[row.id]});
      const count=Number(countRow?.c||0);if(count)dependency_domains[dependencyDomain(table)]+=count;
    }
    const linked_record_count=Object.values(dependency_domains).reduce((a,b)=>a+Number(b||0),0);
    products.push({...row,active:Boolean(row.active),global_stock_qty:Number(row.global_stock_qty||0),branch_stock,dependency_domains,linked_record_count});
  }
  const blockers=[];
  if(products.some(p=>Math.abs(p.global_stock_qty)>1e-9||p.branch_stock.some(b=>Math.abs(b.stock_qty)>1e-9)))blockers.push({code:'physical_stock_present',message:'Physical stock exists on at least one duplicate record. Stock must be resolved through controlled inventory workflows before consolidation.'});
  const nonEmpty=v=>String(v||'').trim();
  const distinct=values=>[...new Set(values.map(nonEmpty).filter(Boolean))];
  if(distinct(products.map(p=>p.barcode)).length>1)blockers.push({code:'barcode_conflict',message:'The duplicate records have different barcodes. Confirm the correct identity before consolidation.'});
  if(distinct(products.map(p=>p.explicit_base_uom)).length>1)blockers.push({code:'uom_conflict',message:'The duplicate records have conflicting explicit base units. Resolve unit-of-measure evidence before consolidation.'});
  if(new Set(products.map(p=>Number(p.price||0).toFixed(6))).size>1)blockers.push({code:'price_conflict',message:'The duplicate records have different selling prices. Review which commercial values should survive.'});
  if(new Set(products.map(p=>Number(p.cost||0).toFixed(6))).size>1)blockers.push({code:'cost_conflict',message:'The duplicate records have different catalog costs. Do not overwrite historical cost evidence during consolidation.'});
  if(new Set(products.map(p=>Boolean(p.active))).size>1)blockers.push({code:'active_state_conflict',message:'The duplicate records do not share the same active/retired state.'});
  if(products.filter(p=>p.linked_record_count>0).length>1)blockers.push({code:'history_spread_across_records',message:'Business history is linked to more than one duplicate record. Any future consolidation must preserve and reconcile those references.'});
  return{candidate_key:key,review:{decision:review.decision,version:Number(review.version),reason:review.reason,updated_at:review.updated_at},products,blockers,survivor_selected:false,read_only:true};
}
async function consolidateDuplicateProducts({candidateKey,survivorProductId,reason,confirmation,expectedReviewVersion,actorEmployeeId,requestId=null,method=null,path=null}={}){
  const key=String(candidateKey||'').trim(),survivor=Number(survivorProductId),why=String(reason||'').trim(),actor=Number(actorEmployeeId),expected=Number(expectedReviewVersion);
  if(String(confirmation||'').trim()!=='CONSOLIDATE')throw err('CATALOG_CONSOLIDATION_CONFIRMATION_REQUIRED','Type CONSOLIDATE to confirm this irreversible catalog consolidation.',400);
  if(why.length<5)throw err('CATALOG_CONSOLIDATION_REASON_REQUIRED','Enter a meaningful reason for this consolidation.',400);
  if(!Number.isInteger(actor)||actor<=0)throw err('CATALOG_CONSOLIDATION_ACTOR_REQUIRED','An authenticated employee is required.',401);
  if(!Number.isInteger(expected)||expected<=0)throw err('CATALOG_CONSOLIDATION_REVIEW_STALE','Refresh the duplicate review before consolidating.',409);
  if(!/^(duplicate_product_name|probable_duplicate_sku):\d+(,\d+)+$/.test(key))throw err('CATALOG_CONSOLIDATION_KEY_INVALID','Choose a confirmed duplicate candidate.',400);

  const {rows:existing}=await db.execute({sql:'SELECT * FROM catalog_product_consolidations WHERE candidate_key=? ORDER BY duplicate_product_id',args:[key]});
  if(existing.length){
    if(existing.every(x=>Number(x.survivor_product_id)===survivor))return{changed:false,survivor_product_id:survivor,retired_product_ids:existing.map(x=>Number(x.duplicate_product_id)),mappings:existing};
    throw err('CATALOG_CONSOLIDATION_ALREADY_COMPLETED','This duplicate group was already consolidated to a different surviving product.',409);
  }

  const {rows:[review]}=await db.execute({sql:'SELECT candidate_key,decision,version FROM catalog_duplicate_reviews WHERE candidate_key=?',args:[key]});
  if(!review||review.decision!=='confirmed_duplicate')throw err('CATALOG_CONSOLIDATION_NOT_CONFIRMED','Confirm that these records are the same item before consolidating them.',409);
  if(Number(review.version)!==expected)throw err('CATALOG_CONSOLIDATION_REVIEW_STALE','The duplicate review changed. Refresh and review the group again.',409);
  const {rows:activeProducts}=await db.execute({sql:'SELECT id,sku,name,active FROM products WHERE active=1 ORDER BY id',args:[]});
  const live=duplicateProductIssues(activeProducts,new Map()).find(x=>x.record?.candidate_key===key);
  if(!live)throw err('CATALOG_CONSOLIDATION_CANDIDATE_STALE','This duplicate group changed. Refresh Catalog Health before consolidating.',409);
  const ids=live.record.product_ids.map(Number);
  if(!ids.includes(survivor))throw err('CATALOG_CONSOLIDATION_SURVIVOR_INVALID','Choose the surviving product from this exact duplicate group.',400);
  const duplicates=ids.filter(id=>id!==survivor);
  const marks=ids.map(()=>'?').join(',');
  const {rows:records}=await db.execute({sql:`SELECT id,sku,barcode,model_number,name,unit,is_service,is_rental,is_non_inventory,active FROM products WHERE id IN (${marks}) ORDER BY id`,args:ids});
  if(records.length!==ids.length)throw err('CATALOG_CONSOLIDATION_CANDIDATE_STALE','One of these product records is no longer available.',409);
  const typeKeys=new Set(records.map(x=>`${Number(x.is_service||0)}:${Number(x.is_rental||0)}:${Number(x.is_non_inventory||0)}`));
  if(typeKeys.size>1)throw err('CATALOG_CONSOLIDATION_TYPE_CONFLICT','These records do not have the same product type. Resolve that difference before consolidating.',409);
  const {rows:[uomTable]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name='product_uom_profiles'",args:[]});
  if(uomTable){
    const {rows:uoms}=await db.execute({sql:`SELECT product_id,base_uom FROM product_uom_profiles WHERE product_id IN (${marks})`,args:ids});
    const values=[...new Set(uoms.map(x=>String(x.base_uom||'').trim().toLowerCase()).filter(Boolean))];
    if(values.length>1)throw err('CATALOG_CONSOLIDATION_UOM_CONFLICT','These records have conflicting base units. Resolve the unit-of-measure difference before consolidating.',409);
  }
  for(const id of duplicates){
    const {rows:[p]}=await db.execute({sql:'SELECT stock_qty FROM products WHERE id=?',args:[id]});
    const {rows:[b]}=await db.execute({sql:'SELECT COUNT(*) c FROM branch_inventory WHERE product_id=? AND ABS(COALESCE(stock_qty,0))>0.000000001',args:[id]});
    if(Math.abs(Number(p?.stock_qty||0))>1e-9||Number(b?.c||0)>0)throw err('CATALOG_CONSOLIDATION_STOCK_PRESENT','Move, sell, return, adjust, or write off stock from every retiring duplicate before consolidating.',409);
  }

  await ensureSecurityAuditTable();
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[fresh]}=await tx.execute({sql:'SELECT decision,version FROM catalog_duplicate_reviews WHERE candidate_key=?',args:[key]});
    if(!fresh||fresh.decision!=='confirmed_duplicate'||Number(fresh.version)!==expected)throw err('CATALOG_CONSOLIDATION_REVIEW_STALE','The duplicate review changed while consolidation was being prepared.',409);
    const {rows:already}=await tx.execute({sql:'SELECT * FROM catalog_product_consolidations WHERE candidate_key=?',args:[key]});
    if(already.length){
      if(already.every(x=>Number(x.survivor_product_id)===survivor)){await tx.rollback();return{changed:false,survivor_product_id:survivor,retired_product_ids:already.map(x=>Number(x.duplicate_product_id)),mappings:already};}
      throw err('CATALOG_CONSOLIDATION_ALREADY_COMPLETED','This duplicate group was already consolidated.',409);
    }
    for(const id of duplicates){
      const result=await tx.execute({sql:`UPDATE products SET active=0 WHERE id=? AND active=1 AND ABS(COALESCE(stock_qty,0))<=0.000000001
        AND NOT EXISTS(SELECT 1 FROM branch_inventory bi WHERE bi.product_id=products.id AND ABS(COALESCE(bi.stock_qty,0))>0.000000001)`,args:[id]});
      if(Number(result.rowsAffected||0)!==1)throw err('CATALOG_CONSOLIDATION_STOCK_PRESENT','Stock or product state changed while consolidating. Refresh and try again.',409);
      await tx.execute({sql:'INSERT INTO catalog_product_consolidations(candidate_key,survivor_product_id,duplicate_product_id,review_version,reason,consolidated_by) VALUES(?,?,?,?,?,?)',args:[key,survivor,id,expected,why,actor]});
      const source=records.find(x=>Number(x.id)===id);
      for(const alias of [source?.sku,source?.barcode,source?.model_number,source?.name].map(v=>String(v||'').trim()).filter(Boolean)){
        const normalized=normalizeProductName(alias);
        await tx.execute({sql:`INSERT INTO lookup_aliases(entity_type,entity_id,alias,alias_normalized,status,evidence_source,created_by,reviewed_by,reviewed_at)
          VALUES('product',?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(entity_type,entity_id,alias_normalized) DO UPDATE SET status='approved',evidence_source='catalog_consolidation',reviewed_by=excluded.reviewed_by,reviewed_at=CURRENT_TIMESTAMP`,
          args:[survivor,alias,normalized,'approved','catalog_consolidation',actor,actor]});
      }
    }
    await recordSecurityAudit({actorEmployeeId:actor,action:'catalog_duplicate_consolidated',targetType:'catalog_duplicate_candidate',targetId:key,oldValue:{product_ids:ids,review_version:expected},newValue:{survivor_product_id:survivor,retired_product_ids:duplicates},reason:why,requestId,method,path,control:'catalog_canonical_consolidation',executor:tx});
    const {rows:mappings}=await tx.execute({sql:'SELECT * FROM catalog_product_consolidations WHERE candidate_key=? ORDER BY duplicate_product_id',args:[key]});
    await tx.commit();committed=true;
    return{changed:true,survivor_product_id:survivor,retired_product_ids:duplicates,mappings};
  }catch(error){if(!committed)try{await tx.rollback();}catch(_){}throw error;}
}
async function catalogHealth({limit=100}={}){
  const max=Math.min(200,Math.max(1,Number(limit)||100));
  const issues=[];
  const {rows:reviewRows}=await db.execute({sql:'SELECT candidate_key,decision,reason,reviewed_by,version,updated_at FROM catalog_duplicate_reviews',args:[]});
  const duplicateReviews=new Map(reviewRows.map(x=>[String(x.candidate_key),x]));
  const {rows:[uomTable]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name='product_uom_profiles'",args:[]});
  const explicitBaseUomSql=uomTable?"(SELECT pup.base_uom FROM product_uom_profiles pup WHERE pup.product_id=p.id)":"NULL";
  const {rows:products}=await db.execute({sql:`SELECT p.id,p.sku,p.barcode,p.name,p.price,p.active,p.stock_qty,p.category_id,p.brand_id,p.supplier_id,p.online_available,p.image_path,p.is_service,p.is_rental,p.is_non_inventory,p.unit,p.created_at,COALESCE(p.catalog_status,'active') catalog_status,
    ${explicitBaseUomSql} explicit_base_uom,
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
    const rawName=String(p.name||''),trimmedName=rawName.trim(),rawSku=String(p.sku||'');
    if(Number(p.active)&&(rawName!==trimmedName||/\s{2,}/.test(trimmedName)))issues.push(issue('inconsistent_product_name','low','Product name needs cleanup','Extra leading, trailing or repeated spaces make search results, labels and reports look inconsistent.',record,'Open the product and clean the spacing in its name. Do not change the wording unless staff confirm it is incorrect.'));
    if(Number(p.active)&&rawSku&&rawSku!==rawSku.trim())issues.push(issue('sku_whitespace','medium','SKU contains extra spaces','Leading or trailing spaces can make exact SKU lookup and integrations unreliable even when the value looks correct on screen.',record,'Open the product and remove only the extra spaces around the SKU.'));
    if(physical&&p.explicit_base_uom&&normalizeUomCode(p.unit)!==normalizeUomCode(p.explicit_base_uom))issues.push(issue('uom_profile_mismatch','high','Product unit conflicts with its UOM profile','The product record and its explicit unit-of-measure profile disagree about the base unit, which can create quantity or pricing mistakes.',record,'Review the product UOM setup and make the product unit and explicit base unit agree before further stock or purchasing changes.'));
    if(physical&&(globalQty>0||branchQty>0)&&(!Number.isFinite(Number(p.price))||Number(p.price)<=0))issues.push(issue('stock_without_sell_price','high','Stocked product has no valid selling price','Staff can see physical stock for an active item that cannot be sold at a valid positive catalog price.',record,'Confirm the correct selling price and update the product before normal sale.'));
    if(p.last_sale_at&&(!String(p.sku||'').trim()||!p.category_id||(physical&&!String(p.unit||'').trim())))issues.push(issue('sold_with_broken_master_data','high','Sold product still has broken master data','This product already appears in completed sales but is missing critical catalog information, which weakens reporting, lookup and future transactions.',record,'Repair the missing SKU, category or unit while preserving the historical sales record.'));
    if(Number(p.active)&&p.catalog_status==='obsolete'&&(globalQty!==0||branchQty!==0))issues.push(issue('obsolete_with_stock','high','Obsolete product still has stock','Obsolete stock still needs an explicit business decision; classification alone does not move or remove inventory.',record,'Review remaining stock and use a controlled sale, transfer, return, adjustment or write-off workflow.'));
    if(Number(p.active)&&p.catalog_status==='discontinued'&&globalQty===0&&branchQty===0)issues.push(issue('discontinued_zero_stock','low','Discontinued product has no stock','A discontinued zero-stock item may be ready for retirement if there is no business reason to keep it active.',record,'Review history and website needs, then retire it through the governed product retirement action if appropriate.'));
    if(physical&&p.catalog_status==='active'){
      const cutoff=Date.now()-365*86400000,created=Date.parse(p.created_at||'');
      const activity=[p.last_sale_at,p.last_purchase_at,p.last_movement_at].map(x=>Date.parse(x||'')).filter(Number.isFinite);
      const last=activity.length?Math.max(...activity):0;
      if(Number.isFinite(created)&&created<cutoff&&last<cutoff)issues.push(issue('stale_catalog_activity','low','Product has had no recent activity','No completed sale, purchase-order activity, or stock movement was found in the last 365 days. This is advisory only and does not automatically make it obsolete or retire it.',record,'Review demand, stock, supplier status and business use before changing its lifecycle.'));
    }
  }
  issues.push(...duplicateProductIssues(products,duplicateReviews));
  const {rows:dupes}=await db.execute({sql:`SELECT lower(trim(name)) normalized_name,COUNT(*) duplicate_count,group_concat(id) ids,MIN(name) name
    FROM categories GROUP BY lower(trim(name)) HAVING COUNT(*)>1 ORDER BY normalized_name LIMIT ?`,args:[max]});
  for(const c of dupes)issues.push(issue('duplicate_category_name','medium','Duplicate category names','Duplicate categories split reporting and make product selection harder.',{type:'category',name:c.name,ids:String(c.ids).split(',').map(Number)},'Merge or rename the duplicate categories, then reassign affected products.'));
  const counts={};for(const i of issues)counts[i.code]=(counts[i.code]||0)+1;
  const queue=buildRemediationQueue(issues);
  return{summary:{needs_attention:issues.length,records_needing_attention:queue.total_records,by_issue:counts,by_severity:queue.by_severity},remediation_queue:queue.items,issues:issues.slice(0,max),generated_at:new Date().toISOString()};
}
module.exports={inspectProductCleanup,archiveProduct,setProductLifecycle,reviewDuplicateCandidate,planDuplicateConsolidation,inspectDuplicateConsolidation,consolidateDuplicateProducts,catalogHealth,buildRemediationQueue,recordKey,duplicateCandidateKey,duplicateProductIssues,normalizeProductName,normalizeSku};
