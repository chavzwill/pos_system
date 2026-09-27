'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission,requirePermission}=require('../lib/permissions');
const statements=require('./supplier-statements');
const {money}=require('../lib/supplier-recoverables');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    if(statements.ensureSchema)await statements.ensureSchema();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_statement_exceptions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        statement_id INTEGER NOT NULL REFERENCES supplier_statements(id),
        exception_type TEXT NOT NULL,
        source_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        owner_employee_id INTEGER REFERENCES employees(id),
        priority TEXT NOT NULL DEFAULT 'medium',
        due_at TEXT,
        amount REAL NOT NULL DEFAULT 0,
        summary TEXT NOT NULL,
        resolution_type TEXT,
        resolution_reason TEXT,
        resolved_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        UNIQUE(statement_id,exception_type,source_key)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS supplier_statement_exception_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exception_id INTEGER NOT NULL REFERENCES supplier_statement_exceptions(id),
        event_type TEXT NOT NULL,
        actor_employee_id INTEGER REFERENCES employees(id),
        note TEXT,
        evidence_reference TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_statement_exceptions_status ON supplier_statement_exceptions(status,priority,due_at)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_statement_exception_events ON supplier_statement_exception_events(exception_id,created_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}
function validPriority(v){return ['low','medium','high','critical'].includes(v);}
function ageDays(date){const t=new Date(date||'').getTime();return Number.isFinite(t)?Math.max(0,Math.floor((Date.now()-t)/86400000)):0;}
async function getException(executor,id){
  const {rows:[row]}=await executor.execute({sql:`SELECT e.*,st.supplier_id,st.period_end,st.statement_reference,s.name supplier_name,
    emp.first_name||' '||emp.last_name owner_name
    FROM supplier_statement_exceptions e
    JOIN supplier_statements st ON st.id=e.statement_id
    JOIN suppliers s ON s.id=st.supplier_id
    LEFT JOIN employees emp ON emp.id=e.owner_employee_id
    WHERE e.id=?`,args:[id]});
  return row||null;
}
function expectedExceptions(rec){
  const rows=[];
  if(Math.abs(Number(rec.variance||0))>0.01){
    rows.push({
      exception_type:'balance_variance',source_key:'balance',
      amount:money(Math.abs(Number(rec.variance||0))),
      summary:`Supplier statement balance differs from internal AP by ${money(Number(rec.variance||0)).toFixed(2)}.`
    });
  }
  for(const x of rec.missing_internal_credit_notes||[]){
    rows.push({
      exception_type:'statement_credit_missing_internally',source_key:'statement-line:'+x.statement_line_id,
      amount:money(Math.abs(Number(x.amount||0))),
      summary:`Supplier statement credit ${x.reference||('#'+x.statement_line_id)} is missing from the internal Credit Notes register.`
    });
  }
  for(const x of rec.internal_credit_notes_not_on_statement||[]){
    rows.push({
      exception_type:'internal_credit_missing_on_statement',source_key:'credit-note:'+x.credit_note_id,
      amount:money(Math.abs(Number(x.amount||0))),
      summary:`Internal credit note ${x.credit_note_number} is not evidenced on the supplier statement.`
    });
  }
  return rows;
}

