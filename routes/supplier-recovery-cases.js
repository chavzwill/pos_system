'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureSupplierRecoverablesSchema,money}=require('../lib/supplier-recoverables');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureSupplierRecoverablesSchema();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_recovery_cases(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id INTEGER NOT NULL UNIQUE REFERENCES supplier_recoverable_claims(id),
        status TEXT NOT NULL DEFAULT 'open',
        owner_employee_id INTEGER REFERENCES employees(id),
        priority TEXT NOT NULL DEFAULT 'medium',
        next_follow_up_at TEXT,
        promised_settlement_date TEXT,
        promised_amount REAL,
        dispute_reason TEXT,
        escalation_level INTEGER NOT NULL DEFAULT 0,
        created_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_recovery_case_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL REFERENCES supplier_recovery_cases(id),
        event_type TEXT NOT NULL,
        actor_employee_id INTEGER REFERENCES employees(id),
        note TEXT,
        promised_settlement_date TEXT,
        promised_amount REAL,
        evidence_reference TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_recovery_cases_status ON supplier_recovery_cases(status,priority,next_follow_up_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_recovery_case_events_case ON supplier_recovery_case_events(case_id,created_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function validStatus(v){return ['open','follow_up','promised','disputed','escalated','closed'].includes(v);}
function validPriority(v){return ['low','medium','high','critical'].includes(v);}
async function getCase(executor,id){
  const {rows:[row]}=await executor.execute({sql:`SELECT rc.*,c.claim_number,c.claim_type,c.status claim_status,
      c.confirmed_amount,c.recovered_amount,c.identified_amount,c.due_date,c.source_reference,c.supplier_id,
      s.name supplier_name,
      e.first_name||' '||e.last_name owner_name
    FROM supplier_recovery_cases rc
    JOIN supplier_recoverable_claims c ON c.id=rc.claim_id
    JOIN suppliers s ON s.id=c.supplier_id
    LEFT JOIN employees e ON e.id=rc.owner_employee_id
    WHERE rc.id=?`,args:[id]});
  return row||null;
}

router.use(requireAnyPermission('purchasing','reports_financial','accounts'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier recovery case initialization failed'});}});

router.get('/',async(req,res)=>{
  try{
    let sql=`SELECT rc.*,c.claim_number,c.claim_type,c.status claim_status,c.confirmed_amount,c.recovered_amount,c.identified_amount,
      c.due_date,c.source_reference,c.supplier_id,s.name supplier_name,
      e.first_name||' '||e.last_name owner_name,
      ROUND(MAX(0,c.confirmed_amount-c.recovered_amount),2) outstanding_amount
      FROM supplier_recovery_cases rc
      JOIN supplier_recoverable_claims c ON c.id=rc.claim_id
      JOIN suppliers s ON s.id=c.supplier_id
      LEFT JOIN employees e ON e.id=rc.owner_employee_id
      WHERE 1=1`;
    const args=[];
    if(req.query.status){sql+=' AND rc.status=?';args.push(req.query.status);}
    if(req.query.owner_employee_id){sql+=' AND rc.owner_employee_id=?';args.push(req.query.owner_employee_id);}
    sql+=` ORDER BY
      CASE rc.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      COALESCE(rc.next_follow_up_at,c.due_date,rc.created_at),rc.id DESC`;
    const {rows}=await db.execute({sql,args});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/from-claim/:claimId',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[claim]}=await tx.execute({sql:'SELECT * FROM supplier_recoverable_claims WHERE id=?',args:[req.params.claimId]});
    if(!claim)throw new Error('Recoverable claim not found');
    if(['recovered','cancelled'].includes(claim.status))throw new Error('Resolved recoverable does not need a recovery case');
    const {rows:[existing]}=await tx.execute({sql:'SELECT id FROM supplier_recovery_cases WHERE claim_id=?',args:[claim.id]});
    if(existing){
      await tx.commit();committed=true;
      return res.json(await getCase(db,existing.id));
    }
    const priority=validPriority(String(req.body?.priority||''))?String(req.body.priority):'medium';
    const ownerId=req.body?.owner_employee_id?Number(req.body.owner_employee_id):actor(req);
    if(ownerId){
      const {rows:[emp]}=await tx.execute({sql:'SELECT id FROM employees WHERE id=? AND active=1',args:[ownerId]});
      if(!emp)throw new Error('Recovery case owner must be an active employee');
    }
    const r=await tx.execute({sql:`INSERT INTO supplier_recovery_cases(
      claim_id,status,owner_employee_id,priority,next_follow_up_at,created_by_employee_id
    ) VALUES(?,?,?,?,?,?)`,args:[claim.id,'open',ownerId||null,priority,req.body?.next_follow_up_at||null,actor(req)]});
    const id=Number(r.lastInsertRowid);
    await tx.execute({sql:`INSERT INTO supplier_recovery_case_events(case_id,event_type,actor_employee_id,note)
      VALUES(?,?,?,?)`,args:[id,'opened',actor(req),req.body?.note||'Recovery case opened from supplier recoverable attention.']});
    await tx.commit();committed=true;
    res.status(201).json(await getCase(db,id));
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.patch('/:id',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const current=await getCase(tx,req.params.id);
    if(!current)throw new Error('Recovery case not found');
    const status=req.body?.status?String(req.body.status):current.status;
    if(!validStatus(status))throw new Error('Unsupported recovery case status');
    if(status==='closed'&&!['recovered','cancelled'].includes(current.claim_status))throw new Error('Recovery case cannot close before the linked recoverable is resolved');
    const priority=req.body?.priority?String(req.body.priority):current.priority;
    if(!validPriority(priority))throw new Error('Unsupported recovery case priority');
    const ownerId=req.body?.owner_employee_id===undefined?current.owner_employee_id:(req.body.owner_employee_id?Number(req.body.owner_employee_id):null);
    if(ownerId){
      const {rows:[emp]}=await tx.execute({sql:'SELECT id FROM employees WHERE id=? AND active=1',args:[ownerId]});
      if(!emp)throw new Error('Recovery case owner must be an active employee');
    }
    const promisedAmount=req.body?.promised_amount===undefined?current.promised_amount:money(req.body.promised_amount);
    const outstanding=money(Math.max(0,Number(current.confirmed_amount||0)-Number(current.recovered_amount||0)));
    if(promisedAmount!==null&&promisedAmount!==undefined&&(!Number.isFinite(promisedAmount)||promisedAmount<0))throw new Error('Promised amount must be zero or greater');
    if(promisedAmount&&promisedAmount>outstanding+0.01)throw new Error('Promised amount cannot exceed recoverable outstanding balance');
    const promiseDate=req.body?.promised_settlement_date===undefined?current.promised_settlement_date:(req.body.promised_settlement_date||null);
    if(status==='promised'&&(!promiseDate||!promisedAmount))throw new Error('Promised status requires settlement date and promised amount');
    const disputeReason=req.body?.dispute_reason===undefined?current.dispute_reason:(String(req.body.dispute_reason||'').trim()||null);
    if(status==='disputed'&&!disputeReason)throw new Error('Disputed status requires a reason');
    const escalationLevel=req.body?.escalation_level===undefined?Number(current.escalation_level||0):Number(req.body.escalation_level);
    if(!Number.isInteger(escalationLevel)||escalationLevel<0||escalationLevel>5)throw new Error('Escalation level must be an integer from 0 to 5');
    if(status==='escalated'&&escalationLevel<1)throw new Error('Escalated case requires escalation level 1 or higher');
    await tx.execute({sql:`UPDATE supplier_recovery_cases SET
      status=?,owner_employee_id=?,priority=?,next_follow_up_at=?,promised_settlement_date=?,promised_amount=?,
      dispute_reason=?,escalation_level=?,updated_at=CURRENT_TIMESTAMP,
      closed_at=CASE WHEN ?='closed' THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id=?`,args:[
      status,ownerId,priority,
      req.body?.next_follow_up_at===undefined?current.next_follow_up_at:(req.body.next_follow_up_at||null),
      promiseDate,promisedAmount,disputeReason,escalationLevel,status,current.id
    ]});
    const note=String(req.body?.note||'').trim()||null;
    await tx.execute({sql:`INSERT INTO supplier_recovery_case_events(
      case_id,event_type,actor_employee_id,note,promised_settlement_date,promised_amount,evidence_reference
    ) VALUES(?,?,?,?,?,?,?)`,args:[
      current.id,status,actor(req),note,promiseDate,promisedAmount,req.body?.evidence_reference||null
    ]});
    await tx.commit();committed=true;
    res.json(await getCase(db,current.id));
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.post('/:id/follow-ups',async(req,res)=>{
  try{
    const current=await getCase(db,req.params.id);
    if(!current)return res.status(404).json({error:'Recovery case not found'});
    if(current.status==='closed')return res.status(409).json({error:'Closed recovery case cannot receive follow-up notes'});
    const note=String(req.body?.note||'').trim();
    if(note.length<3)return res.status(400).json({error:'Follow-up note is required'});
    await db.execute({sql:`INSERT INTO supplier_recovery_case_events(case_id,event_type,actor_employee_id,note,evidence_reference)
      VALUES(?,?,?,?,?)`,args:[current.id,'follow_up',actor(req),note,req.body?.evidence_reference||null]});
    if(req.body?.next_follow_up_at!==undefined){
      await db.execute({sql:`UPDATE supplier_recovery_cases SET next_follow_up_at=?,status=CASE WHEN status='open' THEN 'follow_up' ELSE status END,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[req.body.next_follow_up_at||null,current.id]});
    }
    res.status(201).json(await getCase(db,current.id));
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/:id',async(req,res)=>{
  try{
    const row=await getCase(db,req.params.id);
    if(!row)return res.status(404).json({error:'Recovery case not found'});
    const {rows:events}=await db.execute({sql:'SELECT * FROM supplier_recovery_case_events WHERE case_id=? ORDER BY id',args:[row.id]});
    res.json({...row,events,outstanding_amount:money(Math.max(0,Number(row.confirmed_amount||0)-Number(row.recovered_amount||0)))});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
