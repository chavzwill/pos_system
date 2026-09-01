'use strict';
const {db}=require('../database');

let readyPromise=null;
async function ensureTransactionCostEvidenceSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    const {rows:txCols}=await db.execute({sql:'PRAGMA table_info(transaction_items)',args:[]});
    const txNames=new Set(txCols.map(c=>String(c.name||'').toLowerCase()));
    if(!txNames.has('unit_cost_at_sale')){
      try{await db.execute({sql:'ALTER TABLE transaction_items ADD COLUMN unit_cost_at_sale REAL',args:[]});}
      catch(e){if(!String(e.message||'').toLowerCase().includes('duplicate column'))throw e;}
    }
    const {rows:returnTable}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name='return_items'",args:[]});
    if(returnTable.length){
      const {rows:returnCols}=await db.execute({sql:'PRAGMA table_info(return_items)',args:[]});
      const returnNames=new Set(returnCols.map(c=>String(c.name||'').toLowerCase()));
      if(!returnNames.has('unit_cost_at_return')){
        try{await db.execute({sql:'ALTER TABLE return_items ADD COLUMN unit_cost_at_return REAL',args:[]});}
        catch(e){if(!String(e.message||'').toLowerCase().includes('duplicate column'))throw e;}
      }
    }
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

module.exports={ensureTransactionCostEvidenceSchema};
