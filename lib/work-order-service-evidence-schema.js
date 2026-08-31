'use strict';
const {db}=require('../database');

let readyPromise=null;

async function ensureColumn(name,definition){
  const {rows}=await db.execute({sql:'PRAGMA table_info(work_orders)',args:[]});
  if(rows.some(row=>String(row.name)===name))return;
  try{
    await db.execute({sql:`ALTER TABLE work_orders ADD COLUMN ${name} ${definition}`,args:[]});
  }catch(error){
    if(!/duplicate column/i.test(String(error?.message||'')))throw error;
  }
}

async function ensureWorkOrderServiceEvidenceSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureColumn('diagnosis','TEXT');
    await ensureColumn('repair_notes','TEXT');
  })().catch(error=>{readyPromise=null;throw error;});
  return readyPromise;
}

module.exports={ensureWorkOrderServiceEvidenceSchema};
