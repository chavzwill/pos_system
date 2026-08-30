'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');

router.use(requireAnyPermission('reports_financial','drawers_manage','reports'));
let ready=false;
async function ensureSchema(){
 if(ready)return;
 await db.batch([
  {sql:`CREATE TABLE IF NOT EXISTS settlement_batches (id INTEGER PRIMARY KEY AUTOINCREMENT,settlement_account_id INTEGER NOT NULL,branch_id INTEGER,settlement_date TEXT NOT NULL,reference TEXT,gross_amount REAL NOT NULL DEFAULT 0,fees REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'open',notes TEXT,created_by_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,reconciled_at TEXT,UNIQUE(settlement_account_id,reference))`},
  {sql:`CREATE TABLE IF NOT EXISTS settlement_matches (id INTEGER PRIMARY KEY AUTOINCREMENT,settlement_batch_id INTEGER NOT NULL,source_type TEXT NOT NULL,source_id INTEGER NOT NULL,source_amount REAL NOT NULL,matched_amount REAL NOT NULL,created_by_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(settlement_batch_id,source_type,source_id))`},
  {sql:`CREATE TABLE IF NOT EXISTS settlement_events (id INTEGER PRIMARY KEY AUTOINCREMENT,settlement_batch_id INTEGER NOT NULL,event_type TEXT NOT NULL,details TEXT,actor_employee_id INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`}
 ],'write');
 ready=true;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Settlement financial guard initialization failed',detail:e.message});}});
function num(v){const n=Number(v);return Number.isFinite(n)?n:0;}
function actor(req){return req.employee?.id||req.user?.employee_id||null;}

// Electronic POS evidence represents gross customer tender. Processor fees are
// a separate expense and therefore must not reduce the amount matched back to
// the source transactions. A 100 gross / 3 fee / 97 net batch matches 100 of
// transaction clearing, then Accounting posts Dr Bank 97, Dr Fees 3, Cr
// Electronic Settlement Clearing 100.
router.post('/batches/:id/matches',async(req,res)=>{
 try{
  const b=req.body||{};
  if(b.source_type!=='transaction')return res.status(400).json({error:'Only transaction settlement matching is supported in this phase'});
  const {rows:[batch]}=await db.execute({sql:'SELECT * FROM settlement_batches WHERE id=?',args:[req.params.id]});
  if(!batch)return res.status(404).json({error:'Settlement batch not found'});
  if(batch.status==='reconciled')return res.status(409).json({error:'Reconciled batches are locked'});
  const gross=num(batch.gross_amount),fees=num(batch.fees),net=num(batch.net_amount);
  if(gross<0||fees<0||net<0||Math.abs(Number((gross-fees-net).toFixed(2)))>0.01)return res.status(409).json({error:'Settlement batch gross, fees and net do not reconcile',gross_amount:gross,fees,net_amount:net});
  const {rows:[tx]}=await db.execute({sql:`SELECT t.id,COALESCE(SUM(CASE WHEN LOWER(tp.payment_method) IN ('card','credit_card','debit_card','direct_deposit','bank_transfer') THEN tp.amount ELSE 0 END),0) amount FROM transactions t LEFT JOIN transaction_payments tp ON tp.transaction_id=t.id WHERE t.id=? AND t.status='completed' GROUP BY t.id`,args:[b.source_id]});
  if(!tx)return res.status(404).json({error:'Eligible transaction not found'});
  const {rows:[sourceMatched]}=await db.execute({sql:`SELECT COALESCE(SUM(matched_amount),0) matched FROM settlement_matches WHERE source_type='transaction' AND source_id=?`,args:[tx.id]});
  const remainingSource=num(tx.amount)-num(sourceMatched?.matched);
  const {rows:[batchMatched]}=await db.execute({sql:`SELECT COALESCE(SUM(matched_amount),0) matched FROM settlement_matches WHERE settlement_batch_id=?`,args:[batch.id]});
  const remainingBatch=gross-num(batchMatched?.matched);
  const requested=b.matched_amount==null?Math.min(remainingSource,remainingBatch):num(b.matched_amount);
  if(requested<=0||requested>remainingSource+0.001||requested>remainingBatch+0.001)return res.status(409).json({error:'Match exceeds available transaction or gross settlement balance'});
  await db.execute({sql:`INSERT INTO settlement_matches(settlement_batch_id,source_type,source_id,source_amount,matched_amount,created_by_employee_id) VALUES(?,?,?,?,?,?)`,args:[batch.id,'transaction',tx.id,num(tx.amount),requested,actor(req)]});
  await db.execute({sql:`INSERT INTO settlement_events(settlement_batch_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[batch.id,'matched',`Matched gross electronic transaction ${tx.id} for ${requested.toFixed(2)}`,actor(req)]});
  res.status(201).json({success:true,matched_amount:requested,matching_basis:'gross_electronic_tender'});
 }catch(e){res.status(400).json({error:e.message});}
});

router.post('/batches/:id/reconcile',async(req,res)=>{
 try{
  const {rows:[batch]}=await db.execute({sql:'SELECT * FROM settlement_batches WHERE id=?',args:[req.params.id]});
  if(!batch)return res.status(404).json({error:'Settlement batch not found'});
  if(batch.status==='reconciled')return res.json({success:true,variance:0,already_reconciled:true});
  const gross=num(batch.gross_amount),fees=num(batch.fees),net=num(batch.net_amount);
  const componentVariance=Number((gross-fees-net).toFixed(2));
  const tolerance=Math.abs(num(req.body?.tolerance||0.01));
  if(Math.abs(componentVariance)>tolerance)return res.status(409).json({error:`Settlement components do not reconcile: gross - fees - net = ${componentVariance.toFixed(2)}`,component_variance:componentVariance});
  const {rows:[m]}=await db.execute({sql:'SELECT COALESCE(SUM(matched_amount),0) matched FROM settlement_matches WHERE settlement_batch_id=?',args:[batch.id]});
  const sourceVariance=Number((gross-num(m?.matched)).toFixed(2));
  if(Math.abs(sourceVariance)>tolerance)return res.status(409).json({error:`Gross settlement variance ${sourceVariance.toFixed(2)} exceeds tolerance ${tolerance.toFixed(2)}`,variance:sourceVariance,matching_basis:'gross_electronic_tender'});
  await db.execute({sql:"UPDATE settlement_batches SET status='reconciled',reconciled_at=CURRENT_TIMESTAMP WHERE id=?",args:[batch.id]});
  await db.execute({sql:`INSERT INTO settlement_events(settlement_batch_id,event_type,details,actor_employee_id) VALUES(?,?,?,?)`,args:[batch.id,'reconciled',`Gross tender reconciled with source variance ${sourceVariance.toFixed(2)}; processor fees ${fees.toFixed(2)} explain net deposit ${net.toFixed(2)}`,actor(req)]});
  res.json({success:true,variance:sourceVariance,gross_amount:gross,fees,net_amount:net,matching_basis:'gross_electronic_tender'});
 }catch(e){res.status(400).json({error:e.message});}
});

module.exports=router;
