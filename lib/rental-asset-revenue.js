'use strict';
// Read-only revenue evidence. Never allocate agreement-wide overrides to an arbitrary asset.
const moneyCents=value=>{const n=Number(value);if(!Number.isFinite(n)||!Number.isSafeInteger(Math.round(n*100)))throw new Error('Unsafe rental revenue evidence');return Math.round(n*100);};
async function schema(ex){const item=(await ex.execute('PRAGMA table_info(rental_agreement_items)')).rows.map(x=>x.name),agreement=(await ex.execute('PRAGMA table_info(rental_agreements)')).rows.map(x=>x.name);return{final:item.includes('final_rental_fee')&&item.includes('quantity_returned'),duration:agreement.includes('duration_adjustment_total')};}
async function read(ex,assetId,fields){
 const settled=fields.final,adjust=fields.duration;
 const {rows}=await ex.execute({sql:`SELECT aa.agreement_id,aa.allocated_at,aa.quantity allocated_quantity,ra.status,rai.quantity line_quantity,rai.rental_fee,${settled?'rai.final_rental_fee':'NULL'} final_rental_fee,${settled?'rai.quantity_returned':'NULL'} quantity_returned,${adjust?'ra.duration_adjustment_total':'NULL'} agreement_adjustment,
 ${settled?`(SELECT SUM(COALESCE(i.final_rental_fee,0)-COALESCE(i.rental_fee,0)) FROM rental_agreement_items i WHERE i.agreement_id=ra.id)`:'NULL'} line_adjustment
 FROM rental_asset_allocations aa JOIN rental_agreement_items rai ON rai.id=aa.agreement_item_id JOIN rental_agreements ra ON ra.id=aa.agreement_id AND ra.id=rai.agreement_id WHERE aa.asset_id=? AND ra.status IN('active','returned','buyout_closed')`,args:[assetId]});
 let originalCents=0,earnedCents=0,reviewRequired=false,legacy=false,active=0,adjusted=0,first=null,last=null;
 const agreements=new Set(),reasons=new Set();
 for(const r of rows){
  agreements.add(Number(r.agreement_id));if(!first||String(r.allocated_at)<first)first=String(r.allocated_at);if(!last||String(r.allocated_at)>last)last=String(r.allocated_at);
  const quantity=Number(r.line_quantity),allocated=Number(r.allocated_quantity),valid=quantity>0&&Number.isFinite(quantity)&&Number.isFinite(allocated)&&allocated>0&&allocated<=quantity;
  if(!valid){reviewRequired=true;reasons.add('invalid_allocation_quantity');continue;}
  const original=moneyCents(r.rental_fee),originalShare=Math.round(original*allocated/quantity);
  originalCents+=originalShare;let selected=originalShare;
  if(String(r.status)==='active'){
   active++;if(settled&&Number(r.quantity_returned)>0){reviewRequired=true;reasons.add('partially_returned_agreement');}
  }else if(!settled||r.final_rental_fee==null){legacy=true;reasons.add('final_fee_evidence_unavailable');if(r.status==='buyout_closed'||settled)reviewRequired=true;}
  else if(Number(r.quantity_returned)<quantity){reviewRequired=true;reasons.add('unresolved_rental_quantity');}
  else if(r.status==='returned'&&(!adjust||r.agreement_adjustment==null||r.line_adjustment==null||Math.abs(moneyCents(r.line_adjustment)-moneyCents(r.agreement_adjustment))>1)){
   reviewRequired=true;reasons.add('agreement_adjustment_unattributed');
  }else{selected=Math.round(moneyCents(r.final_rental_fee)*allocated/quantity);adjusted++;}
  earnedCents+=selected;
 }
 if(!Number.isSafeInteger(originalCents)||!Number.isSafeInteger(earnedCents))throw new Error('Unsafe rental revenue sum');
 return {rental_count:agreements.size,first_rental_at:first,last_rental_at:last,quoted_rental_revenue:originalCents/100,core_rental_revenue:reviewRequired?null:earnedCents/100,revenue_review_required:reviewRequired,revenue_review_reasons:[...reasons],settled_line_allocations:adjusted,provisional_active_allocations:active,source:legacy?'legacy_original_fee_only':reviewRequired?'unresolved_reconciliation':active?'settled_and_active_estimates':'settled_final_line_fees'};
}
module.exports={schema,read};
