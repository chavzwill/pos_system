'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureCostAllocationSchema,normalizeAllocations,insertAllocations,allocationsForSource}=require('../lib/cost-allocations');
const {enqueueSpendEvent}=require('../lib/spendos-outbox');

const CATEGORIES=new Set(['rent_lease','utilities','telecom','software_subscription','insurance','maintenance_contract','cleaning_security','professional_service','transport_logistics','licence_permit','other']);
const CADENCES=new Set(['weekly','monthly','quarterly','semiannual','annual','custom']);
const STATUSES=new Set(['active','paused','cancelled','expired']);
let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureCostAllocationSchema();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS operating_commitments(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        commitment_number TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        supplier_id INTEGER REFERENCES suppliers(id),
        provider_name TEXT,
        branch_id INTEGER REFERENCES branches(id),
        department TEXT,
        currency TEXT,
        expected_amount REAL NOT NULL,
        cadence TEXT NOT NULL,
        custom_interval_days INTEGER,
        start_date DATE NOT NULL,
        end_date DATE,
        next_due_date DATE,
        auto_renew INTEGER NOT NULL DEFAULT 0,
        renewal_date DATE,
        cancellation_notice_days INTEGER,
        terms_reference TEXT,
        contract_reference TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT,
        source_version INTEGER NOT NULL DEFAULT 1,
        created_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_operating_commitments_status_due ON operating_commitments(status,next_due_date)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_operating_commitments_supplier ON operating_commitments(supplier_id,status)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_operating_commitments_branch ON operating_commitments(branch_id,status)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function money(v){return Number(Number(v||0).toFixed(2));}
function annualized(amount,cadence,customDays){
  const a=money(amount);
  const factor={weekly:52,monthly:12,quarterly:4,semiannual:2,annual:1}[cadence];
  if(factor)return money(a*factor);
  const days=Number(customDays||0);
  return days>0?money(a*(365/days)):null;
}
function daysUntil(value){
  if(!value)return null;
  const today=Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z');
  const target=Date.parse(String(value)+'T00:00:00Z');
  return Number.isFinite(target)?Math.ceil((target-today)/86400000):null;
}
async function nextNumber(executor){
  const {rows:[row]}=await executor.execute({sql:"SELECT commitment_number FROM operating_commitments WHERE commitment_number LIKE 'OC-%' ORDER BY id DESC LIMIT 1",args:[]});
  const n=Number(String(row?.commitment_number||'OC-000000').replace(/\D/g,''))||0;
  return 'OC-'+String(n+1).padStart(6,'0');
}
async function getCommitment(executor,id){
  const {rows:[row]}=await executor.execute({sql:`SELECT oc.*,s.name supplier_name,b.name branch_name
    FROM operating_commitments oc
    LEFT JOIN suppliers s ON s.id=oc.supplier_id
    LEFT JOIN branches b ON b.id=oc.branch_id
    WHERE oc.id=?`,args:[id]});
  if(!row)return null;
  const allocations=await allocationsForSource('operating_commitment',row.id);
  return {...row,annualized_amount:annualized(row.expected_amount,row.cadence,row.custom_interval_days),allocations};
}
function validateBody(body,{partial=false}={}){
  const out={};
  if(!partial||body.category!==undefined){out.category=String(body.category||'').trim();if(!CATEGORIES.has(out.category))throw new Error('Unsupported operating commitment category');}
  if(!partial||body.name!==undefined){out.name=String(body.name||'').trim();if(!out.name)throw new Error('Commitment name is required');}
  if(!partial||body.expected_amount!==undefined){out.expected_amount=money(body.expected_amount);if(!Number.isFinite(out.expected_amount)||out.expected_amount<=0)throw new Error('Expected amount must be greater than zero');}
  if(!partial||body.cadence!==undefined){out.cadence=String(body.cadence||'').trim();if(!CADENCES.has(out.cadence))throw new Error('Unsupported commitment cadence');}
  if(!partial||body.start_date!==undefined){out.start_date=String(body.start_date||'').trim();if(!out.start_date)throw new Error('Start date is required');}
  if(body.custom_interval_days!==undefined){out.custom_interval_days=body.custom_interval_days?Number(body.custom_interval_days):null;if(out.custom_interval_days!==null&&(!Number.isInteger(out.custom_interval_days)||out.custom_interval_days<1))throw new Error('Custom interval days must be a positive whole number');}
  if((out.cadence||body.cadence)==='custom'&&!Number(out.custom_interval_days||body.custom_interval_days||0))throw new Error('Custom cadence requires custom_interval_days');
  out.supplier_id=body.supplier_id?Number(body.supplier_id):null;
  out.provider_name=String(body.provider_name||'').trim()||null;
  if(!partial&&!out.supplier_id&&!out.provider_name)throw new Error('Supplier or provider name is required');
  out.branch_id=body.branch_id?Number(body.branch_id):null;
  out.department=String(body.department||'').trim()||null;
  out.currency=String(body.currency||'').trim()||null;
  out.end_date=body.end_date||null;
  out.next_due_date=body.next_due_date||null;
  if(out.end_date&&Date.parse(String(out.end_date)+'T00:00:00Z')<Date.parse(String(out.start_date||body.start_date)+'T00:00:00Z'))throw new Error('Commitment end date cannot be before start date');
  if(out.next_due_date&&Date.parse(String(out.next_due_date)+'T00:00:00Z')<Date.parse(String(out.start_date||body.start_date)+'T00:00:00Z'))throw new Error('Next due date cannot be before start date');
  out.auto_renew=body.auto_renew?1:0;
  out.renewal_date=body.renewal_date||null;
  if(out.auto_renew&&!out.renewal_date)throw new Error('Auto-renewing commitment requires a renewal date');
  out.cancellation_notice_days=body.cancellation_notice_days==null||body.cancellation_notice_days===''?null:Number(body.cancellation_notice_days);
  if(out.cancellation_notice_days!==null&&(!Number.isInteger(out.cancellation_notice_days)||out.cancellation_notice_days<0))throw new Error('Cancellation notice days must be a non-negative whole number');
  out.terms_reference=String(body.terms_reference||'').trim()||null;
  out.contract_reference=String(body.contract_reference||'').trim()||null;
  out.notes=String(body.notes||'').trim()||null;
  return out;
}
async function validateAllocationTargets(executor,allocations){
  for(const a of allocations){
    const id=a.target_id==null||a.target_id===''?null:Number(a.target_id);
    if(a.target_type==='general_overhead'&&!id)continue;
    if(!id)throw new Error(`Cost target ID is required for ${a.target_type}`);
    let sql,args;
    if(a.target_type==='branch'){sql='SELECT id FROM branches WHERE id=? AND active=1';args=[id];}
    else if(a.target_type==='vehicle'){sql='SELECT id FROM dispatch_vehicles WHERE id=? AND active=1';args=[id];}
    else if(a.target_type==='rental_asset'){sql="SELECT id FROM rental_assets WHERE id=? AND status NOT IN ('disposed','sold','lost')";args=[id];}
    else if(a.target_type==='work_order'){sql="SELECT id FROM work_orders WHERE id=? AND status NOT IN ('completed','cancelled')";args=[id];}
    else {sql='SELECT id FROM cost_objects WHERE id=? AND object_type=? AND active=1';args=[id,a.target_type];}
    const {rows:[row]}=await executor.execute({sql,args});
    if(!row)throw new Error(`Invalid or inactive ${a.target_type} cost target`);
  }
}
function eventFor(row,allocations,type='operating.commitment.updated',actorId=null){
  return {
    id:`total-tools:operating-commitment:${row.id}:${row.source_version}`,type,
    occurredAt:new Date().toISOString(),tenantId:process.env.SPENDOS_TENANT_ID||'total-tools',
    source:'total-tools-pos',sourceRecordId:String(row.id),sourceVersion:Number(row.source_version||1),
    actorId:actorId?String(actorId):null,locationId:row.branch_id?String(row.branch_id):null,departmentId:row.department||null,
    payload:{
      commitmentNumber:row.commitment_number,category:row.category,name:row.name,
      supplierId:row.supplier_id?String(row.supplier_id):null,providerName:row.provider_name||null,
      currency:row.currency||null,expectedAmount:money(row.expected_amount),
      annualizedAmount:annualized(row.expected_amount,row.cadence,row.custom_interval_days),
      cadence:row.cadence,customIntervalDays:row.custom_interval_days||null,startDate:row.start_date,endDate:row.end_date||null,
      nextDueDate:row.next_due_date||null,autoRenew:!!row.auto_renew,renewalDate:row.renewal_date||null,
      cancellationNoticeDays:row.cancellation_notice_days??null,termsReference:row.terms_reference||null,
      contractReference:row.contract_reference||null,status:row.status,
      allocations:(allocations||[]).map(a=>({targetType:a.target_type,targetId:a.target_id,targetLabel:a.target_label,amount:Number(a.allocation_amount||0),percent:a.allocation_percent,purpose:a.purpose,expenseCategory:a.expense_category}))
    }
  };
}

router.use(requireAnyPermission('reports_financial','purchasing'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Operating commitment initialization failed'});}});

router.get('/',async(req,res)=>{
  try{
    let sql=`SELECT oc.*,s.name supplier_name,b.name branch_name
      FROM operating_commitments oc LEFT JOIN suppliers s ON s.id=oc.supplier_id
      LEFT JOIN branches b ON b.id=oc.branch_id WHERE 1=1`;const args=[];
    if(req.query.status){sql+=' AND oc.status=?';args.push(req.query.status);}
    if(req.query.branch_id){sql+=' AND oc.branch_id=?';args.push(req.query.branch_id);}
    if(req.query.category){sql+=' AND oc.category=?';args.push(req.query.category);}
    sql+=' ORDER BY CASE oc.status WHEN \'active\' THEN 0 WHEN \'paused\' THEN 1 ELSE 2 END,COALESCE(oc.next_due_date,oc.renewal_date,oc.end_date),oc.id DESC';
    const {rows}=await db.execute({sql,args});
    res.json(rows.map(x=>({...x,annualized_amount:annualized(x.expected_amount,x.cadence,x.custom_interval_days),days_until_due:daysUntil(x.next_due_date),days_until_renewal:daysUntil(x.renewal_date)})));
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const b=validateBody(req.body||{});
    const allocations=normalizeAllocations(req.body?.allocations,b.expected_amount);
    if(!allocations.length)throw new Error('Operating commitment must be allocated to at least one cost target');
    await validateAllocationTargets(tx,allocations);
    const number=await nextNumber(tx);
    const r=await tx.execute({sql:`INSERT INTO operating_commitments(
      commitment_number,category,name,supplier_id,provider_name,branch_id,department,currency,expected_amount,cadence,custom_interval_days,
      start_date,end_date,next_due_date,auto_renew,renewal_date,cancellation_notice_days,terms_reference,contract_reference,notes,created_by_employee_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[
      number,b.category,b.name,b.supplier_id,b.provider_name,b.branch_id,b.department,b.currency,b.expected_amount,b.cadence,b.custom_interval_days,
      b.start_date,b.end_date,b.next_due_date,b.auto_renew,b.renewal_date,b.cancellation_notice_days,b.terms_reference,b.contract_reference,b.notes,actor(req)
    ]});
    const id=Number(r.lastInsertRowid);
    await insertAllocations(tx,{sourceType:'operating_commitment',sourceId:id,sourceLineId:null,allocations,createdBy:actor(req)});
    const {rows:[row]}=await tx.execute({sql:'SELECT * FROM operating_commitments WHERE id=?',args:[id]});
    await enqueueSpendEvent(tx,eventFor(row,allocations,'operating.commitment.created',actor(req)));
    await tx.commit();committed=true;
    res.status(201).json(await getCommitment(db,id));
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.patch('/:id/status',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const status=String(req.body?.status||'').trim();
    if(!STATUSES.has(status))throw new Error('Unsupported commitment status');
    const {rows:[current]}=await tx.execute({sql:'SELECT * FROM operating_commitments WHERE id=?',args:[req.params.id]});
    if(!current)throw new Error('Operating commitment not found');
    const nextVersion=Number(current.source_version||1)+1;
    await tx.execute({sql:'UPDATE operating_commitments SET status=?,source_version=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[status,nextVersion,current.id]});
    const {rows:[row]}=await tx.execute({sql:'SELECT * FROM operating_commitments WHERE id=?',args:[current.id]});
    const {rows:allocations}=await tx.execute({sql:'SELECT * FROM cost_allocations WHERE source_type=? AND source_id=? ORDER BY id',args:['operating_commitment',String(current.id)]});
    await enqueueSpendEvent(tx,eventFor(row,allocations,'operating.commitment.status_changed',actor(req)));
    await tx.commit();committed=true;
    res.json(await getCommitment(db,current.id));
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.get('/attention',async(req,res)=>{
  try{
    const args=[];let where="oc.status='active'";
    if(req.query.branch_id){where+=' AND oc.branch_id=?';args.push(req.query.branch_id);}
    const {rows}=await db.execute({sql:`SELECT oc.*,s.name supplier_name,b.name branch_name
      FROM operating_commitments oc LEFT JOIN suppliers s ON s.id=oc.supplier_id
      LEFT JOIN branches b ON b.id=oc.branch_id WHERE ${where}
      ORDER BY COALESCE(oc.next_due_date,oc.renewal_date,oc.end_date),oc.id`,args});
    const items=[];
    for(const x of rows){
      const due=daysUntil(x.next_due_date),renewal=daysUntil(x.renewal_date),end=daysUntil(x.end_date);
      const noticeDeadline=x.renewal_date&&x.cancellation_notice_days!=null
        ?new Date(Date.parse(String(x.renewal_date)+'T00:00:00Z')-Number(x.cancellation_notice_days)*86400000).toISOString().slice(0,10):null;
      const notice=daysUntil(noticeDeadline);
      if(due!==null&&due<0)items.push({type:'past_due_plan',priority:due<=-30?'critical':'high',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:money(x.expected_amount),days:due,reason:'Planned operating obligation due date has passed. Confirm whether a supplier bill was received, paid, deferred, or the commitment changed.'});
      else if(due!==null&&due<=14)items.push({type:'upcoming_due',priority:due<=3?'high':'medium',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:money(x.expected_amount),days:due,reason:'Operating commitment is approaching its planned due date.'});
      if(x.auto_renew&&notice!==null&&notice>=0&&notice<=30)items.push({type:'cancellation_window',priority:notice<=7?'high':'medium',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:money(x.expected_amount),days:notice,reason:'Cancellation/renegotiation notice window is approaching before auto-renewal.'});
      if(x.auto_renew&&renewal!==null&&renewal>=0&&renewal<=30)items.push({type:'renewal_approaching',priority:renewal<=7?'high':'medium',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:money(x.expected_amount),days:renewal,reason:'Auto-renewal date is approaching. Review utilization, pricing, alternatives, and cancellation terms.'});
      if(!x.supplier_id&&!x.provider_name)items.push({type:'provider_evidence_gap',priority:'high',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,amount:money(x.expected_amount),days:null,reason:'Recurring commitment has no supplier/provider evidence.'});
      if(x.auto_renew&&!x.terms_reference&&!x.contract_reference)items.push({type:'renewal_evidence_gap',priority:'high',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:money(x.expected_amount),days:renewal,reason:'Auto-renewing commitment lacks contract or terms reference.'});
      if(end!==null&&end<0)items.push({type:'expired_commitment',priority:'high',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:money(x.expected_amount),days:end,reason:'Commitment end date has passed but status is still active.'});
    }
    const rank={critical:3,high:2,medium:1,low:0};items.sort((a,b)=>(rank[b.priority]||0)-(rank[a.priority]||0)||(a.days??999)-(b.days??999)||b.amount-a.amount);
    res.json({summary:{total:items.length,critical:items.filter(x=>x.priority==='critical').length,high:items.filter(x=>x.priority==='high').length,medium:items.filter(x=>x.priority==='medium').length,annualized_active_commitment:money(rows.reduce((s,x)=>s+Number(annualized(x.expected_amount,x.cadence,x.custom_interval_days)||0),0))},items,
      basis:'Planning attention only. Operating commitments do not create supplier invoices, AP, payments, or accounting entries. Actual bills remain authoritative in Supplier Ledger.'});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/:id',async(req,res)=>{
  try{const row=await getCommitment(db,req.params.id);if(!row)return res.status(404).json({error:'Operating commitment not found'});res.json(row);}
  catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
