'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const r2=v=>Number(Number(v||0).toFixed(2));
async function financials(workOrderId){const {rows:[wo]}=await db.execute({sql:`SELECT wo.*,(SELECT COALESCE(SUM(total),0) FROM work_order_items WHERE work_order_id=wo.id) parts_total FROM work_orders wo WHERE wo.id=?`,args:[workOrderId]});if(!wo)return null;const gross=r2(Number(wo.estimate_labor||0)+Number(wo.estimate_consumables||0)+Number(wo.parts_total||0)),deposit=r2(wo.deposit_amount||0);return {wo,gross,deposit,maxConcession:r2(Math.max(0,gross-deposit))};}
router.use(async(req,res,next)=>{
  try{
    if(req.method!=='POST')return next();
    let m=req.path.match(/^\/(\d+)\/concessions\/?$/);
    if(m){const f=await financials(m[1]);if(!f)return res.status(404).json({error:'Work order not found'});const amount=r2(req.body?.proposed_amount);if(amount>f.maxConcession+0.01)return res.status(409).json({error:`The proposed concession cannot exceed the uncollected service balance (${f.maxConcession.toFixed(2)}). Amounts already paid require a controlled refund/credit workflow, not a settlement waiver.`,control:'service_concession_collectible_balance'});return next();}
    m=req.path.match(/^\/concessions\/(\d+)\/approve\/?$/);
    if(m){let c;try{const {rows:[row]}=await db.execute({sql:'SELECT * FROM service_concessions WHERE id=?',args:[m[1]]});c=row;}catch(e){return next();}if(!c)return next();const f=await financials(c.work_order_id);if(!f)return res.status(404).json({error:'Work order not found'});const {rows:[sum]}=await db.execute({sql:`SELECT COALESCE(SUM(approved_amount),0) total FROM service_concessions WHERE work_order_id=? AND status='approved'`,args:[c.work_order_id]});const approved=r2(req.body?.approved_amount??c.proposed_amount),existing=r2(sum?.total||0);if(existing+approved>f.maxConcession+0.01)return res.status(409).json({error:`Approved concessions cannot exceed the uncollected service balance (${f.maxConcession.toFixed(2)}). Any additional customer credit requires a controlled post-payment refund/credit process.`,control:'service_concession_collectible_balance'});return next();}
    next();
  }catch(e){res.status(500).json({error:'Service concession balance guard failed',detail:e.message});}
});
module.exports=router;
