'use strict';
const {db}=require('../database');
const stmt=(sql,args=[])=>({sql,args});
function fail(code,message,status=409){return Object.assign(new Error(message),{code,status});}
function cents(value){const n=Math.round(Number(value||0)*100);return integer(n,'Recorded cost');}
function integer(n,label='Cost'){n=Number(n);if(!Number.isSafeInteger(n)||n<0)throw fail('INVALID_COST_EVIDENCE',label+' must be nonnegative safe integer cents');return n;}
function sum(rows,key){return rows.reduce((n,r)=>integer(n+integer(r[key])),0);}
let ready;
async function ensureCostReviewSchema(){
 if(ready)return ready;
 ready=db.batch([
  stmt(`CREATE TABLE IF NOT EXISTS rental_asset_cost_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,asset_id INTEGER NOT NULL REFERENCES rental_assets(id),source_type TEXT NOT NULL CHECK(source_type IN('maintenance','economic_event')),source_id INTEGER NOT NULL,recorded_cost_cents INTEGER NOT NULL CHECK(recorded_cost_cents>=0),non_consumable_cost_cents INTEGER NOT NULL CHECK(non_consumable_cost_cents>=0 AND non_consumable_cost_cents<=recorded_cost_cents),previous_review_id INTEGER REFERENCES rental_asset_cost_reviews(id),reason TEXT NOT NULL,evidence_ref TEXT NOT NULL,actor_employee_id INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
  stmt('CREATE INDEX IF NOT EXISTS idx_rental_maintenance_review_source ON rental_asset_cost_reviews(source_type,source_id,id)'),
  stmt('CREATE TABLE IF NOT EXISTS rental_asset_cost_review_operations(operation_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'),
  ...['rental_asset_cost_reviews','rental_asset_cost_review_operations'].flatMap(t=>['UPDATE','DELETE'].map(op=>stmt(`CREATE TRIGGER IF NOT EXISTS ${t}_no_${op.toLowerCase()} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT,'Asset cost review evidence is immutable'); END`)))
 ],'write').catch(e=>{ready=null;throw e;});return ready;
}
// Bulk optional-source reads keep fleet lists from making one consumables query per asset.
// No schema initializers or writes belong in this reader.
async function readAssetCosts(ex,assets){
 if(!Array.isArray(assets))assets=[assets];const out=new Map();if(!assets.length)return out;
 const tables=new Set((await ex.execute(stmt("SELECT name FROM sqlite_master WHERE type='table'"))).rows.map(r=>r.name));
 const cols=tables.has('consumable_movements')?new Set((await ex.execute(stmt('PRAGMA table_info(consumable_movements)'))).rows.map(r=>r.name)):new Set();
 const hasIssues=cols.has('rental_asset_id'),hasReturns=tables.has('consumable_issue_returns'),hasReviews=tables.has('rental_asset_cost_reviews'),hasCatalog=tables.has('consumable_catalog');
 const missing=[];if(!tables.has('consumable_movements'))missing.push('consumable_movements');else if(!hasIssues)missing.push('consumable_movements.rental_asset_id');if(!hasReturns)missing.push('consumable_issue_returns');
 const ids=assets.map(a=>Number(a.id)),placeholders=ids.map(()=>'?').join(',');
 const issues=hasIssues?(await ex.execute(stmt(`SELECT m.*,ib.name original_branch_name,${hasCatalog?'c.name,c.sku,c.uom,':"NULL name,NULL sku,NULL uom,"}${hasReturns?'COALESCE(ret.quantity,0) returned_quantity,COALESCE(ret.value_cents,0) returned_cost_cents':'NULL returned_quantity,NULL returned_cost_cents'} FROM consumable_movements m LEFT JOIN branches ib ON ib.id=m.branch_id ${hasCatalog?'LEFT JOIN consumable_catalog c ON c.id=m.consumable_id':''} ${hasReturns?'LEFT JOIN (SELECT issue_movement_id,SUM(quantity) quantity,SUM(value_cents) value_cents FROM consumable_issue_returns GROUP BY issue_movement_id) ret ON ret.issue_movement_id=m.id':''} WHERE m.action='issue' AND m.rental_asset_id IN (${placeholders}) ORDER BY m.id`,ids))).rows:[];
 const maintenance=tables.has('rental_asset_maintenance')?(await ex.execute(stmt(`SELECT m.*,${hasReviews?'r.id review_id,r.recorded_cost_cents reviewed_recorded_cost_cents,r.non_consumable_cost_cents,r.reason review_reason,r.evidence_ref review_evidence_ref,r.actor_employee_id reviewer_id,r.created_at reviewed_at':'NULL review_id,NULL reviewed_recorded_cost_cents,NULL non_consumable_cost_cents,NULL review_reason,NULL review_evidence_ref,NULL reviewer_id,NULL reviewed_at'} FROM rental_asset_maintenance m ${hasReviews?"LEFT JOIN rental_asset_cost_reviews r ON r.id=(SELECT MAX(rr.id) FROM rental_asset_cost_reviews rr WHERE rr.source_type='maintenance' AND rr.source_id=m.id AND rr.asset_id=m.asset_id)":''} WHERE m.asset_id IN (${placeholders}) ORDER BY m.id`,ids))).rows:[];
 const economic=tables.has('rental_asset_economic_events')?(await ex.execute(stmt(`SELECT m.*,m.amount direct_cost,m.event_type maintenance_type,m.event_date started_at,${hasReviews?'r.id review_id,r.recorded_cost_cents reviewed_recorded_cost_cents,r.non_consumable_cost_cents,r.reason review_reason,r.evidence_ref review_evidence_ref,r.actor_employee_id reviewer_id,r.created_at reviewed_at':'NULL review_id,NULL reviewed_recorded_cost_cents,NULL non_consumable_cost_cents,NULL review_reason,NULL review_evidence_ref,NULL reviewer_id,NULL reviewed_at'} FROM rental_asset_economic_events m ${hasReviews?"LEFT JOIN rental_asset_cost_reviews r ON r.id=(SELECT MAX(rr.id) FROM rental_asset_cost_reviews rr WHERE rr.source_type='economic_event' AND rr.source_id=m.id AND rr.asset_id=m.asset_id)":''} WHERE m.event_type IN ('other_direct_cost','unrecovered_damage_loss') AND m.asset_id IN (${placeholders}) ORDER BY m.id`,ids))).rows:[];
 const legacy=cols.has('rental_product_id')?(await ex.execute(stmt(`SELECT rental_product_id,branch_id,COUNT(*) n FROM consumable_movements WHERE action='issue' AND rental_product_id IN (${[...new Set(assets.map(a=>Number(a.product_id)))].map(()=>'?').join(',')}) ${hasIssues?'AND rental_asset_id IS NULL':''} GROUP BY rental_product_id,branch_id`,[...new Set(assets.map(a=>Number(a.product_id)))]))).rows:[];
 for(const a of assets){
  const rows=issues.filter(m=>Number(m.rental_asset_id)===Number(a.id)).map(m=>{
   const gross=integer(m.value_cents),quantity=integer(m.quantity,'Issue quantity');
   const returned=hasReturns?integer(m.returned_cost_cents):null,returnedQty=hasReturns?integer(m.returned_quantity,'Returned quantity'):null;
   if(hasReturns&&(returned>gross||returnedQty>quantity))throw fail('INVALID_RETURN_EVIDENCE','Unused returns exceed original issue evidence');
   return {...m,original_cost_cents:gross,original_quantity:quantity,returned_cost_cents:returned,returned_quantity:returnedQty,net_cost_cents:hasReturns?gross-returned:null,net_quantity:hasReturns?quantity-returnedQty:null};
  });
  const unresolved=legacy.filter(m=>Number(m.rental_product_id)===Number(a.product_id)&&Number(m.branch_id)===Number(a.branch_id)).reduce((n,m)=>n+Number(m.n),0);
  const costRecord=m=>{
   const recorded=cents(m.direct_cost),valid=m.review_id!=null&&Number(m.reviewed_recorded_cost_cents)===recorded;
   const required=recorded>0&&rows.length>0&&!valid;
   return {...m,recorded_cost_cents:recorded,review_current:valid,cost_review_required:required,external_cost_cents:required?null:valid?integer(m.non_consumable_cost_cents):recorded};
  };
  const maint=maintenance.filter(m=>Number(m.asset_id)===Number(a.id)).map(costRecord);
  const direct=economic.filter(m=>Number(m.asset_id)===Number(a.id)).map(costRecord);
  const pending=maint.filter(m=>m.cost_review_required).length,pendingOther=direct.filter(m=>m.cost_review_required).length;
  const gross=hasIssues?sum(rows,'original_cost_cents'):null,returned=hasIssues&&hasReturns?sum(rows,'returned_cost_cents'):null,net=hasIssues&&hasReturns?sum(rows,'net_cost_cents'):null;
  out.set(Number(a.id),{consumables:{issue_count:rows.length,gross_cost_cents:gross,returned_cost_cents:returned,net_cost_cents:net,net_cost:net==null?null:net/100,unresolved_legacy_issues:unresolved},maintenance:{cost_review_required:pending>0,pending_cost_reviews:pending,recorded_cost_cents:sum(maint,'recorded_cost_cents'),non_consumable_cost_cents:pending?null:sum(maint,'external_cost_cents')},other_costs:{recorded_direct_cost_cents:sum(direct,'recorded_cost_cents'),non_consumable_direct_cost_cents:pendingOther?null:sum(direct,'external_cost_cents'),pending_cost_reviews:pendingOther},coverage:{partial:missing.length>0||unresolved>0||pending+pendingOther>0,missing_sources:[...missing],unresolved_legacy_issues:unresolved,pending_cost_reviews:pending+pendingOther,methodology:'Consumables follow original issued asset ID across branch transfers. Unused returns reduce original issue cost; maintenance reviews retain only the external portion. No catalog prices or guessed asset identities.'},issues:rows,maintenance_records:maint,economic_cost_records:direct});
 }
 return out;
}
module.exports={ensureCostReviewSchema,readAssetCosts,stmt,fail,cents,integer};
