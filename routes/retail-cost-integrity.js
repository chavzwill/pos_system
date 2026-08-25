const express=require('express');
const router=express.Router();
const {db}=require('../database');

let readyPromise=null;
async function ensureRetailCostIntegrity(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    const {rows:cols}=await db.execute({sql:'PRAGMA table_info(transaction_items)',args:[]});
    const names=new Set(cols.map(c=>String(c.name||'').toLowerCase()));
    if(!names.has('unit_cost_at_sale')){
      try{await db.execute({sql:'ALTER TABLE transaction_items ADD COLUMN unit_cost_at_sale REAL',args:[]});}catch(e){
        if(!String(e.message||'').toLowerCase().includes('duplicate column'))throw e;
      }
    }
    await db.execute({sql:`CREATE TRIGGER IF NOT EXISTS trg_transaction_item_cost_snapshot
      AFTER INSERT ON transaction_items
      WHEN NEW.product_id IS NOT NULL AND NEW.unit_cost_at_sale IS NULL
      BEGIN
        UPDATE transaction_items
        SET unit_cost_at_sale=(SELECT cost FROM products WHERE id=NEW.product_id)
        WHERE id=NEW.id;
      END`,args:[]});
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

router.use(async(req,res,next)=>{
  try{await ensureRetailCostIntegrity();next();}
  catch(e){res.status(500).json({error:'Retail cost evidence initialization failed',detail:e.message});}
});

module.exports=router;
module.exports.ensureRetailCostIntegrity=ensureRetailCostIntegrity;
