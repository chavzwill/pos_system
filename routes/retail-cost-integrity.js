const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureInventoryCostLayers}=require('../lib/inventory-cost-layers');

let readyPromise=null;
async function ensureRetailCostIntegrity(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    const {rows:txCols}=await db.execute({sql:'PRAGMA table_info(transaction_items)',args:[]});
    const txNames=new Set(txCols.map(c=>String(c.name||'').toLowerCase()));
    if(!txNames.has('unit_cost_at_sale')){
      try{await db.execute({sql:'ALTER TABLE transaction_items ADD COLUMN unit_cost_at_sale REAL',args:[]});}catch(e){
        if(!String(e.message||'').toLowerCase().includes('duplicate column'))throw e;
      }
    }

    const {rows:returnTable}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name='return_items'",args:[]});
    if(returnTable.length){
      const {rows:returnCols}=await db.execute({sql:'PRAGMA table_info(return_items)',args:[]});
      const returnNames=new Set(returnCols.map(c=>String(c.name||'').toLowerCase()));
      if(!returnNames.has('unit_cost_at_return')){
        try{await db.execute({sql:'ALTER TABLE return_items ADD COLUMN unit_cost_at_return REAL',args:[]});}catch(e){
          if(!String(e.message||'').toLowerCase().includes('duplicate column'))throw e;
        }
      }
      await db.execute({sql:`CREATE TRIGGER IF NOT EXISTS trg_return_item_cost_snapshot
        AFTER INSERT ON return_items
        WHEN NEW.transaction_item_id IS NOT NULL AND NEW.unit_cost_at_return IS NULL
        BEGIN
          UPDATE return_items
          SET unit_cost_at_return=(SELECT unit_cost_at_sale FROM transaction_items WHERE id=NEW.transaction_item_id)
          WHERE id=NEW.id;
        END`,args:[]});
    }

    await ensureInventoryCostLayers();
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

router.use(async(req,res,next)=>{
  try{await ensureRetailCostIntegrity();next();}
  catch(e){res.status(500).json({error:'Retail cost evidence initialization failed',detail:e.message});}
});

module.exports=router;
module.exports.ensureRetailCostIntegrity=ensureRetailCostIntegrity;
