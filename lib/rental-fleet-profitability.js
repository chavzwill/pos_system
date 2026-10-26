'use strict';
// Group only the authoritative asset lifetime economics already computed by the POS.
// No financial documents or ledgers are mutated by this read-only reporting layer.
const cents=value=>{const n=Number(value);if(!Number.isFinite(n)||!Number.isSafeInteger(Math.round(n*100)))throw new Error('Unsafe fleet accounting total');return Math.round(n*100);};
const add=(a,b)=>{const n=a+b;if(!Number.isSafeInteger(n))throw new Error('Fleet accounting totals exceed safe cents');return n;};
const money=n=>n/100;
function group(branchId,branchName){return {branch_id:branchId,branch_name:branchName,asset_count:0,certified_asset_count:0,assets_requiring_review:0,provisional_active_assets:0,revenue_review_assets:0,cost_review_assets:0,missing_cost_source_assets:0,partial_acquisition_assets:0,quoted_cents:0,revenue_cents:0,registered_acquisition_cents:0,consumables_cents:0,sale_cents:0,certified_contribution_cents:0,all_revenue:true,all_consumables:true,all_certified:true,lifecycle_states:{}};}
function accumulate(g,a){
 g.asset_count++;
 const state=String(a.status||'unknown');g.lifecycle_states[state]=(g.lifecycle_states[state]||0)+1;
 const rental=a.rentals||{},cost=a.cost_coverage||{},life=a.lifetime||{},acquisition=a.acquisition||{};
 const provisional=Number(rental.provisional_active_allocations||0)>0;
 const revenueMissing=rental.core_rental_revenue==null||!!rental.revenue_review_required;
 const costMissing=a.consumables?.net_cost_cents==null;
 const costReview=!!life.cost_review_required||Number(cost.pending_cost_reviews||0)>0;
 const missingSources=(cost.missing_sources||[]).length>0||Number(cost.unresolved_legacy_issues||0)>0;
 const partialAcquisition=acquisition.grade!=='complete';
 const certified=!provisional&&!revenueMissing&&!costMissing&&!costReview&&!missingSources&&!partialAcquisition&&life.evidenced_contribution!=null&&a.evidence_grade==='complete';
 if(provisional){g.provisional_active_assets++;g.all_revenue=false;}
 if(revenueMissing){g.revenue_review_assets++;g.all_revenue=false;}else if(!provisional)g.revenue_cents=add(g.revenue_cents,cents(rental.core_rental_revenue));
 if(costMissing)g.all_consumables=false;else {const value=Number(a.consumables.net_cost_cents);if(!Number.isSafeInteger(value)||value<0)throw new Error('Unsafe consumable evidence');g.consumables_cents=add(g.consumables_cents,value);}
 if(costReview)g.cost_review_assets++;
 if(missingSources)g.missing_cost_source_assets++;
 if(partialAcquisition)g.partial_acquisition_assets++;
 g.quoted_cents=add(g.quoted_cents,cents(rental.quoted_rental_revenue||0));
 g.registered_acquisition_cents=add(g.registered_acquisition_cents,cents(acquisition.cost||0));
 g.sale_cents=add(g.sale_cents,cents(a.other_economics?.disposal_value||0));
 if(certified){g.certified_asset_count++;g.certified_contribution_cents=add(g.certified_contribution_cents,cents(life.evidenced_contribution));}
 else{g.assets_requiring_review++;g.all_certified=false;}
 const reasons=[];
 if(provisional)reasons.push('active_revenue_provisional');
 if(revenueMissing)reasons.push(...(rental.revenue_review_reasons?.length?rental.revenue_review_reasons:['rental_revenue_unreconciled']));
 if(costReview)reasons.push('cost_review_pending');
 if(costMissing||missingSources)reasons.push('cost_evidence_missing_or_unattributed');
 if(partialAcquisition)reasons.push('acquisition_evidence_partial');
 if(!certified&&!reasons.length)reasons.push('contribution_evidence_incomplete');
 return {certified,reasons:[...new Set(reasons)]};
}
function view(g){return{branch_id:g.branch_id,branch_name:g.branch_name,asset_count:g.asset_count,certified_asset_count:g.certified_asset_count,assets_requiring_review:g.assets_requiring_review,provisional_active_assets:g.provisional_active_assets,revenue_review_assets:g.revenue_review_assets,cost_review_assets:g.cost_review_assets,missing_cost_source_assets:g.missing_cost_source_assets,partial_acquisition_assets:g.partial_acquisition_assets,original_quoted_rental_fees:money(g.quoted_cents),reconciled_rental_revenue:g.all_revenue?money(g.revenue_cents):null,verified_revenue_subset:money(g.revenue_cents),registered_acquisition_cost:money(g.registered_acquisition_cents),net_consumables:g.all_consumables?money(g.consumables_cents):null,verified_consumable_subset:money(g.consumables_cents),recorded_sale_disposal_value:money(g.sale_cents),certified_lifetime_contribution:g.all_certified?money(g.certified_contribution_cents):null,certified_subset_contribution:money(g.certified_contribution_cents),certified_coverage_pct:g.asset_count?Math.round(10000*g.certified_asset_count/g.asset_count)/100:null,complete:g.all_certified,lifecycle_states:g.lifecycle_states};}
function summarize(assets,exceptionLimit=60){const company=group(null,'All authorized branches'),byBranch=new Map(),exceptions=[];let exceptionCount=0;
 for(const a of assets){let branch=byBranch.get(Number(a.branch_id));if(!branch){branch=group(Number(a.branch_id),String(a.branch_name||'Unknown branch'));byBranch.set(Number(a.branch_id),branch);}const result=accumulate(branch,a);accumulate(company,a);
 if(!result.certified){exceptionCount++;if(exceptions.length<exceptionLimit)exceptions.push({asset_id:a.asset_id,asset_number:a.asset_number,product_name:a.product_name,branch_id:a.branch_id,branch_name:a.branch_name,reasons:result.reasons});}
 }
 return{company:view(company),branches:[...byBranch.values()].sort((a,b)=>a.branch_name.localeCompare(b.branch_name)||a.branch_id-b.branch_id).map(view),exceptions:{total:exceptionCount,shown:exceptions.length,truncated:exceptionCount>exceptions.length,items:exceptions},methodology:{scope:'All selected physical rental assets, grouped by their current assigned branch (not historical rental transaction branch).',lifetime_not_period_profit:true,revenue:'Final fees for reconciled returns and customer buyouts, plus provisional original charges for still-active rentals; deposits and tax are excluded.',contribution:'Lifetime, after evidenced registered acquisition and direct consumable/maintenance costs; not cash receipts or accounting net profit.',completeness:'Complete contribution requires every selected asset to have reviewed cost/revenue sources and no provisional active rental revenue; otherwise overall totals are null and separately labeled certified-subset amounts remain visible.',no_partial_totals_as_company_profit:true,read_only:true,non_atomic_live_read:true,unrecorded_overhead_not_included:true}};
}
module.exports={summarize};
