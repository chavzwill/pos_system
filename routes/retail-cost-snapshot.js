'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

let readyPromise=null;
const r2=v=>Number(Number(v||0).toFixed(2));
async function ensureCostSnapshots(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS retail_transaction_cost_snapshots(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      transaction_item_id INTEGER REFERENCES transaction_items(id),
      line_index INTEGER NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      branch_id INTEGER REFERENCES branches(id),
      quantity REAL NOT NULL,
      unit_cost REAL,
      total_cost REAL,
      cost_basis TEXT NOT NULL,
      evidence_grade TEXT NOT NULL,
      auto_post_eligible INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(transaction_id,line_index)
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_retail_cost_snapshot_tx ON retail_transaction_cost_snapshots(transaction_id,line_index)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_retail_cost_snapshot_product ON retail_transaction_cost_snapshots(product_id,captured_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function costEvidence(productId,branchId){
  const {rows:[product]}=await db.execute({sql:'SELECT id,name,sku,cost FROM products WHERE id=?',args:[productId]});
  if(!product)return {unit_cost:null,basis:'missing_product',grade:'blocked',auto_post_eligible:0};
  if(branchId){
    try{
      const {rows:[pool]}=await db.execute({sql:'SELECT tracked_qty,tracked_value,legacy_unlayered_qty FROM inventory_cost_pools WHERE product_id=? AND branch_key=?',args:[productId,branchId]});
      const tq=Number(pool?.tracked_qty||0),tv=Number(pool?.tracked_value||0),legacy=Number(pool?.legacy_unlayered_qty||0);
      if(tq>0&&tv>=0&&legacy<=1e-9){
        return {unit_cost:r2(tv/tq),basis:'current_tracked_inventory_pool_at_sale',grade:'complete',auto_post_eligible:1,tracked_qty:tq,tracked_value:r2(tv),legacy_unlayered_qty:legacy};
      }
    }catch(e){}
  }
  const catalog=Number(product.cost);
  if(Number.isFinite(catalog)&&catalog>=0)return {unit_cost:r2(catalog),basis:'catalog_cost_snapshot_at_sale',grade:'partial',auto_post_eligible:0};
  return {unit_cost:null,basis:'cost_evidence_missing',grade:'blocked',auto_post_eligible:0};
}
async function prepare(req){
  await ensureCostSnapshots();
  const items=Array.isArray(req.body?.items)?req.body.items:[],branchId=Number(req.body?.branch_id)||null,lines=[];
  for(let i=0;i<items.length;i++){
    const line=items[i],productId=Number(line.product_id),quantity=Number(line.quantity);
    if(!(productId>0&&quantity>0))continue;
    const ev=await costEvidence(productId,branchId);
    lines.push({line_index:i,product_id:productId,branch_id:branchId,quantity,unit_cost:ev.unit_cost,total_cost:ev.unit_cost==null?null:r2(ev.unit_cost*quantity),cost_basis:ev.basis,evidence_grade:ev.grade,auto_post_eligible:ev.auto_post_eligible,evidence:ev});
  }
  req.retailCostSnapshotEvidence=lines;
}
async function persist(req,payload){
  const lines=req.retailCostSnapshotEvidence||[];if(!payload?.id||!lines.length)return;
  const saved=Array.isArray(payload.items)?payload.items:[];
  const tx=await db.transaction('write');let committed=false;
  try{
    for(const line of lines){
      const savedLine=saved[line.line_index]||null;
      await tx.execute({sql:`INSERT OR IGNORE INTO retail_transaction_cost_snapshots(transaction_id,transaction_item_id,line_index,product_id,branch_id,quantity,unit_cost,total_cost,cost_basis,evidence_grade,auto_post_eligible,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,args:[payload.id,savedLine?.id||null,line.line_index,line.product_id,line.branch_id,line.quantity,line.unit_cost,line.total_cost,line.cost_basis,line.evidence_grade,line.auto_post_eligible,JSON.stringify(line.evidence||{})]});
    }
    await tx.commit();committed=true;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}
router.use(async(req,res,next)=>{try{await ensureCostSnapshots();next();}catch(e){res.status(500).json({error:'Retail cost snapshot controls failed to initialize',detail:e.message});}});
router.post('/',requirePermission('pos'),async(req,res,next)=>{
  try{await prepare(req);}catch(e){return res.status(500).json({error:'Unable to preserve sale-time cost evidence',detail:e.message});}
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id)return persist(req,payload).then(()=>originalJson({...payload,cost_evidence_captured:true})).catch(e=>{if(!res.headersSent){res.status(500);return originalJson({error:'Sale posted but sale-time cost evidence failed to persist; reconciliation required',transaction_id:payload.id,detail:e.message});}});return originalJson(payload);};
  next();
});
module.exports=router;
module.exports.ensureCostSnapshots=ensureCostSnapshots;
