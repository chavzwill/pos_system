'use strict';
const {db}=require('../database');
const core=require('./consumable-corrections');
const {sql,fail}=core;
const {postSourceJournal}=require('./accounting-posting');
let ready;
async function ensureRecoveryTables(){
 if(ready)return ready;
 ready=db.batch([
  sql(`CREATE TABLE IF NOT EXISTS consumable_issue_returns(id INTEGER PRIMARY KEY AUTOINCREMENT,issue_movement_id INTEGER NOT NULL REFERENCES consumable_movements(id),quantity INTEGER NOT NULL CHECK(quantity>0),value_cents INTEGER NOT NULL CHECK(value_cents>=0),reason TEXT NOT NULL,actor_employee_id INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
  sql(`CREATE INDEX IF NOT EXISTS idx_consumable_issue_returns_source ON consumable_issue_returns(issue_movement_id)`),
  ...['UPDATE','DELETE'].map(op=>sql(`CREATE TRIGGER IF NOT EXISTS consumable_issue_returns_no_${op.toLowerCase()} BEFORE ${op} ON consumable_issue_returns BEGIN SELECT RAISE(ABORT,'Consumable issue return evidence is immutable'); END`))
 ],'write').catch(e=>{ready=null;throw e;});return ready;
}
async function ensureConsumableRecoverySchema(){await core.ensureConsumableCorrectionsSchema();await ensureRecoveryTables();}
async function issue(ex,id){const m=(await ex.execute(sql("SELECT * FROM consumable_movements WHERE id=? AND action='issue'",[id]))).rows[0];if(!m)throw fail('ISSUE_NOT_FOUND','Select an original consumable issue',404);return m;}
async function returnUnused(ex,m,quantity,reason,actor){
 const prior=(await ex.execute(sql('SELECT COALESCE(SUM(quantity),0) quantity,COALESCE(SUM(value_cents),0) value_cents FROM consumable_issue_returns WHERE issue_movement_id=?',[m.id]))).rows[0];
 const used=Number(prior.quantity),qty=Number(quantity);
 if(!Number.isSafeInteger(qty)||qty<=0)throw fail('INVALID_QUANTITY','Return quantity must be a positive whole number',400);
 if(used+qty>Number(m.quantity))throw fail('ISSUE_RETURN_CEILING','Unused returns exceed the original issued quantity');
 const value=core.proportional(m.value_cents,used+qty,m.quantity)-core.proportional(m.value_cents,used,m.quantity);
 const b=(await ex.execute(sql('SELECT qty_on_hand,value_cents FROM consumable_balances WHERE branch_id=? AND consumable_id=?',[m.branch_id,m.consumable_id]))).rows[0];
 if(!Number.isSafeInteger(Number(b?.qty_on_hand||0)+qty)||!Number.isSafeInteger(Number(b?.value_cents||0)+value))throw fail('UNSAFE_BALANCE','Consumable balance exceeds safe limits');
 const inserted=await ex.execute(sql('INSERT INTO consumable_issue_returns(issue_movement_id,quantity,value_cents,reason,actor_employee_id) VALUES(?,?,?,?,?)',[m.id,qty,value,reason,actor]));
 await ex.execute(sql('INSERT INTO consumable_balances(consumable_id,branch_id,qty_on_hand,value_cents) VALUES(?,?,?,?) ON CONFLICT(consumable_id,branch_id) DO UPDATE SET qty_on_hand=qty_on_hand+excluded.qty_on_hand,value_cents=value_cents+excluded.value_cents,updated_at=CURRENT_TIMESTAMP',[m.consumable_id,m.branch_id,qty,value]));
 const row=(await ex.execute(sql('SELECT * FROM consumable_issue_returns WHERE id=?',[Number(inserted.lastInsertRowid)]))).rows[0];
 await postIssueReturnJournal(ex,row,actor);await core.event(ex,'issue',m.id,'unused_returned',actor,{issue_return_id:row.id,quantity:qty,value_cents:value,reason});return row;
}
async function postIssueReturnJournal(ex,row,actor){
 const m=await issue(ex,row.issue_movement_id),value=Number(row.value_cents);
 if(!Number.isSafeInteger(value)||value<0)throw fail('INVALID_VALUE','Invalid unused return carrying value');if(!value)return null;
 return postSourceJournal({executor:ex,sourceType:'consumable_issue_return',sourceId:row.id,sourceReference:'CIR-'+row.id,entryDate:String(row.created_at).slice(0,10),description:'Unused consumables returned from issue CM-'+m.id,branchId:m.branch_id,actorId:actor,lines:[{code:'1280',debit:value/100,credit:0},{code:'5460',debit:0,credit:value/100}]});
}
module.exports={ensureRecoveryTables,ensureConsumableRecoverySchema,issue,returnUnused,postIssueReturnJournal};
