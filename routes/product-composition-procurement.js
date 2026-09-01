'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureProductComposition,getComposition}=require('../lib/product-composition');

const r2=v=>Number(Number(v||0).toFixed(2));
function normalizeRequirements(rows){
  const map=new Map();
  for(const row of Array.isArray(rows)?rows:[]){const id=Number(row?.product_id),qty=Number(row?.quantity);if(!Number.isInteger(id)||id<=0||!Number.isFinite(qty)||qty<=0)continue;map.set(id,(map.get(id)||0)+qty);}
  return [...map.entries()].map(([product_id,quantity])=>({product_id,quantity:Number(quantity.toFixed(6))}));
}
async function standalonePlan(executor,requirements){
  const rows=[];let total=0;const missing=[];
  for(const req of requirements){
    const {rows:[p]}=await executor.execute({sql:'SELECT id,name,sku,cost FROM products WHERE id=?',args:[req.product_id]});if(!p)throw Object.assign(new Error(`Required product ${req.product_id} not found`),{status:404});
    const raw=Number(p.cost),complete=Number.isFinite(raw)&&raw>0,cost=complete?raw:0,line=r2(cost*req.quantity);total+=line;
    if(!complete)missing.push({product_id:p.id,name:p.name,sku:p.sku||'',reason:'missing_positive_acquisition_cost'});
    rows.push({...req,name:p.name,sku:p.sku||'',unit_cost:cost,extended_cost:line,cost_evidence_complete:complete});
  }
  return {requirements:rows,total_cost:r2(total),cost_basis_complete:missing.length===0,missing_cost_evidence:missing};
}
function evaluateCandidate(composition,parent,requirements){
  const parentCost=Number(parent.cost);if(!Number.isFinite(parentCost)||parentCost<=0)return null;
  const reqMap=new Map(requirements.map(x=>[Number(x.product_id),Number(x.quantity)]));
  const relevant=composition.components.filter(c=>reqMap.has(Number(c.component_product_id)));if(!relevant.length)return null;
  if(relevant.some(c=>{const n=Number(c.component_cost);return !Number.isFinite(n)||n<=0;}))return null;
  const maxKits=Math.max(1,...relevant.map(c=>Math.ceil(reqMap.get(Number(c.component_product_id))/Number(c.quantity_per_parent||1))));
  let best=null;
  for(let kits=1;kits<=maxKits;kits++){
    const coverage=[],extras=[];let coveredStandaloneValue=0,remainingStandaloneValue=0;
    for(const c of composition.components){
      const pid=Number(c.component_product_id),per=Number(c.quantity_per_parent||0),produced=per*kits,required=Number(reqMap.get(pid)||0),covered=Math.min(required,produced),extra=Math.max(0,produced-required),unitCost=Math.max(0,Number(c.component_cost||0));
      if(required>0){coverage.push({product_id:pid,name:c.component_name,sku:c.component_sku||'',required,produced,covered,remaining:Math.max(0,required-produced),unit_cost:unitCost});coveredStandaloneValue+=covered*unitCost;remainingStandaloneValue+=Math.max(0,required-produced)*unitCost;}
      if(extra>1e-9)extras.push({product_id:pid,name:c.component_name,sku:c.component_sku||'',quantity:Number(extra.toFixed(6)),estimated_unit_cost:unitCost,estimated_value:r2(extra*unitCost)});
    }
    for(const req of requirements){if(!composition.components.some(c=>Number(c.component_product_id)===Number(req.product_id)))remainingStandaloneValue+=Number(req.quantity)*Number(req.unit_cost||0);}
    const kitCost=r2(parentCost*kits),hybridCost=r2(kitCost+remainingStandaloneValue),directCoveredCost=r2(coveredStandaloneValue),savingsOnCovered=r2(directCoveredCost-kitCost);
    const option={composition_id:composition.id,parent_product_id:parent.id,parent_product_name:parent.name,parent_sku:parent.sku||'',kits_to_buy:kits,kit_unit_cost:parentCost,kit_purchase_cost:kitCost,remaining_standalone_cost:r2(remainingStandaloneValue),estimated_total_replenishment_cost:hybridCost,covered_component_standalone_cost:directCoveredCost,estimated_savings_on_covered_requirements:savingsOnCovered,coverage,extra_components:extras,cost_basis_complete:true};
    if(!best||option.estimated_total_replenishment_cost<best.estimated_total_replenishment_cost)best=option;
  }
  return best;
}
async function recommend(requirements){
  const standalone=await standalonePlan(db,requirements);
  const {rows:candidates}=await db.execute({sql:`SELECT pc.id,p.id parent_product_id,p.name parent_product_name,p.sku parent_sku,p.cost parent_cost FROM product_compositions pc JOIN products p ON p.id=pc.parent_product_id WHERE pc.composition_type='procurement_kit' AND pc.active=1 AND p.active=1`,args:[]});
  const options=[],excluded=[];
  for(const row of candidates){
    const composition=await getComposition(db,Number(row.id));const parentCost=Number(row.parent_cost);const relevant=composition.components.filter(c=>requirements.some(r=>Number(r.product_id)===Number(c.component_product_id)));
    const missingParent=!Number.isFinite(parentCost)||parentCost<=0,missingComponents=relevant.filter(c=>{const n=Number(c.component_cost);return !Number.isFinite(n)||n<=0;}).map(c=>({product_id:c.component_product_id,name:c.component_name,sku:c.component_sku||''}));
    if(missingParent||missingComponents.length){excluded.push({composition_id:composition.id,parent_product_id:row.parent_product_id,parent_product_name:row.parent_product_name,parent_sku:row.parent_sku||'',reason:'incomplete_cost_evidence',missing_parent_cost:missingParent,missing_component_costs:missingComponents});continue;}
    const option=evaluateCandidate(composition,{id:row.parent_product_id,name:row.parent_product_name,sku:row.parent_sku,cost:row.parent_cost},standalone.requirements);if(option)options.push(option);
  }
  options.sort((a,b)=>a.estimated_total_replenishment_cost-b.estimated_total_replenishment_cost);const best=options[0]||null;
  let recommendation;
  if(!standalone.cost_basis_complete)recommendation={strategy:'cost_evidence_required',reason:'One or more required components do not have positive acquisition-cost evidence. No economic recommendation is certified until cost evidence is completed.'};
  else if(best&&best.estimated_total_replenishment_cost<standalone.total_cost)recommendation={strategy:'procurement_kit_plus_individuals',...best,estimated_savings_vs_all_individual:r2(standalone.total_cost-best.estimated_total_replenishment_cost)};
  else recommendation={strategy:'buy_individual_components',estimated_total_replenishment_cost:standalone.total_cost,estimated_savings_vs_all_individual:0};
  return {standalone,procurement_kit_options:options,excluded_options:excluded,recommendation,cost_basis_notice:'Planning uses current catalog acquisition-cost estimates only. Purchase-order and receipt evidence remains authoritative for valuation.'};
}

