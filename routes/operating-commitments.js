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
      {sql:'CREATE INDEX IF NOT EXISTS idx_operating_commitments_branch ON operating_commitments(branch_id,status)'},
      {sql:`CREATE TABLE IF NOT EXISTS operating_commitment_invoice_links(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        commitment_id INTEGER NOT NULL REFERENCES operating_commitments(id),
        supplier_invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
        service_period DATE NOT NULL,
        linked_amount REAL NOT NULL,
        note TEXT,
        linked_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(commitment_id,supplier_invoice_id,service_period)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_operating_commitment_invoice_links_commitment ON operating_commitment_invoice_links(commitment_id,service_period)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_operating_commitment_invoice_links_invoice ON operating_commitment_invoice_links(supplier_invoice_id)'}
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

router.post('/:id/invoice-links',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const commitmentId=Number(req.params.id),invoiceId=Number(req.body?.supplier_invoice_id);
    const servicePeriod=String(req.body?.service_period||'').trim();
    const linkedAmount=money(req.body?.linked_amount),note=String(req.body?.note||'').trim()||null;
    if(!invoiceId||!servicePeriod||!/^\d{4}-\d{2}-\d{2}$/.test(servicePeriod))throw new Error('Supplier invoice and service period date are required');
    if(!Number.isFinite(linkedAmount)||linkedAmount<=0)throw new Error('Linked invoice amount must be greater than zero');
    const {rows:[commitment]}=await tx.execute({sql:'SELECT * FROM operating_commitments WHERE id=?',args:[commitmentId]});
    if(!commitment)throw new Error('Operating commitment not found');
    if(commitment.status==='cancelled')throw new Error('Cancelled operating commitment cannot receive new invoice links');
    const {rows:[invoice]}=await tx.execute({sql:"SELECT * FROM supplier_invoices WHERE id=? AND status!='void'",args:[invoiceId]});
    if(!invoice)throw new Error('Supplier invoice not found or void');
    if(commitment.supplier_id&&Number(invoice.supplier_id)!==Number(commitment.supplier_id))throw new Error('Supplier invoice must belong to the operating commitment supplier');
    if(commitment.branch_id&&Number(invoice.branch_id||0)!==Number(commitment.branch_id))throw new Error('Supplier invoice branch must match the operating commitment branch');
    if(Date.parse(servicePeriod+'T00:00:00Z')<Date.parse(String(commitment.start_date)+'T00:00:00Z'))throw new Error('Service period cannot be before commitment start date');
    if(commitment.end_date&&Date.parse(servicePeriod+'T00:00:00Z')>Date.parse(String(commitment.end_date)+'T00:00:00Z'))throw new Error('Service period cannot be after commitment end date');
    const {rows:[already]}=await tx.execute({sql:'SELECT COALESCE(SUM(linked_amount),0) amount FROM operating_commitment_invoice_links WHERE supplier_invoice_id=?',args:[invoiceId]});
    if(money(Number(already?.amount||0)+linkedAmount)-money(invoice.total)>0.01)throw new Error('Commitment links cannot exceed the supplier invoice total');
    const r=await tx.execute({sql:`INSERT INTO operating_commitment_invoice_links(
      commitment_id,supplier_invoice_id,service_period,linked_amount,note,linked_by_employee_id
    ) VALUES(?,?,?,?,?,?)`,args:[commitmentId,invoiceId,servicePeriod,linkedAmount,note,actor(req)]});
    const nextVersion=Number(commitment.source_version||1)+1;
    await tx.execute({sql:'UPDATE operating_commitments SET source_version=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[nextVersion,commitmentId]});
    const {rows:[row]}=await tx.execute({sql:'SELECT * FROM operating_commitments WHERE id=?',args:[commitmentId]});
    const {rows:allocations}=await tx.execute({sql:'SELECT * FROM cost_allocations WHERE source_type=? AND source_id=? ORDER BY id',args:['operating_commitment',String(commitmentId)]});
    const event=eventFor(row,allocations,'operating.commitment.invoice_linked',actor(req));
    event.payload.invoiceLink={linkId:Number(r.lastInsertRowid),supplierInvoiceId:String(invoiceId),invoiceNumber:invoice.invoice_number,servicePeriod,linkedAmount};
    await enqueueSpendEvent(tx,event);
    await tx.commit();committed=true;
    res.status(201).json({id:Number(r.lastInsertRowid),commitment_id:commitmentId,supplier_invoice_id:invoiceId,invoice_number:invoice.invoice_number,service_period:servicePeriod,linked_amount:linkedAmount});
  }catch(e){
    if(!committed)try{await tx.rollback();}catch{}
    if(String(e.message||'').includes('UNIQUE'))return res.status(409).json({error:'This supplier invoice is already linked to the commitment for that service period'});
    res.status(400).json({error:e.message});
  }
});

router.get('/:id/reconciliation',async(req,res)=>{
  try{
    const commitment=await getCommitment(db,req.params.id);
    if(!commitment)return res.status(404).json({error:'Operating commitment not found'});
    const {rows:links}=await db.execute({sql:`SELECT l.*,si.invoice_number,si.invoice_date,si.total invoice_total,si.status invoice_status
      FROM operating_commitment_invoice_links l
      JOIN supplier_invoices si ON si.id=l.supplier_invoice_id
      WHERE l.commitment_id=? ORDER BY l.service_period,l.id`,args:[commitment.id]});
    const periods=new Map();
    for(const x of links){
      if(!periods.has(x.service_period))periods.set(x.service_period,{service_period:x.service_period,expected_amount:money(commitment.expected_amount),actual_linked_amount:0,invoices:[]});
      const p=periods.get(x.service_period);
      p.actual_linked_amount=money(p.actual_linked_amount+Number(x.linked_amount||0));
      p.invoices.push({link_id:x.id,supplier_invoice_id:x.supplier_invoice_id,invoice_number:x.invoice_number,invoice_date:x.invoice_date,linked_amount:money(x.linked_amount)});
    }
    const reconciled=[...periods.values()].map(p=>{
      const variance=money(p.actual_linked_amount-p.expected_amount);
      return {...p,variance,variance_percent:p.expected_amount?Number(((variance/p.expected_amount)*100).toFixed(2)):null,
        status:Math.abs(variance)<=0.01?'on_target':variance>0?'over_expected':'under_expected'};
    });
    res.json({commitment:{id:commitment.id,commitment_number:commitment.commitment_number,name:commitment.name,expected_amount:money(commitment.expected_amount),cadence:commitment.cadence},periods:reconciled,
      summary:{linked_periods:reconciled.length,over_expected:reconciled.filter(x=>x.status==='over_expected').length,under_expected:reconciled.filter(x=>x.status==='under_expected').length,on_target:reconciled.filter(x=>x.status==='on_target').length,total_variance:money(reconciled.reduce((s,x)=>s+Number(x.variance||0),0))},
      basis:'Reconciliation compares linked supplier invoice evidence to the commitment expected amount for each service period. It does not alter the supplier invoice, AP, payment, or accounting records.'});
  }catch(e){res.status(500).json({error:e.message});}
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

router.get('/performance',async(req,res)=>{
  try{
    const args=[];let where="oc.status='active'";
    if(req.query.branch_id){where+=' AND oc.branch_id=?';args.push(req.query.branch_id);}
    if(req.query.category){where+=' AND oc.category=?';args.push(req.query.category);}
    const {rows:commitments}=await db.execute({sql:`SELECT oc.*,s.name supplier_name,b.name branch_name
      FROM operating_commitments oc
      LEFT JOIN suppliers s ON s.id=oc.supplier_id
      LEFT JOIN branches b ON b.id=oc.branch_id
      WHERE ${where}
      ORDER BY oc.id`,args});
    const ids=commitments.map(x=>Number(x.id));
    let periodRows=[];
    if(ids.length){
      const placeholders=ids.map(()=>'?').join(',');
      const result=await db.execute({sql:`SELECT l.commitment_id,l.service_period,
        SUM(l.linked_amount) actual_linked_amount,
        COUNT(DISTINCT l.supplier_invoice_id) invoice_count
        FROM operating_commitment_invoice_links l
        WHERE l.commitment_id IN (${placeholders})
        GROUP BY l.commitment_id,l.service_period
        ORDER BY l.commitment_id,l.service_period`,args:ids});
      periodRows=result.rows;
    }
    const byCommitment=new Map();
    for(const p of periodRows){
      const id=Number(p.commitment_id);
      if(!byCommitment.has(id))byCommitment.set(id,[]);
      byCommitment.get(id).push({service_period:p.service_period,actual_linked_amount:money(p.actual_linked_amount),invoice_count:Number(p.invoice_count||0)});
    }
    const items=[];
    for(const c of commitments){
      const periods=byCommitment.get(Number(c.id))||[];
      const expected=money(c.expected_amount),count=periods.length;
      const actualTotal=money(periods.reduce((s,p)=>s+Number(p.actual_linked_amount||0),0));
      const expectedTotal=money(expected*count),totalVariance=money(actualTotal-expectedTotal);
      const over=periods.filter(p=>Number(p.actual_linked_amount)>expected+0.01).length;
      const under=periods.filter(p=>Number(p.actual_linked_amount)<expected-0.01).length;
      const onTarget=count-over-under;
      let consecutiveOver=0;
      for(let i=periods.length-1;i>=0;i--){if(Number(periods[i].actual_linked_amount)>expected+0.01)consecutiveOver++;else break;}
      const latest=count?periods[count-1]:null,previous=count>1?periods[count-2]:null;
      const latestActual=money(latest?.actual_linked_amount||0);
      const latestVariance=count?money(latestActual-expected):0;
      const latestVariancePct=count&&expected?Number(((latestVariance/expected)*100).toFixed(2)):null;
      const priorActual=money(previous?.actual_linked_amount||0);
      const periodDriftPct=previous&&priorActual?Number((((latestActual-priorActual)/priorActual)*100).toFixed(2)):null;
      const annualizedExpected=annualized(expected,c.cadence,c.custom_interval_days);
      const annualizedLatest=count?annualized(latestActual,c.cadence,c.custom_interval_days):null;
      const renewalDays=daysUntil(c.renewal_date);
      const reasons=[];let severity='normal';
      if(consecutiveOver>=2){severity='high';reasons.push(`${consecutiveOver} consecutive linked periods are above the expected amount`);}
      else if(over>=2){severity='medium';reasons.push(`${over} linked periods are above expected`);}
      if(periodDriftPct!==null&&periodDriftPct>=10){severity=severity==='high'?'high':'medium';reasons.push(`Latest linked bill increased ${periodDriftPct.toFixed(2)}% versus the previous linked period`);}
      if(latestVariancePct!==null&&latestVariancePct>=20){severity='high';reasons.push(`Latest linked period is ${latestVariancePct.toFixed(2)}% above expected`);}
      if(c.auto_renew&&renewalDays!==null&&renewalDays>=0&&renewalDays<=90&&(consecutiveOver>0||totalVariance>0.01)){
        severity='high';reasons.push(`Renewal is in ${renewalDays} days while linked spend is above expectation`);
      }
      if(count===0){severity='watch';reasons.push('No supplier invoice periods have been linked yet');}
      items.push({
        commitment_id:c.id,commitment_number:c.commitment_number,name:c.name,category:c.category,status:c.status,
        supplier_id:c.supplier_id||null,supplier_name:c.supplier_name||c.provider_name||null,branch_id:c.branch_id||null,branch_name:c.branch_name||null,
        cadence:c.cadence,expected_amount:expected,annualized_expected:annualizedExpected,history_periods:count,
        actual_linked_total:actualTotal,expected_total_for_linked_periods:expectedTotal,total_variance:totalVariance,
        total_variance_percent:expectedTotal?Number(((totalVariance/expectedTotal)*100).toFixed(2)):null,
        over_expected_periods:over,under_expected_periods:under,on_target_periods:onTarget,consecutive_over_expected:consecutiveOver,
        latest_service_period:latest?.service_period||null,latest_actual_amount:latestActual,latest_variance:latestVariance,
        latest_variance_percent:latestVariancePct,prior_actual_amount:priorActual,period_over_period_drift_percent:periodDriftPct,
        annualized_latest_run_rate:annualizedLatest,auto_renew:!!c.auto_renew,renewal_date:c.renewal_date||null,days_until_renewal:renewalDays,
        review_priority:severity,reasons
      });
    }
    const rank={high:3,medium:2,watch:1,normal:0};
    items.sort((a,b)=>(rank[b.review_priority]||0)-(rank[a.review_priority]||0)||Math.abs(b.total_variance)-Math.abs(a.total_variance)||String(a.commitment_number).localeCompare(String(b.commitment_number)));
    const historyItems=items.filter(x=>x.history_periods>0);
    res.json({
      summary:{
        active_commitments:items.length,
        commitments_with_history:historyItems.length,
        high_review:items.filter(x=>x.review_priority==='high').length,
        medium_review:items.filter(x=>x.review_priority==='medium').length,
        cumulative_expected:money(historyItems.reduce((s,x)=>s+Number(x.expected_total_for_linked_periods||0),0)),
        cumulative_linked_actual:money(historyItems.reduce((s,x)=>s+Number(x.actual_linked_total||0),0)),
        cumulative_variance:money(historyItems.reduce((s,x)=>s+Number(x.total_variance||0),0)),
        annualized_expected_active:money(items.reduce((s,x)=>s+Number(x.annualized_expected||0),0)),
        annualized_latest_run_rate:money(historyItems.reduce((s,x)=>s+Number(x.annualized_latest_run_rate||0),0)),
        renewal_review_within_90_days:items.filter(x=>x.auto_renew&&x.days_until_renewal!==null&&x.days_until_renewal>=0&&x.days_until_renewal<=90&&x.review_priority!=='normal').length
      },
      items,
      basis:'Diagnostic commitment performance only. Variance and price-drift signals compare linked supplier invoice evidence with recorded commitment expectations. They do not amend contracts, invoices, AP, payments, allocations, or accounting entries.'
    });
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/attention',async(req,res)=>{
  try{
    const args=[];let where="oc.status='active'";
    if(req.query.branch_id){where+=' AND oc.branch_id=?';args.push(req.query.branch_id);}
    const {rows}=await db.execute({sql:`SELECT oc.*,s.name supplier_name,b.name branch_name,COALESCE(l.linked_amount,0) current_period_linked_amount
      FROM operating_commitments oc LEFT JOIN suppliers s ON s.id=oc.supplier_id
      LEFT JOIN branches b ON b.id=oc.branch_id
      LEFT JOIN (
        SELECT commitment_id,service_period,SUM(linked_amount) linked_amount
        FROM operating_commitment_invoice_links GROUP BY commitment_id,service_period
      ) l ON l.commitment_id=oc.id AND l.service_period=oc.next_due_date
      WHERE ${where}
      ORDER BY COALESCE(oc.next_due_date,oc.renewal_date,oc.end_date),oc.id`,args});
    const items=[];
    for(const x of rows){
      const due=daysUntil(x.next_due_date),renewal=daysUntil(x.renewal_date),end=daysUntil(x.end_date);
      const noticeDeadline=x.renewal_date&&x.cancellation_notice_days!=null
        ?new Date(Date.parse(String(x.renewal_date)+'T00:00:00Z')-Number(x.cancellation_notice_days)*86400000).toISOString().slice(0,10):null;
      const notice=daysUntil(noticeDeadline);
      const linkedForPeriod=money(x.current_period_linked_amount||0),expected=money(x.expected_amount||0),periodVariance=money(linkedForPeriod-expected);
      if(due!==null&&due<0&&linkedForPeriod<=0.009)items.push({type:'missing_invoice_evidence',priority:due<=-30?'critical':'high',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:expected,days:due,reason:'Planned operating obligation due date has passed but no supplier invoice is linked for that service period.'});
      else if(due!==null&&due<=14&&linkedForPeriod<=0.009)items.push({type:'upcoming_due',priority:due<=3?'high':'medium',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:expected,days:due,reason:'Operating commitment is approaching its planned due date and no supplier invoice is linked yet.'});
      if(linkedForPeriod>0.009&&Math.abs(periodVariance)>0.01){
        const pct=expected?Math.abs(periodVariance/expected):1;
        items.push({type:'invoice_amount_variance',priority:pct>=0.2?'high':'medium',commitment_id:x.id,commitment_number:x.commitment_number,name:x.name,supplier_name:x.supplier_name||x.provider_name,amount:Math.abs(periodVariance),days:due,reason:`Linked supplier invoice evidence differs from expected commitment amount by ${periodVariance.toFixed(2)} for the current service period.`});
      }
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
