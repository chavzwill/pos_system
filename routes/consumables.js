'use strict';
const express=require('express');
const crypto=require('node:crypto');
const {db}=require('../database');
const {requireAuth,requirePermission,can}=require('../lib/permissions');
const {ensureConsumablesSchema}=require('../lib/consumables-schema');
const router=express.Router();
const sql=(sql,args=[])=>({sql,args});
function fail(code,message,status=400){const e=new Error(message);e.status=status;e.code=code;throw e;}
function id(value,field){const n=Number(value);if(!Number.isSafeInteger(n)||n<1)fail('INVALID_ID',field+' must be a positive record ID');return n;}
function text(value,field,max=500,required=true){
 const s=String(value??'').trim();
 if((required&&!s)||s.length>max)fail('INVALID_TEXT',field+' is required and may contain at most '+max+' characters');
 return s||null;
}
function whole(value,field){const n=Number(value);if(!Number.isSafeInteger(n)||n<=0||n>1000000)fail('INVALID_QUANTITY',field+' must be a positive whole quantity of at most 1,000,000');return n;}
function cents(value){
 const s=String(value??'').trim();
 if(!/^\d+(?:\.\d{1,2})?$/.test(s))fail('INVALID_COST','Unit cost must be a positive money amount with at most two decimal places');
 const [major,minor='']=s.split('.');
 const n=Number(major)*100+Number(minor.padEnd(2,'0'));
 if(!Number.isSafeInteger(n)||n>100000000000)fail('INVALID_COST','Unit cost exceeds safe limits');
 return n;
}
function requireConsumableRead(req,res,next){return can(req.employee?.permissions,'purchasing')||can(req.employee?.permissions,'reports_financial')||can(req.employee?.permissions,'inventory_adjust')?next():res.status(403).json({error:'Purchasing, Finance or consumable issuing permission required'});}
function actor(req){return Number(req.employee?.id)||null;}
function canCrossBranch(req){return can(req.employee?.permissions,'branches')||can(req.employee?.permissions,'security_manage');}
function assertBranch(req,branch){
 const assigned=req.employee?.default_branch_id;
 if(!canCrossBranch(req)&&(assigned==null||!Number.isSafeInteger(Number(assigned))||Number(assigned)<1||Number(assigned)!==Number(branch)))fail('BRANCH_FORBIDDEN','Use your assigned branch or request cross-branch authority',403);
}
function branchFilter(req,col='po.branch_id'){
 const assigned=req.employee?.default_branch_id;
 if(!canCrossBranch(req))assertBranch(req,assigned);
 return assigned!=null&&!canCrossBranch(req)?{clause:' AND '+col+'=?',args:[Number(assigned)]}:{clause:'',args:[]};
}
async function exists(tx,table,identifier,{active=true}={}){
 const allow=new Set(['branches','suppliers','consumable_catalog','departments','products']);
 if(!allow.has(table))fail('INVALID_LOOKUP','Unsupported reference');
 const {rows:[item]}=await tx.execute(sql('SELECT * FROM '+table+' WHERE id=?',[identifier]));
 if(!item||active&&item.active===0)fail('REFERENCE_UNAVAILABLE','Selected '+table+' record was not found or is inactive',409);
 return item;
}
async function target(tx,{allocation_type,allocation_id,unit_reference},branchId){
 const kind=String(allocation_type||'branch');
 if(!['branch','department','rental'].includes(kind))fail('INVALID_ALLOCATION','Allocate to a branch, department or rental machine');
 const destination=kind==='branch'?branchId:id(allocation_id,'Allocation');
 if(kind==='branch'){
  if(allocation_id&&Number(allocation_id)!==Number(branchId))fail('CROSS_BRANCH_ALLOCATION','Use an issue transfer workflow before allocating stock to a different branch',409);
  return{kind,identifier:branchId,unitRef:null};
 }
 if(kind==='department')await exists(tx,'departments',destination);
 if(kind==='rental'){
  const equipment=await exists(tx,'products',destination);
  if(!equipment.is_rental)fail('NOT_RENTAL_EQUIPMENT','Choose a rental equipment product',409);
 }
 const unitRef=kind==='rental'?text(unit_reference,'Rental unit / equipment identifier',120):null;
 return{kind,identifier:destination,unitRef};
}
function sourceKind(req){return String(req.headers['idempotency-key']||'').trim();}
function safeInteger(value,field){
 const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('UNSAFE_CONSUMABLE_VALUE',field+' exceeds safe whole-number limits',409);return n;
}
function safeAdd(a,b,field){return safeInteger(BigInt(safeInteger(a,field))+BigInt(safeInteger(b,field)),field);}
function safeProduct(a,b,field){return safeInteger(BigInt(safeInteger(a,field))*BigInt(safeInteger(b,field)),field);}
function weightedCost(value,quantity,totalQuantity){
 const v=BigInt(safeInteger(value,'Stock value')),q=BigInt(safeInteger(quantity,'Issue quantity')),total=BigInt(safeInteger(totalQuantity,'Stock quantity'));
 if(total===0n||q>total)fail('INSUFFICIENT_CONSUMABLES','Available consumables cannot cover this issue',409);
 return safeInteger((v*q+total/2n)/total,'Issue value');
}
async function authorizeOperation(req,tx,operation){
 if(operation==='create-po'||operation==='issue-consumables')assertBranch(req,id(req.body?.branch_id,'Branch'));
 else if(/^(submit|approve|receive)-po:/.test(operation)){
  const oid=id(req.params.id,'PO');
  const {rows:[po]}=await tx.execute(sql('SELECT * FROM consumable_purchase_orders WHERE id=?',[oid]));
  if(!po)fail('PO_NOT_FOUND','Consumables PO not found',404);
  assertBranch(req,po.branch_id);
  if(operation.startsWith('approve-po:')&&po.requested_by&&Number(po.requested_by)===actor(req))fail('SELF_APPROVAL','Another authorized employee must approve this purchase order',403);
 }
}
async function mutate(req,res,operation,fn){
 try{
  const key=sourceKind(req);
  if(key.length<12||key.length>160||!/^[\w:.-]+$/.test(key))return res.status(400).json({error:'A stable Idempotency-Key (12–160 safe characters) is required',code:'IDEMPOTENCY_KEY_REQUIRED'});
  const scoped=operation+':'+key;
  const fingerprint=crypto.createHash('sha256').update(operation+'\n'+actor(req)+'\n'+JSON.stringify(req.body||{})).digest('hex');
  const tx=await db.transaction('write');let committed=false;
  try{
   await authorizeOperation(req,tx,operation);
   const prior=(await tx.execute(sql('SELECT fingerprint,response_json FROM consumable_operations WHERE idempotency_key=?',[scoped]))).rows[0];
   if(prior){
    if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','This request key was already used with different content',409);
    await tx.commit();committed=true;
    return res.json({...JSON.parse(prior.response_json),replayed:true});
   }
   const result=await fn(tx);
   await tx.execute(sql('INSERT INTO consumable_operations(idempotency_key,fingerprint,response_json) VALUES(?,?,?)',[scoped,fingerprint,JSON.stringify(result)]));
   await tx.commit();committed=true;
   return res.status(operation.startsWith('create')?201:200).json(result);
  }catch(e){if(!committed)await tx.rollback().catch(()=>{});throw e;}
 }catch(e){
  const constraint=/UNIQUE|SQLITE_CONSTRAINT/i.test(String(e?.message||''));
  const status=e.status|| (constraint?409:500);
  if(status>=500)console.error('consumables_mutation_error',{code:e?.code||'unknown'});
  return res.status(status).json({error:status===500?'Unable to finish this consumables operation right now.':e.message,code:e.code||(constraint?'CONFLICT':'CONSUMABLE_OPERATION_FAILED')});
 }
}
router.use(requireAuth,(req,res,next)=>req.apiKey?res.status(403).json({error:'Consumable records require an authenticated staff session',code:'CONSUMABLE_STAFF_ONLY'}):next());
router.use((req,res,next)=>{try{if(!canCrossBranch(req))assertBranch(req,req.employee?.default_branch_id);next();}catch(e){res.status(e.status||403).json({error:e.message,code:e.code});}});
router.use(async(req,res,next)=>{try{await ensureConsumablesSchema();next();}catch(e){console.error('consumable_schema_error',{code:e?.code||'unknown'});res.status(503).json({error:'Consumable records are temporarily unavailable',code:'CONSUMABLE_SCHEMA_UNAVAILABLE'});}});
router.get('/lookups',requireConsumableRead,async(req,res)=>{
 try{
  const b=branchFilter(req,'id');
  const [suppliers,branches,departments,equipment]=await Promise.all([
   db.execute(sql('SELECT id,name FROM suppliers WHERE active=1 ORDER BY name LIMIT 300')),
   db.execute(sql('SELECT id,name FROM branches WHERE active=1'+b.clause+' ORDER BY name',b.args)),
   db.execute(sql('SELECT id,name FROM departments WHERE active=1 ORDER BY name LIMIT 300')),
   db.execute(sql('SELECT id,name,sku FROM products WHERE active=1 AND is_rental=1 ORDER BY name LIMIT 1000'))
  ]);
  res.json({suppliers:suppliers.rows,branches:branches.rows,departments:departments.rows,rental_equipment:equipment.rows});
 }catch(e){res.status(500).json({error:'Unable to load consumables lookups'});}
});
router.get('/catalog',requireConsumableRead,async(req,res)=>{
 try{const r=await db.execute(sql('SELECT * FROM consumable_catalog ORDER BY active DESC,name,id'));res.json(r.rows);}
 catch(e){res.status(500).json({error:'Unable to load consumables catalog'});}
});
router.post('/catalog',requirePermission('purchasing_create'),(req,res)=>mutate(req,res,'create-catalog',async(tx)=>{
 const sku=text(req.body?.sku,'SKU',80).toUpperCase(),name=text(req.body?.name,'Name',160);
 const uom=text(req.body?.uom||'each','Unit',32);
 const r=await tx.execute(sql('INSERT INTO consumable_catalog(sku,name,uom) VALUES(?,?,?)',[sku,name,uom]));
 return{id:Number(r.lastInsertRowid),sku,name,uom,active:1};
}));
router.get('/orders',requireConsumableRead,async(req,res)=>{
 try{const b=branchFilter(req);const r=await db.execute(sql('SELECT po.*,s.name supplier_name,b.name branch_name FROM consumable_purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=po.branch_id WHERE 1=1'+b.clause+' ORDER BY po.id DESC LIMIT 250',b.args));res.json(r.rows);}
 catch(e){res.status(500).json({error:'Unable to load consumables orders'});}
});
router.get('/orders/:id',requireConsumableRead,async(req,res)=>{
 try{
  const oid=id(req.params.id,'Order');
  const b=branchFilter(req);
  const {rows:[po]}=await db.execute(sql('SELECT po.*,s.name supplier_name,b.name branch_name FROM consumable_purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=po.branch_id WHERE po.id=?'+b.clause,[oid,...b.args]));
  if(!po)return res.status(404).json({error:'Purchase order not found'});
  const {rows:lines}=await db.execute(sql('SELECT l.*,c.sku,c.name,c.uom FROM consumable_po_lines l JOIN consumable_catalog c ON c.id=l.consumable_id WHERE l.po_id=? ORDER BY l.id',[oid]));
  const {rows:events}=await db.execute(sql('SELECT event_type,actor_employee_id,details,created_at FROM consumable_order_events WHERE po_id=? ORDER BY id DESC',[oid]));
  res.json({...po,items:lines,events});
 }catch(e){res.status(400).json({error:e.message});}
});
router.post('/orders',requirePermission('purchasing_create'),(req,res)=>mutate(req,res,'create-po',async(tx)=>{
 const body=req.body||{};
 const supplierId=id(body.supplier_id,'Supplier'),branchId=id(body.branch_id,'Branch');
 assertBranch(req,branchId);
 await exists(tx,'suppliers',supplierId);await exists(tx,'branches',branchId);
 const allocation=await target(tx,body,branchId);
 const reason=text(body.reason,'Reason for purchase',600),requestedFor=text(body.requested_for,'Requested for',250);
 const notes=text(body.notes,'Notes',2500,false);
 const expected=body.expected_date?text(body.expected_date,'Expected delivery date',10):null;
 if(expected&&!/^\d{4}-\d{2}-\d{2}$/.test(expected))fail('INVALID_DATE','Use an ISO expected date');
 const items=body.items;
 if(!Array.isArray(items)||!items.length||items.length>100)fail('INVALID_LINES','Provide 1–100 consumable lines');
 const seen=new Set(),lines=[];let sum=0;
 for(const row of items){
  const catalogId=id(row.consumable_id,'Consumable item');
  if(seen.has(catalogId))fail('DUPLICATE_LINE','Combine repeated consumables into one PO line');
  seen.add(catalogId);await exists(tx,'consumable_catalog',catalogId);
  const quantity=whole(row.quantity,'Order quantity'),unitCost=cents(row.unit_cost);
  const lineCost=safeProduct(quantity,unitCost,'PO line value');sum=safeAdd(sum,lineCost,'PO value');
  if(!Number.isSafeInteger(sum)||sum>10000000000000)fail('PO_VALUE_LIMIT','Purchase order value exceeds safe limits');
  lines.push({catalogId,quantity,unitCost});
 }
 const temporary='CPO-PENDING-'+crypto.randomUUID();
 const r=await tx.execute(sql('INSERT INTO consumable_purchase_orders(po_number,supplier_id,branch_id,requested_by,status,reason,requested_for,allocation_type,allocation_id,unit_reference,notes,expected_date,total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[temporary,supplierId,branchId,actor(req),'draft',reason,requestedFor,allocation.kind,allocation.identifier,allocation.unitRef,notes,expected,sum]));
 const poId=Number(r.lastInsertRowid),number='CPO-'+String(poId).padStart(6,'0');
 await tx.execute(sql('UPDATE consumable_purchase_orders SET po_number=? WHERE id=?',[number,poId]));
 for(const line of lines)await tx.execute(sql('INSERT INTO consumable_po_lines(po_id,consumable_id,quantity_ordered,unit_cost_cents) VALUES(?,?,?,?)',[poId,line.catalogId,line.quantity,line.unitCost]));
 await tx.execute(sql("INSERT INTO consumable_order_events(po_id,event_type,actor_employee_id,details) VALUES(?,'created',?,?)",[poId,actor(req),reason]));
 return{id:poId,po_number:number,status:'draft',total_cents:sum};
}));
router.post('/orders/:id/submit',requirePermission('purchasing_create'),(req,res)=>mutate(req,res,'submit-po:'+req.params.id,async(tx)=>{
 const oid=id(req.params.id,'PO');
 const {rows:[po]}=await tx.execute(sql('SELECT * FROM consumable_purchase_orders WHERE id=?',[oid]));
 if(!po)fail('PO_NOT_FOUND','Consumables PO not found',404);
 assertBranch(req,po.branch_id);
 const update=await tx.execute(sql("UPDATE consumable_purchase_orders SET status='submitted' WHERE id=? AND status='draft'",[oid]));
 if(update.rowsAffected!==1)fail('INVALID_PO_TRANSITION','Only draft purchase orders may be submitted',409);
 await tx.execute(sql("INSERT INTO consumable_order_events(po_id,event_type,actor_employee_id) VALUES(?,'submitted',?)",[oid,actor(req)]));
 return{id:oid,status:'submitted'};
}));
router.post('/orders/:id/approve',requirePermission('purchasing_approve'),(req,res)=>mutate(req,res,'approve-po:'+req.params.id,async(tx)=>{
 const oid=id(req.params.id,'PO');
 const {rows:[po]}=await tx.execute(sql('SELECT * FROM consumable_purchase_orders WHERE id=?',[oid]));
 if(!po)fail('PO_NOT_FOUND','Consumables PO not found',404);
 assertBranch(req,po.branch_id);
 if(po.requested_by&&Number(po.requested_by)===actor(req))fail('SELF_APPROVAL','Another authorized employee must approve this purchase order',403);
 const update=await tx.execute(sql("UPDATE consumable_purchase_orders SET status='approved',approved_by=?,approved_at=CURRENT_TIMESTAMP WHERE id=? AND status='submitted'",[actor(req),oid]));
 if(update.rowsAffected!==1)fail('INVALID_PO_TRANSITION','Only submitted purchase orders can be approved',409);
 await tx.execute(sql("INSERT INTO consumable_order_events(po_id,event_type,actor_employee_id) VALUES(?,'approved',?)",[oid,actor(req)]));
 return{id:oid,status:'approved',approved_by:actor(req)};
}));
router.post('/orders/:id/receive',requirePermission('purchasing_receive'),(req,res)=>mutate(req,res,'receive-po:'+req.params.id,async(tx)=>{
 const oid=id(req.params.id,'PO'),{rows:[po]}=await tx.execute(sql('SELECT * FROM consumable_purchase_orders WHERE id=?',[oid]));
 if(!po)fail('PO_NOT_FOUND','Consumables PO not found',404);
 assertBranch(req,po.branch_id);
 if(!['approved','partial'].includes(po.status))fail('PO_NOT_APPROVED','Only approved or partially received orders can be received',409);
 const items=req.body?.items;
 if(!Array.isArray(items)||!items.length||items.length>100)fail('INVALID_RECEIPT','Provide valid receipt lines');
 const seen=new Set(),evidence=[];
 for(const item of items){
  const lineId=id(item.line_id,'PO line'),qty=whole(item.quantity,'Quantity received');
  if(seen.has(lineId))fail('DUPLICATE_RECEIPT_LINE','A PO line can be received only once in an operation');
  seen.add(lineId);
  const {rows:[line]}=await tx.execute(sql('SELECT * FROM consumable_po_lines WHERE id=? AND po_id=?',[lineId,oid]));
  if(!line)fail('LINE_NOT_FOUND','Receipt line does not belong to this PO',409);
  const changed=await tx.execute(sql('UPDATE consumable_po_lines SET quantity_received=quantity_received+? WHERE id=? AND po_id=? AND quantity_received+?<=quantity_ordered',[qty,lineId,oid,qty]));
  if(changed.rowsAffected!==1)fail('OVER_RECEIPT','Receipt exceeds the remaining authorized quantity',409);
  const originalUnitCost=safeInteger(line.unit_cost_cents,'PO unit cost');
  const actualUnitCost=Object.prototype.hasOwnProperty.call(item,'unit_cost')?cents(item.unit_cost):originalUnitCost;
  const costChangeReason=text(item.cost_change_reason,'Cost change reason',800,false);
  if(actualUnitCost!==originalUnitCost&&(!costChangeReason||costChangeReason.length<10))fail('COST_CHANGE_REASON_REQUIRED','Explain the actual receipt cost change in at least 10 characters');
  const value=safeProduct(qty,actualUnitCost,'Receipt value');
  const receiptPurpose='Received against '+po.po_number+(actualUnitCost!==originalUnitCost?' | Unit cost changed from '+originalUnitCost+' to '+actualUnitCost+' cents: '+costChangeReason:'');
  const {rows:[existingBalance]}=await tx.execute(sql('SELECT qty_on_hand,value_cents FROM consumable_balances WHERE branch_id=? AND consumable_id=?',[po.branch_id,line.consumable_id]));
  safeAdd(existingBalance?.qty_on_hand||0,qty,'Stock quantity');safeAdd(existingBalance?.value_cents||0,value,'Stock value');
  await tx.execute(sql('INSERT INTO consumable_balances(consumable_id,branch_id,qty_on_hand,value_cents) VALUES(?,?,?,?) ON CONFLICT(consumable_id,branch_id) DO UPDATE SET qty_on_hand=qty_on_hand+excluded.qty_on_hand,value_cents=value_cents+excluded.value_cents,updated_at=CURRENT_TIMESTAMP',[line.consumable_id,po.branch_id,qty,value]));
  const movement=await tx.execute(sql("INSERT INTO consumable_movements(consumable_id,branch_id,action,quantity,value_cents,po_id,po_line_id,purpose,actor_employee_id) VALUES(?,?,'receive',?,?,?,?,?,?)",[line.consumable_id,po.branch_id,qty,value,oid,lineId,receiptPurpose,actor(req)]));
  evidence.push({movement_id:Number(movement.lastInsertRowid),line_id:lineId,quantity:qty,original_unit_cost_cents:originalUnitCost,actual_unit_cost_cents:actualUnitCost,cost_change_reason:costChangeReason,value_cents:value});
 }
 const {rows:remaining}=await tx.execute(sql('SELECT count(*) pending FROM consumable_po_lines WHERE po_id=? AND quantity_received<quantity_ordered',[oid]));
 const status=Number(remaining[0].pending)===0?'received':'partial';
 await tx.execute(sql('UPDATE consumable_purchase_orders SET status=?,received_at=CASE WHEN ?=? THEN CURRENT_TIMESTAMP ELSE received_at END WHERE id=?',[status,status,'received',oid]));
 await tx.execute(sql("INSERT INTO consumable_order_events(po_id,event_type,actor_employee_id,details) VALUES(?,'received',?,?)",[oid,actor(req),JSON.stringify(evidence)]));
 return{po_id:oid,status,receipt:evidence};
}));
router.get('/balances',requireConsumableRead,async(req,res)=>{
 try{const b=branchFilter(req,'b.branch_id');const {rows}=await db.execute(sql('SELECT b.*,c.sku,c.name,c.uom,br.name branch_name FROM consumable_balances b JOIN consumable_catalog c ON c.id=b.consumable_id JOIN branches br ON br.id=b.branch_id WHERE 1=1'+b.clause+' ORDER BY br.name,c.name',[...b.args]));res.json(rows);}
 catch(e){res.status(500).json({error:'Unable to load consumable balances'});}
});
router.post('/issues',requirePermission('inventory_adjust'),(req,res)=>mutate(req,res,'issue-consumables',async(tx)=>{
 const body=req.body||{},branchId=id(body.branch_id,'Branch'),consumableId=id(body.consumable_id,'Consumable');
 assertBranch(req,branchId);
 await exists(tx,'branches',branchId);await exists(tx,'consumable_catalog',consumableId);
 const qty=whole(body.quantity,'Issued quantity');
 const allocation=await target(tx,body,branchId);
 const purpose=text(body.purpose,'Usage reason',800);
 const {rows:[balance]}=await tx.execute(sql('SELECT qty_on_hand,value_cents FROM consumable_balances WHERE branch_id=? AND consumable_id=?',[branchId,consumableId]));
 if(!balance||Number(balance.qty_on_hand)<qty)fail('INSUFFICIENT_CONSUMABLES','Available consumables cannot cover this issue',409);
 const previousQty=safeInteger(balance.qty_on_hand,'Stock quantity'),previousValue=safeInteger(balance.value_cents,'Stock value');
 const value=weightedCost(previousValue,qty,previousQty);
 const changed=await tx.execute(sql('UPDATE consumable_balances SET qty_on_hand=qty_on_hand-?,value_cents=value_cents-?,updated_at=CURRENT_TIMESTAMP WHERE branch_id=? AND consumable_id=? AND qty_on_hand>=? AND value_cents>=?',[qty,value,branchId,consumableId,qty,value]));
 if(changed.rowsAffected!==1)fail('INSUFFICIENT_CONSUMABLES','Consumable balance changed; recheck the available quantity',409);
 const movement=await tx.execute(sql("INSERT INTO consumable_movements(consumable_id,branch_id,action,quantity,value_cents,department_id,rental_product_id,rental_unit_reference,purpose,actor_employee_id) VALUES(?,?,'issue',?,?,?,?,?,?,?)",[consumableId,branchId,qty,value,allocation.kind==='department'?allocation.identifier:null,allocation.kind==='rental'?allocation.identifier:null,allocation.unitRef,purpose,actor(req)]));
 return{id:Number(movement.lastInsertRowid),branch_id:branchId,consumable_id:consumableId,quantity:qty,cost_cents:value,allocated_to:allocation.kind,allocation_id:allocation.identifier,unit_reference:allocation.unitRef};
}));
router.get('/usage',requireConsumableRead,async(req,res)=>{
 try{
  const b=branchFilter(req,'m.branch_id');
  const {rows}=await db.execute(sql("SELECT m.*,c.name,c.sku,c.uom,br.name branch_name,d.name department_name,p.name rental_equipment_name FROM consumable_movements m JOIN consumable_catalog c ON c.id=m.consumable_id JOIN branches br ON br.id=m.branch_id LEFT JOIN departments d ON d.id=m.department_id LEFT JOIN products p ON p.id=m.rental_product_id WHERE m.action='issue'"+b.clause+' ORDER BY m.id DESC LIMIT 500',b.args));
  res.json(rows);
 }catch(e){res.status(500).json({error:'Unable to load usage records'});}
});
router.get('/usage-summary',requireConsumableRead,async(req,res)=>{
 try{
  const filter=usageFilter(req);
  const {rows}=await db.execute(sql("SELECT m.branch_id,br.name branch_name,m.department_id,d.name department_name,m.rental_product_id,p.name rental_equipment_name,m.rental_unit_reference,m.consumable_id,c.sku,c.name,c.uom,SUM(m.quantity) quantity,SUM(m.value_cents) cost_cents,COUNT(*) issue_count FROM consumable_movements m JOIN consumable_catalog c ON c.id=m.consumable_id JOIN branches br ON br.id=m.branch_id LEFT JOIN departments d ON d.id=m.department_id LEFT JOIN products p ON p.id=m.rental_product_id WHERE m.action='issue'"+filter.clause+' GROUP BY m.branch_id,m.department_id,m.rental_product_id,m.rental_unit_reference,m.consumable_id ORDER BY br.name,c.name,m.department_id,m.rental_product_id,m.rental_unit_reference',filter.args));
  let totalCost=0,totalIssues=0;
  const quantities=new Map();
  for(const row of rows){
   row.quantity=safeInteger(row.quantity,'Usage quantity');row.cost_cents=safeInteger(row.cost_cents,'Usage cost');row.issue_count=safeInteger(row.issue_count,'Issue count');
   totalCost=safeAdd(totalCost,row.cost_cents,'Total usage cost');totalIssues=safeAdd(totalIssues,row.issue_count,'Total issue count');
   const key=Number(row.consumable_id),item=quantities.get(key)||{consumable_id:key,sku:row.sku,name:row.name,uom:row.uom,quantity:0};
   item.quantity=safeAdd(item.quantity,row.quantity,'Product usage quantity');quantities.set(key,item);
  }
  res.json({groups:rows,totals:{cost_cents:totalCost,issue_count:totalIssues,quantities_by_consumable:[...quantities.values()]}});
 }catch(e){res.status(e.status||500).json({error:e.status?e.message:'Unable to load usage summary',code:e.code||'USAGE_SUMMARY_FAILED'});}
});
function usageFilter(req){
 const scoped=branchFilter(req,'m.branch_id'),args=[...scoped.args];let clause=scoped.clause;
 for(const [query,col] of [['branch_id','m.branch_id'],['department_id','m.department_id'],['rental_product_id','m.rental_product_id'],['consumable_id','m.consumable_id']]){
  if(req.query?.[query]!=null&&req.query[query]!==''){
   const value=id(req.query[query],query);if(query==='branch_id')assertBranch(req,value);
   clause+=' AND '+col+'=?';args.push(value);
  }
 }
 const dates={};
 for(const field of ['date_from','date_to'])if(req.query?.[field]){
  const value=String(req.query[field]);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('INVALID_DATE','Use valid ISO dates');
  dates[field]=value;
 }
 if(dates.date_from&&dates.date_to&&dates.date_from>dates.date_to)fail('INVALID_DATE_RANGE','Start date must be on or before end date');
 if(dates.date_from){clause+=" AND m.created_at>=?";args.push(dates.date_from+' 00:00:00');}
 if(dates.date_to){clause+=" AND m.created_at<datetime(?, '+1 day')";args.push(dates.date_to+' 00:00:00');}
 if(req.query?.rental_unit_reference){clause+=' AND m.rental_unit_reference=?';args.push(text(req.query.rental_unit_reference,'Rental unit',120));}
 return{clause,args};
}
router.controls={assertBranch,branchFilter,authorizeOperation,safeInteger,safeAdd,safeProduct,weightedCost,usageFilter};
module.exports=router;
