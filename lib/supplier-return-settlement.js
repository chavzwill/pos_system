'use strict';
// A line receives a fixed share of the dispatch journal's cents. Partial
// settlements use cumulative rounding so the final settlement clears exactly
// that share, even when an item's carrying value is below one cent per unit.
async function settlementCarryingCents(executor,line,quantity){
 const q=Number(quantity),totalQty=Number(line.quantity),totalCents=line.carrying_cents==null?Math.round(Number(line.tracked_value)*100):Number(line.carrying_cents);
 if(!Number.isFinite(q)||q<=0||!Number.isFinite(totalQty)||totalQty<=0||!Number.isSafeInteger(totalCents)||totalCents<0)throw new Error('Invalid dispatched carrying value evidence');
 const {rows:tables}=await executor.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('supplier_credit_posting_items','supplier_return_replacements')",args:[]});
 const names=new Set(tables.map(x=>x.name));let usedQty=0,usedCents=0;
 if(names.has('supplier_credit_posting_items')){
  const {rows:[r]}=await executor.execute({sql:'SELECT COALESCE(SUM(quantity),0) qty,COALESCE(SUM(carrying_cents),0) cents FROM supplier_credit_posting_items WHERE return_item_id=?',args:[line.id]});usedQty+=Number(r.qty);usedCents+=Number(r.cents);
 }
 if(names.has('supplier_return_replacements')){
  const {rows:[r]}=await executor.execute({sql:'SELECT COALESCE(SUM(quantity),0) qty,COALESCE(SUM(ROUND(original_value*100)),0) cents FROM supplier_return_replacements WHERE return_item_id=?',args:[line.id]});usedQty+=Number(r.qty);usedCents+=Number(r.cents);
 }
 if(usedQty+q>totalQty+1e-8)throw new Error('Settlement exceeds dispatched return quantity');
 const cents=Math.round(totalCents*Math.min(totalQty,usedQty+q)/totalQty)-usedCents;
 if(!Number.isSafeInteger(cents)||cents<0||usedCents+cents>totalCents)throw new Error('Prior settlement carrying evidence does not reconcile');
 return cents;
}
module.exports={settlementCarryingCents};