router.use(requireAnyPermission('purchasing','reports_financial','accounts'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Supplier statement exception initialization failed'});}});

router.post('/refresh/:statementId',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const rec=await statements.reconcileStatement(req.params.statementId);
    if(!rec)throw new Error('Supplier statement not found');
    const expected=expectedExceptions(rec);
    const expectedKeys=new Set(expected.map(x=>x.exception_type+'|'+x.source_key));
    for(const x of expected){
      const priority=x.amount>=100000?'critical':x.amount>=25000?'high':x.amount>=5000?'medium':'low';
      await tx.execute({sql:`INSERT INTO supplier_statement_exceptions(
        statement_id,exception_type,source_key,status,owner_employee_id,priority,due_at,amount,summary
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(statement_id,exception_type,source_key) DO UPDATE SET
        amount=excluded.amount,summary=excluded.summary,
        status=CASE WHEN supplier_statement_exceptions.status='resolved' THEN 'open' ELSE supplier_statement_exceptions.status END,
        updated_at=CURRENT_TIMESTAMP`,args:[
        rec.statement_id,x.exception_type,x.source_key,'open',actor(req),priority,
        new Date(Date.now()+7*86400000).toISOString(),x.amount,x.summary
      ]});
    }
    const {rows:open}=await tx.execute({sql:`SELECT * FROM supplier_statement_exceptions
      WHERE statement_id=? AND status IN ('open','investigating')`,args:[rec.statement_id]});
    for(const x of open){
      const key=x.exception_type+'|'+x.source_key;
      if(!expectedKeys.has(key)){
        await tx.execute({sql:`UPDATE supplier_statement_exceptions SET status='resolved',resolution_type='underlying_reconciled',
          resolution_reason='Underlying statement reconciliation no longer reports this exception.',
          resolved_by_employee_id=?,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[actor(req),x.id]});
        await tx.execute({sql:`INSERT INTO supplier_statement_exception_events(exception_id,event_type,actor_employee_id,note)
          VALUES(?,?,?,?)`,args:[x.id,'resolved',actor(req),'Automatically resolved because the authoritative reconciliation no longer reports this exception.']});
      }
    }
    await tx.commit();committed=true;
    const {rows}=await db.execute({sql:`SELECT e.*,s.name supplier_name,st.period_end,st.statement_reference,
      emp.first_name||' '||emp.last_name owner_name
      FROM supplier_statement_exceptions e JOIN supplier_statements st ON st.id=e.statement_id
      JOIN suppliers s ON s.id=st.supplier_id LEFT JOIN employees emp ON emp.id=e.owner_employee_id
      WHERE e.statement_id=? ORDER BY CASE e.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END,
      CASE e.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,e.id`,args:[rec.statement_id]});
    res.json({reconciliation:rec,exceptions:rows});
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.get('/',async(req,res)=>{
  try{
    let sql=`SELECT e.*,s.name supplier_name,st.period_end,st.statement_reference,
      emp.first_name||' '||emp.last_name owner_name
      FROM supplier_statement_exceptions e JOIN supplier_statements st ON st.id=e.statement_id
      JOIN suppliers s ON s.id=st.supplier_id LEFT JOIN employees emp ON emp.id=e.owner_employee_id
      WHERE 1=1`;const args=[];
    if(req.query.status){sql+=' AND e.status=?';args.push(req.query.status);}
    if(req.query.owner_employee_id){sql+=' AND e.owner_employee_id=?';args.push(req.query.owner_employee_id);}
    sql+=` ORDER BY CASE e.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END,
      CASE e.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      COALESCE(e.due_at,e.created_at),e.id DESC`;
    const {rows}=await db.execute({sql,args});
    res.json(rows.map(x=>({...x,age_days:ageDays(x.created_at),overdue:!!(x.due_at&&new Date(x.due_at).getTime()<Date.now()&&!['resolved','accepted_difference'].includes(x.status))})));
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/:id',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const current=await getException(tx,req.params.id);if(!current)throw new Error('Statement exception not found');
    if(['resolved','accepted_difference'].includes(current.status))throw new Error('Closed statement exception cannot be edited');
    const status=req.body?.status?String(req.body.status):current.status;
    if(!['open','investigating'].includes(status))throw new Error('Use the controlled resolution endpoints to close a statement exception');
    const priority=req.body?.priority?String(req.body.priority):current.priority;
    if(!validPriority(priority))throw new Error('Unsupported exception priority');
    const ownerId=req.body?.owner_employee_id===undefined?current.owner_employee_id:(req.body.owner_employee_id?Number(req.body.owner_employee_id):null);
    if(ownerId){
      const {rows:[emp]}=await tx.execute({sql:'SELECT id FROM employees WHERE id=? AND active=1',args:[ownerId]});
      if(!emp)throw new Error('Exception owner must be an active employee');
    }
    await tx.execute({sql:`UPDATE supplier_statement_exceptions SET status=?,owner_employee_id=?,priority=?,due_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      args:[status,ownerId,priority,req.body?.due_at===undefined?current.due_at:(req.body.due_at||null),current.id]});
    const note=String(req.body?.note||'').trim();
    if(note)await tx.execute({sql:`INSERT INTO supplier_statement_exception_events(exception_id,event_type,actor_employee_id,note,evidence_reference)
      VALUES(?,?,?,?,?)`,args:[current.id,status,actor(req),note,req.body?.evidence_reference||null]});
    await tx.commit();committed=true;
    res.json(await getException(db,current.id));
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.post('/:id/resolve',async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const current=await getException(tx,req.params.id);if(!current)throw new Error('Statement exception not found');
    if(['resolved','accepted_difference'].includes(current.status))throw new Error('Statement exception is already closed');
    const rec=await statements.reconcileStatement(current.statement_id);
    const stillOpen=expectedExceptions(rec).some(x=>x.exception_type===current.exception_type&&x.source_key===current.source_key);
    if(stillOpen)throw new Error('Statement exception cannot be resolved while the authoritative reconciliation still reports the mismatch');
    const note=String(req.body?.note||'').trim();
    await tx.execute({sql:`UPDATE supplier_statement_exceptions SET status='resolved',resolution_type='underlying_reconciled',
      resolution_reason=?,resolved_by_employee_id=?,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      args:[note||'Underlying reconciliation is clean.',actor(req),current.id]});
    await tx.execute({sql:`INSERT INTO supplier_statement_exception_events(exception_id,event_type,actor_employee_id,note,evidence_reference)
      VALUES(?,?,?,?,?)`,args:[current.id,'resolved',actor(req),note||'Underlying reconciliation is clean.',req.body?.evidence_reference||null]});
    await tx.commit();committed=true;
    res.json(await getException(db,current.id));
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.post('/:id/accept-difference',requirePermission('reports_financial'),async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const current=await getException(tx,req.params.id);if(!current)throw new Error('Statement exception not found');
    if(['resolved','accepted_difference'].includes(current.status))throw new Error('Statement exception is already closed');
    const reason=String(req.body?.reason||'').trim(),evidence=String(req.body?.evidence_reference||'').trim();
    if(reason.length<10)throw new Error('Accepted difference requires a meaningful finance reason');
    if(!evidence)throw new Error('Accepted difference requires an evidence reference');
    await tx.execute({sql:`UPDATE supplier_statement_exceptions SET status='accepted_difference',resolution_type='accepted_difference',
      resolution_reason=?,resolved_by_employee_id=?,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      args:[reason,actor(req),current.id]});
    await tx.execute({sql:`INSERT INTO supplier_statement_exception_events(exception_id,event_type,actor_employee_id,note,evidence_reference)
      VALUES(?,?,?,?,?)`,args:[current.id,'accepted_difference',actor(req),reason,evidence]});
    await tx.commit();committed=true;
    res.json(await getException(db,current.id));
  }catch(e){if(!committed)try{await tx.rollback();}catch{}res.status(400).json({error:e.message});}
});

router.post('/:id/notes',async(req,res)=>{
  try{
    const current=await getException(db,req.params.id);if(!current)return res.status(404).json({error:'Statement exception not found'});
    if(['resolved','accepted_difference'].includes(current.status))return res.status(409).json({error:'Closed statement exception cannot receive investigation notes'});
    const note=String(req.body?.note||'').trim();if(note.length<3)return res.status(400).json({error:'Investigation note is required'});
    await db.execute({sql:`INSERT INTO supplier_statement_exception_events(exception_id,event_type,actor_employee_id,note,evidence_reference)
      VALUES(?,?,?,?,?)`,args:[current.id,'note',actor(req),note,req.body?.evidence_reference||null]});
    res.status(201).json(await getException(db,current.id));
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/:id',async(req,res)=>{
  try{
    const row=await getException(db,req.params.id);if(!row)return res.status(404).json({error:'Statement exception not found'});
    const {rows:events}=await db.execute({sql:'SELECT * FROM supplier_statement_exception_events WHERE exception_id=? ORDER BY id',args:[row.id]});
    res.json({...row,events});
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
module.exports.expectedExceptions=expectedExceptions;
