'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensureCostSnapshots}=require('./retail-cost-snapshot');
router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
const pct=(n,d)=>Number(d)>0?r2(100*Number(n||0)/Number(d)):null;
function days(req){return Math.max(1,Math.min(365,Number(req.query.days)||30));}
async function retailEvidence(windowDays,offset=0){
  await ensureCostSnapshots();
  const lower=`-${windowDays+offset} days`,upper=offset?`-${offset} days`:null;
  const clause=upper?`t.created_at>=datetime('now',?) AND t.created_at<datetime('now',?)`:`t.created_at>=datetime('now',?)`;
  const args=upper?[lower,upper]:[lower];
  const {rows:tx}=await db.execute({sql:`SELECT t.id,t.transaction_number,t.branch_id,t.customer_id,t.total,t.tax_amount,t.store_credit_applied,t.created_at,
      COUNT(s.id) snapshot_lines,SUM(CASE WHEN s.evidence_grade='complete' THEN 1 ELSE 0 END) complete_lines,
      SUM(CASE WHEN s.evidence_grade='partial' THEN 1 ELSE 0 END) partial_lines,SUM(CASE WHEN s.evidence_grade='blocked' THEN 1 ELSE 0 END) blocked_lines,
      ROUND(SUM(CASE WHEN s.evidence_grade='complete' THEN COALESCE(s.total_cost,0) ELSE 0 END),2) complete_cost,
      ROUND(SUM(COALESCE(s.total_cost,0)),2) captured_cost
    FROM transactions t JOIN retail_transaction_cost_snapshots s ON s.transaction_id=t.id
    WHERE t.status='completed' AND ${clause}
    GROUP BY t.id ORDER BY t.id`,args});
  return tx.map(x=>{const lines=Number(x.snapshot_lines||0),complete=Number(x.complete_lines||0),partial=Number(x.partial_lines||0),blocked=Number(x.blocked_lines||0),fullyComplete=lines>0&&complete===lines;const netSales=r2(Number(x.total||0)-Number(x.tax_amount||0)+Number(x.store_credit_applied||0)),cogs=fullyComplete?r2(x.complete_cost):null;return {...x,snapshot_lines:lines,complete_lines:complete,partial_lines:partial,blocked_lines:blocked,fully_complete_cost:fullyComplete,net_sales_value:netSales,evidenced_cogs:cogs,evidenced_gross_profit:cogs==null?null:r2(netSales-cogs),evidenced_gross_margin_pct:cogs==null?null:pct(netSales-cogs,netSales)};});
}
function aggregateBranch(rows){const m=new Map();for(const x of rows){const key=String(Number(x.branch_id)||0),v=m.get(key)||{branch_id:Number(x.branch_id)||0,transactions:0,complete_cost_transactions:0,partial_or_blocked_transactions:0,evidenced_net_sales:0,evidenced_cogs:0,evidenced_gross_profit:0};v.transactions++;if(x.fully_complete_cost){v.complete_cost_transactions++;v.evidenced_net_sales+=Number(x.net_sales_value||0);v.evidenced_cogs+=Number(x.evidenced_cogs||0);v.evidenced_gross_profit+=Number(x.evidenced_gross_profit||0);}else v.partial_or_blocked_transactions++;m.set(key,v);}return [...m.values()].map(v=>({...v,evidenced_net_sales:r2(v.evidenced_net_sales),evidenced_cogs:r2(v.evidenced_cogs),evidenced_gross_profit:r2(v.evidenced_gross_profit),evidenced_gross_margin_pct:pct(v.evidenced_gross_profit,v.evidenced_net_sales),cost_evidence_coverage_pct:pct(v.complete_cost_transactions,v.transactions)}));}
async function names(rows){const ids=[...new Set(rows.map(x=>Number(x.branch_id)).filter(Boolean))];if(!ids.length)return{};const ph=ids.map(()=>'?').join(',');const {rows:r}=await db.execute({sql:`SELECT id,name FROM branches WHERE id IN (${ph})`,args:ids});return Object.fromEntries(r.map(x=>[String(x.id),x.name]));}
function summary(rows){const transactions=rows.length,complete=rows.filter(x=>x.fully_complete_cost).length,partial=rows.filter(x=>!x.fully_complete_cost&&x.partial_lines>0).length,blocked=rows.filter(x=>!x.fully_complete_cost&&x.blocked_lines>0).length,net=rows.filter(x=>x.fully_complete_cost).reduce((s,x)=>s+Number(x.net_sales_value||0),0),cogs=rows.filter(x=>x.fully_complete_cost).reduce((s,x)=>s+Number(x.evidenced_cogs||0),0);const coverage=pct(complete,transactions);const grade=transactions===0?'blocked':coverage>=95?'complete':coverage>=50?'partial':'limited';return {transactions,complete_cost_transactions:complete,partial_cost_transactions:partial,blocked_cost_transactions:blocked,cost_evidence_coverage_pct:coverage,evidence_grade:grade,evidenced_net_sales:r2(net),evidenced_cogs:r2(cogs),evidenced_gross_profit:r2(net-cogs),evidenced_gross_margin_pct:pct(net-cogs,net)};}
router.get('/economic-depth',async(req,res)=>{
  try{
    const windowDays=days(req),current=await retailEvidence(windowDays,0),previous=await retailEvidence(windowDays,windowDays),currentSummary=summary(current),previousSummary=summary(previous),branches=aggregateBranch(current),bn=await names(branches);
    for(const b of branches)b.branch_name=bn[String(b.branch_id)]||null;
    const customers=new Map();for(const x of current.filter(x=>x.customer_id&&x.fully_complete_cost)){const k=String(x.customer_id),v=customers.get(k)||{customer_id:Number(x.customer_id),transactions:0,evidenced_net_sales:0,evidenced_cogs:0,evidenced_gross_profit:0};v.transactions++;v.evidenced_net_sales+=Number(x.net_sales_value||0);v.evidenced_cogs+=Number(x.evidenced_cogs||0);v.evidenced_gross_profit+=Number(x.evidenced_gross_profit||0);customers.set(k,v);}const customerRows=[...customers.values()].map(v=>({...v,evidenced_net_sales:r2(v.evidenced_net_sales),evidenced_cogs:r2(v.evidenced_cogs),evidenced_gross_profit:r2(v.evidenced_gross_profit),evidenced_gross_margin_pct:pct(v.evidenced_gross_profit,v.evidenced_net_sales)})).sort((a,b)=>b.evidenced_gross_profit-a.evidenced_gross_profit);
    res.json({window_days:windowDays,evidence_grade:currentSummary.evidence_grade,retail_profitability:currentSummary,trend:{previous_equal_window:previousSummary,gross_profit_change:r2(currentSummary.evidenced_gross_profit-previousSummary.evidenced_gross_profit),cost_evidence_coverage_change_pct:r2(Number(currentSummary.cost_evidence_coverage_pct||0)-Number(previousSummary.cost_evidence_coverage_pct||0))},by_branch:branches.sort((a,b)=>b.evidenced_gross_profit-a.evidenced_gross_profit),by_customer_evidenced_retail:customerRows.slice(0,100),methodology:{complete:'Every sold line in the transaction has tracked branch inventory-cost evidence captured at sale time.',partial:'Sale-time catalog cost was preserved for one or more lines, but the system will not automatically treat that weaker evidence as authoritative COGS.',limited:'Less than half of covered retail transactions have complete tracked cost evidence.',blocked:'No covered transactions have usable cost snapshots.',historical_boundary:'Cost snapshots begin prospectively when this control is active. Older transactions are not retroactively assigned today’s mutable catalog cost.',profit_scope:'Gross profit shown here is only for transactions with complete sale-time tracked cost evidence. It is not net profit and excludes overhead, financing, tax, and incomplete transactions.',automatic_actions:false},automatic_actions:false});
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
