'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureLedger}=require('../lib/accounting-posting');

router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
const pct=(n,d)=>Number(d)>0?r2(100*Number(n||0)/Number(d)):null;
const REVENUE_CODES=new Set(['4000','4100','4200']);
const DIRECT_COST_CODES=new Set(['5000','5100','5200','5300','5450','5500']);
async function table(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
function windowDays(req){return Math.max(1,Math.min(365,Number(req.query.days)||30));}
async function postedLedger(days){
  await ensureLedger();
  const {rows}=await db.execute({sql:`SELECT COALESCE(jl.branch_id,je.branch_id) branch_id,la.code,la.name account_name,la.account_type,
      ROUND(SUM(jl.debit),2) debit,ROUND(SUM(jl.credit),2) credit,COUNT(DISTINCT je.id) journal_count
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN ledger_accounts la ON la.id=jl.ledger_account_id
    WHERE je.status='posted' AND date(je.entry_date)>=date('now',?)
    GROUP BY COALESCE(jl.branch_id,je.branch_id),la.code,la.name,la.account_type
    ORDER BY branch_id,la.code`,args:[`-${days-1} days`]});
  return rows;
}
async function sourceCoverage(days){
  const {rows}=await db.execute({sql:`SELECT COALESCE(branch_id,0) branch_id,COALESCE(source_type,'manual_or_unclassified') source_type,
      COUNT(*) journal_entries,MIN(entry_date) first_entry_date,MAX(entry_date) last_entry_date
    FROM journal_entries WHERE status='posted' AND date(entry_date)>=date('now',?)
    GROUP BY COALESCE(branch_id,0),COALESCE(source_type,'manual_or_unclassified') ORDER BY branch_id,journal_entries DESC`,args:[`-${days-1} days`]});
  return rows;
}
async function leakageOverlay(days){
  const out=[];
  if(await table('retail_margin_override_events')){const {rows}=await db.execute({sql:`SELECT branch_id,'margin_override' category,COUNT(*) events,ROUND(SUM(MAX(0,-projected_gross_margin)),2) realized_loss,ROUND(SUM(discount_amount),2) exposure FROM retail_margin_override_events WHERE created_at>=datetime('now',?) GROUP BY branch_id`,args:[`-${days} days`]});out.push(...rows);}
  if(await table('service_refunds')){const {rows}=await db.execute({sql:`SELECT wo.branch_id,'service_refund' category,COUNT(*) events,ROUND(SUM(CASE WHEN sr.status='settled' THEN sr.refund_amount ELSE 0 END),2) realized_loss,ROUND(SUM(CASE WHEN sr.status IN ('pending_approval','approved') THEN sr.refund_amount ELSE 0 END),2) exposure FROM service_refunds sr JOIN work_orders wo ON wo.id=sr.work_order_id WHERE sr.created_at>=datetime('now',?) GROUP BY wo.branch_id`,args:[`-${days} days`]});out.push(...rows);}
  if(await table('service_concessions')){const {rows}=await db.execute({sql:`SELECT wo.branch_id,'service_concession' category,COUNT(*) events,ROUND(SUM(CASE WHEN sc.status='approved' AND sc.applied_transaction_id IS NOT NULL THEN sc.approved_amount ELSE 0 END),2) realized_loss,ROUND(SUM(CASE WHEN sc.status='pending_approval' THEN sc.proposed_amount WHEN sc.status='approved' AND sc.applied_transaction_id IS NULL THEN sc.approved_amount ELSE 0 END),2) exposure FROM service_concessions sc JOIN work_orders wo ON wo.id=sc.work_order_id WHERE sc.created_at>=datetime('now',?) GROUP BY wo.branch_id`,args:[`-${days} days`]});out.push(...rows);}
  if(await table('inventory_writeoffs')){const {rows}=await db.execute({sql:`SELECT branch_id,'inventory_writeoff' category,COUNT(*) events,ROUND(SUM(COALESCE(tracked_value,0)),2) realized_loss,0 exposure FROM inventory_writeoffs WHERE status='approved' AND created_at>=datetime('now',?) GROUP BY branch_id`,args:[`-${days} days`]});out.push(...rows);}
  if(await table('retail_promotion_control_events')){const {rows}=await db.execute({sql:`SELECT branch_id,'promotion_discount' category,COUNT(*) events,0 realized_loss,ROUND(SUM(authoritative_discount),2) exposure FROM retail_promotion_control_events WHERE created_at>=datetime('now',?) GROUP BY branch_id`,args:[`-${days} days`]});out.push(...rows);}
  return out.map(x=>({...x,realized_loss:r2(x.realized_loss),exposure:r2(x.exposure)}));
}
async function evidenceGaps(days){
  const gaps=[];
  if(await table('transactions')){
    const {rows:[sales]}=await db.execute({sql:`SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN total>0 THEN total ELSE 0 END),0) value FROM transactions WHERE status='completed' AND created_at>=datetime('now',?)`,args:[`-${days} days`]});
    const {rows:[retailJ]}=await db.execute({sql:`SELECT COUNT(*) n FROM journal_entries WHERE status='posted' AND source_type='retail_sale' AND date(entry_date)>=date('now',?)`,args:[`-${days-1} days`]});
    gaps.push({evidence_area:'retail_sales_journal_coverage',source_records:Number(sales?.n||0),posted_journals:Number(retailJ?.n||0),source_value:r2(sales?.value),coverage_pct:Number(sales?.n||0)>0?pct(retailJ?.n,sales?.n):100,note:'A transaction count mismatch does not itself prove missing revenue because rental/service transactions are intentionally excluded from retail-sale journals; investigate material gaps by source type.'});
  }
  if(await table('transaction_items')){
    const {rows:cols}=await db.execute({sql:'PRAGMA table_info(transaction_items)',args:[]});const names=new Set(cols.map(c=>String(c.name||'').toLowerCase()));
    const hasHistoricalCost=['unit_cost','cost','cost_at_sale','unit_cost_at_sale'].some(n=>names.has(n));
    if(!hasHistoricalCost)gaps.push({evidence_area:'retail_historical_cogs',coverage_pct:0,blocking:true,note:'Retail transaction lines do not preserve authoritative historical unit cost, so full retail gross profit and product profitability are not claimed.'});
  }
  return gaps;
}
function summarizeBranch(rows,leaks,branchNames){
  const map=new Map();
  for(const row of rows){const id=Number(row.branch_id)||0,key=String(id),x=map.get(key)||{branch_id:id,branch_name:branchNames[key]||null,accounted_revenue:0,accounted_direct_costs:0,accounted_contribution_before_unallocated_overhead:0,revenue_accounts:{},direct_cost_accounts:{},journal_count:0};const code=String(row.code);const debit=Number(row.debit||0),credit=Number(row.credit||0);if(REVENUE_CODES.has(code)){const value=r2(credit-debit);x.accounted_revenue+=value;x.revenue_accounts[code]={name:row.account_name,value};}if(DIRECT_COST_CODES.has(code)){const value=r2(debit-credit);x.accounted_direct_costs+=value;x.direct_cost_accounts[code]={name:row.account_name,value};}x.journal_count+=Number(row.journal_count||0);map.set(key,x);}
  for(const x of map.values()){x.accounted_revenue=r2(x.accounted_revenue);x.accounted_direct_costs=r2(x.accounted_direct_costs);x.accounted_contribution_before_unallocated_overhead=r2(x.accounted_revenue-x.accounted_direct_costs);x.accounted_contribution_margin_pct=pct(x.accounted_contribution_before_unallocated_overhead,x.accounted_revenue);x.known_leakage_overlay={realized_loss:0,at_risk_value:0,categories:[]};}
  for(const l of leaks){const key=String(Number(l.branch_id)||0),x=map.get(key)||{branch_id:Number(l.branch_id)||0,branch_name:branchNames[key]||null,accounted_revenue:0,accounted_direct_costs:0,accounted_contribution_before_unallocated_overhead:0,accounted_contribution_margin_pct:null,revenue_accounts:{},direct_cost_accounts:{},journal_count:0,known_leakage_overlay:{realized_loss:0,at_risk_value:0,categories:[]}};x.known_leakage_overlay.realized_loss+=Number(l.realized_loss||0);x.known_leakage_overlay.at_risk_value+=Number(l.exposure||0);x.known_leakage_overlay.categories.push({category:l.category,events:Number(l.events||0),realized_loss:r2(l.realized_loss),at_risk_value:r2(l.exposure)});map.set(key,x);}
  for(const x of map.values()){x.known_leakage_overlay.realized_loss=r2(x.known_leakage_overlay.realized_loss);x.known_leakage_overlay.at_risk_value=r2(x.known_leakage_overlay.at_risk_value);x.value_preservation_context={accounted_contribution:x.accounted_contribution_before_unallocated_overhead,known_realized_leakage:x.known_leakage_overlay.realized_loss,known_at_risk_value:x.known_leakage_overlay.at_risk_value,warning:'Known realized leakage is an explanatory overlay and is NOT subtracted again from ledger contribution because some leakage may already be reflected in posted revenue/expense journals.'};}
  return [...map.values()].sort((a,b)=>Number(b.accounted_contribution_before_unallocated_overhead)-Number(a.accounted_contribution_before_unallocated_overhead));
}
async function branchNames(){if(!(await table('branches')))return{};const {rows}=await db.execute({sql:'SELECT id,name FROM branches',args:[]});return Object.fromEntries(rows.map(r=>[String(r.id),r.name]));}
router.get('/value-preservation',async(req,res)=>{
  try{
    const days=windowDays(req);const [ledger,coverage,leaks,gaps,names]=await Promise.all([postedLedger(days),sourceCoverage(days),leakageOverlay(days),evidenceGaps(days),branchNames()]);
    const branches=summarizeBranch(ledger,leaks,names);
    const headline=branches.reduce((a,x)=>{a.accounted_revenue+=Number(x.accounted_revenue||0);a.accounted_direct_costs+=Number(x.accounted_direct_costs||0);a.accounted_contribution_before_unallocated_overhead+=Number(x.accounted_contribution_before_unallocated_overhead||0);a.known_realized_leakage+=Number(x.known_leakage_overlay?.realized_loss||0);a.known_at_risk_value+=Number(x.known_leakage_overlay?.at_risk_value||0);return a;},{accounted_revenue:0,accounted_direct_costs:0,accounted_contribution_before_unallocated_overhead:0,known_realized_leakage:0,known_at_risk_value:0});for(const k of Object.keys(headline))headline[k]=r2(headline[k]);headline.accounted_contribution_margin_pct=pct(headline.accounted_contribution_before_unallocated_overhead,headline.accounted_revenue);
    res.json({window_days:days,headline,by_branch:branches,posted_source_coverage:coverage,evidence_gaps:gaps,methodology:{financial_basis:'Only posted general-ledger evidence is used for accounted revenue and direct costs.',revenue_accounts:[...REVENUE_CODES],direct_cost_accounts:[...DIRECT_COST_CODES],contribution_definition:'Accounted revenue minus the currently classified direct/operating cost accounts. It is contribution before unallocated overhead, depreciation, financing, income tax and other accounts not included in this classification.',leakage_overlay:'Loss-control evidence is shown beside the ledger result for explanation and investigation. It is not automatically subtracted from contribution because doing so could double-count refunds, write-offs or other items already journalized.',concession_timing:'Approved service concessions remain at risk until actually applied to a settlement transaction; only applied concessions are treated as realized erosion in this overlay.',profit_warning:'This endpoint does not claim audited net profit, full product profitability or full customer profitability where source evidence is incomplete.',automation:'Read-only intelligence. No journal, inventory, customer, employee, supplier or transaction record is changed.'},automatic_actions:false});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