router.use(async(req,res,next)=>{try{await ensureProductComposition();next();}catch(e){res.status(500).json({error:'Product composition procurement initialization failed',detail:e.message});}});
router.post('/recommendations',requirePermission('purchase_requests'),async(req,res)=>{
  try{const requirements=normalizeRequirements(req.body?.requirements);if(!requirements.length)return res.status(400).json({error:'At least one positive product requirement is required'});res.json(await recommend(requirements));}catch(e){res.status(e.status||500).json({error:e.message});}
});
router.post('/quote/:quoteId/recommendations',requirePermission('purchase_requests'),async(req,res)=>{
  try{
    const quoteId=Number(req.params.quoteId);const {rows:[quote]}=await db.execute({sql:'SELECT id,quote_number FROM quotations WHERE id=?',args:[quoteId]});if(!quote)return res.status(404).json({error:'Quotation not found'});
    const {rows:shortfalls}=await db.execute({sql:`SELECT qi.product_id,COALESCE(SUM(qis.quantity),0) quantity FROM quotation_item_sources qis JOIN quotation_items qi ON qi.id=qis.quotation_item_id WHERE qi.quote_id=? AND qis.branch_id IS NULL AND qi.product_id IS NOT NULL GROUP BY qi.product_id`,args:[quoteId]});
    const requirements=normalizeRequirements(shortfalls);if(!requirements.length)return res.json({quote_id:quoteId,quote_number:quote.quote_number,requirements:[],recommendation:null,message:'This quotation has no recorded purchase shortfalls.'});
    res.json({quote_id:quoteId,quote_number:quote.quote_number,...await recommend(requirements)});
  }catch(e){res.status(e.status||500).json({error:e.message});}
});
module.exports=router;
