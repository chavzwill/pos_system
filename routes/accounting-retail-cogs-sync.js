'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');
const {ensureCostSnapshots}=require('./retail-cost-snapshot');
const {postSourceJournal}=require('../lib/accounting-posting');

const r2=v=>Number(Number(v||0).toFixed(2));
async function syncRetailCogs(actorId){
  await ensureCostSnapshots();
  const stats={posted:0,existing:0,blocked:0,blocked_transactions:[],complete_cost_transactions:0,partial_cost_transactions:0};
  const {rows:groups}=await db.execute({sql:`SELECT s.transaction_id,t.transaction_number,t.branch_id,t.created_at,t.status,
      COUNT(*) line_count,SUM(CASE WHEN s.auto_post_eligible=1 THEN 1 ELSE 0 END) eligible_lines,
      SUM(CASE WHEN s.evidence_grade='complete' THEN 1 ELSE 0 END) complete_lines,
      SUM(CASE WHEN s.evidence_grade='partial' THEN 1 ELSE 0 END) partial_lines,
      SUM(CASE WHEN s.evidence_grade='blocked' THEN 1 ELSE 0 END) blocked_lines,
      ROUND(SUM(CASE WHEN s.auto_post_eligible=1 THEN COALESCE(s.total_cost,0) ELSE 0 END),2) eligible_cost
    FROM retail_transaction_cost_snapshots s JOIN transactions t ON t.id=s.transaction_id
    WHERE t.status='completed'
    GROUP BY s.transaction_id,t.transaction_number,t.branch_id,t.created_at,t.status ORDER BY s.transaction_id`,args:[]});
  for(const g of groups){
    const lineCount=Number(g.line_count||0),eligible=Number(g.eligible_lines||0),complete=Number(g.complete_lines||0),partial=Number(g.partial_lines||0),blocked=Number(g.blocked_lines||0);
    if(lineCount>0&&complete===lineCount)stats.complete_cost_transactions++;
    else if(partial>0)stats.partial_cost_transactions++;
    if(!lineCount||eligible!==lineCount){stats.blocked++;stats.blocked_transactions.push({transaction_id:g.transaction_id,transaction_number:g.transaction_number,line_count:lineCount,complete_lines:complete,partial_lines:partial,blocked_lines:blocked,reason:'Automatic COGS requires complete tracked inventory cost evidence for every sold line. Partial catalog snapshots remain historical evidence but are not auto-posted as authoritative COGS.'});continue;}
    const cost=r2(g.eligible_cost);if(cost<0){stats.blocked++;stats.blocked_transactions.push({transaction_id:g.transaction_id,transaction_number:g.transaction_number,reason:'Negative retail COGS evidence is invalid.'});continue;}if(cost===0)continue;
    try{
      const j=await postSourceJournal({sourceType:'retail_cogs',sourceId:g.transaction_id,sourceReference:g.transaction_number,entryDate:String(g.created_at||new Date().toISOString()).slice(0,10),description:`Retail COGS ${g.transaction_number}`,branchId:g.branch_id,actorId,lines:[{code:'5000',debit:cost,credit:0,description:'Cost of goods sold from sale-time tracked inventory evidence'},{code:'1200',debit:0,credit:cost,description:'Reduce inventory at sale-time tracked cost'}]});stats[j.existing?'existing':'posted']++;
    }catch(e){stats.blocked++;stats.blocked_transactions.push({transaction_id:g.transaction_id,transaction_number:g.transaction_number,reason:e.message});}
  }
  return stats;
}
router.post('/sync',requireAnyPermission('reports_financial','reports'),async(req,res,next)=>{
  try{
    const stats=await syncRetailCogs(req.employee?.id||req.user?.employee_id||null);req.retailCogsSyncStats=stats;
    const original=res.json.bind(res);res.json=function(payload){if(payload&&typeof payload==='object'&&!Array.isArray(payload)){payload.retail_cogs_sync=stats;if(payload.stats&&typeof payload.stats==='object')payload.stats.retail_cogs=stats;}return original(payload);};next();
  }catch(e){res.status(500).json({error:'Retail COGS synchronization failed',detail:e.message});}
});
module.exports=router;
module.exports.syncRetailCogs=syncRetailCogs;
