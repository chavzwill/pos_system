'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureUomSchema,resolveProductUom,toBaseQuantity,snapshot}=require('../lib/unit-of-measure');

async function normalize(req){
  await ensureUomSchema();
  const transactionId=Number(req.params.id),items=Array.isArray(req.body?.items)?req.body.items:[];if(!transactionId||!items.length)return;
  const {rows:txItems}=await db.execute({sql:'SELECT id,product_id,quantity,unit_price FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[transactionId]});
  const {rows:usage}=await db.execute({sql:"SELECT * FROM uom_usage_snapshots WHERE source_type='transaction' AND source_id=? ORDER BY id",args:[String(transactionId)]});
  const evidence=[];
  for(const line of items){
    const txItem=txItems.find(x=>Number(x.id)===Number(line.transaction_item_id));if(!txItem?.product_id)continue;
    const saleSnap=usage.find(x=>String(x.source_line_id)===String(txItem.id))||usage.find(x=>Number(x.product_id)===Number(txItem.product_id));
    const explicitUom=String(line.uom_code||line.unit||'').trim();
    const requestedUom=explicitUom||(line.inherit_sale_uom===true?saleSnap?.entered_uom:null)||saleSnap?.base_uom||null;
    const enteredQuantity=Number(line.quantity);const resolved=await resolveProductUom(db,txItem.product_id,requestedUom,'movement');
    const baseQuantity=toBaseQuantity(enteredQuantity,resolved);
    if(baseQuantity-Number(txItem.quantity||0)>1e-9)throw new Error(`Return quantity converts to ${baseQuantity} ${resolved.profile.base_uom}, exceeding the original sold quantity`);
    line.entered_quantity=enteredQuantity;line.entered_uom=resolved.uom_code;line.uom_factor_to_base=Number(resolved.factor_to_base);line.base_uom=resolved.profile.base_uom;line.quantity=baseQuantity;
    if(Array.isArray(line.lots)&&explicitUom&&Number(resolved.factor_to_base)!==1){
      const lotTotal=line.lots.reduce((s,x)=>s+Number(x.quantity||0),0);if(Math.abs(lotTotal-enteredQuantity)<=1e-9)line.lots=line.lots.map(x=>({...x,quantity:Number((Number(x.quantity||0)*Number(resolved.factor_to_base)).toFixed(6))}));
    }
    evidence.push({productId:Number(txItem.product_id),transactionItemId:Number(txItem.id),enteredQuantity,resolved,baseQuantity,enteredUnitPrice:saleSnap?.entered_unit_price??null,baseUnitPrice:saleSnap?.base_unit_price??Number(txItem.unit_price||0)});
  }
  req.returnUomEvidence=evidence;
}
async function save(req,payload){
  if(!payload?.id||!req.returnUomEvidence?.length)return;const tx=await db.transaction('write');let committed=false;const rows=Array.isArray(payload.items)?payload.items:[];
  try{for(let i=0;i<req.returnUomEvidence.length;i++){const e=req.returnUomEvidence[i],saved=rows[i]||null;await snapshot(tx,{sourceType:'return',sourceId:payload.id,sourceLineId:saved?.id||e.transactionItemId||null,productId:e.productId,enteredQuantity:e.enteredQuantity,resolved:e.resolved,baseQuantity:e.baseQuantity,enteredUnitPrice:e.enteredUnitPrice,baseUnitPrice:e.baseUnitPrice});}await tx.commit();committed=true;}catch(err){if(!committed)await tx.rollback();throw err;}
}
router.post('/:id/return',async(req,res,next)=>{
  try{await normalize(req);}catch(e){return res.status(409).json({error:e.message});}
  const originalJson=res.json.bind(res);let handled=false;
  res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300&&payload?.id&&req.returnUomEvidence?.length)return save(req,payload).then(()=>originalJson(payload)).catch(e=>{if(!res.headersSent){res.status(500);return originalJson({error:'Return posted but UOM evidence finalization failed; reconciliation required',return_id:payload.id,detail:e.message});}});return originalJson(payload)};
  next();
});
module.exports=router;
