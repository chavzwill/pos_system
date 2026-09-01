'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
router.use(requirePermission('reports'));
const r2=v=>Number(Number(v||0).toFixed(2));
const key=parts=>crypto.createHash('sha256').update(parts.map(x=>String(x??'')).join('|')).digest('hex');
async function table(name){const {rows:[r]}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name=?",args:[name]});return !!r;}
const daysAgo=n=>new Date(Date.now()-Math.max(0,Number(n)||0)*86400000).toISOString().slice(0,10);
function period(req){const days=Number(req.query.days||req.body?.days||365);return {start:String(req.query.start||req.body?.start||daysAgo(days)),end:String(req.query.end||req.body?.end||new Date().toISOString().slice(0,10)),branchId:Number(req.query.branch_id||req.body?.branch_id)||null};}
async function signals(p){
  if(!(await table('rental_agreement_items'))||!(await table('rental_agreements')))return [];
  const args=[p.start,p.end];let branch='';if(p.branchId){branch=' AND ra.branch_id=?';args.push(p.branchId);}
  const {rows}=await db.execute({sql:`SELECT ra.id agreement_id,ra.agreement_number,ra.branch_id,b.name branch_name,ra.customer_id,
      rai.id agreement_item_id,rai.product_id,rai.product_name,rai.sku,rai.parent_item_id,rai.is_mandatory,
      rai.quantity,rai.quantity_returned,rai.condition_in,rai.damage_fee,rai.replacement_value,rai.returned_at,COALESCE(p.cost,0) unit_cost
    FROM rental_agreement_items rai JOIN rental_agreements ra ON ra.id=rai.agreement_id
    LEFT JOIN products p ON p.id=rai.product_id LEFT JOIN branches b ON b.id=ra.branch_id
    WHERE rai.returned_at IS NOT NULL AND date(rai.returned_at) BETWEEN date(?) AND date(?)${branch}
      AND rai.quantity_returned>0 AND (
        lower(COALESCE(rai.condition_in,'')) LIKE '%missing%' OR lower(COALESCE(rai.condition_in,'')) LIKE '%lost%' OR
        lower(COALESCE(rai.condition_in,'')) LIKE '%not returned%' OR lower(COALESCE(rai.condition_in,'')) LIKE '%not-returned%'
      )
    ORDER BY rai.returned_at DESC,rai.id DESC`,args});
  return rows.map(x=>{const replacement=r2(Number(x.replacement_value||0)*Number(x.quantity_returned||0)),cost=r2(Number(x.unit_cost||0)*Number(x.quantity_returned||0)),exposure=Math.max(replacement,cost);return {signal_key:key(['rental_missing_asset_returned',x.agreement_item_id]),signal_type:'rental_missing_asset_marked_returned',category:'rental_leakage',severity:'critical',branch_id:x.branch_id,customer_id:x.customer_id,product_id:x.product_id,source_type:'rental_agreement',source_id:x.agreement_id,estimated_loss:0,at_risk_value:exposure,title:`Missing rental asset was historically marked returned: ${x.agreement_number}`,evidence:{branch_name:x.branch_name,agreement_item_id:x.agreement_item_id,product_name:x.product_name,sku:x.sku,is_accessory:x.parent_item_id!=null,is_mandatory_accessory:!!x.is_mandatory,quantity:Number(x.quantity||0),quantity_returned:Number(x.quantity_returned||0),condition_in:x.condition_in,damage_fee:r2(x.damage_fee),replacement_value_exposure:replacement,inventory_cost_exposure:cost,returned_at:x.returned_at},recommended_action:'Reconcile the physical asset immediately. A missing/lost unit marked returned can become falsely available for another rental. Verify branch stock, any replacement/damage charge, write-off/disposition evidence and customer settlement. Do not assume wrongdoing; correct inventory and accounting through controlled workflows.'};});
}
async function upsert(s,employeeId){
  if(!(await table('loss_control_cases')))throw new Error('Base loss-control module must initialize before rental reconciliation scans can record cases.');
  const {rows:[existing]}=await db.execute({sql:'SELECT id FROM loss_control_cases WHERE signal_key=?',args:[s.signal_key]});
  if(existing){await db.execute({sql:`UPDATE loss_control_cases SET signal_type=?,category=?,severity=?,branch_id=?,customer_id=?,product_id=?,source_type=?,source_id=?,title=?,estimated_loss=?,at_risk_value=?,evidence_json=?,recommended_action=?,last_detected_at=CURRENT_TIMESTAMP WHERE id=?`,args:[s.signal_type,s.category,s.severity,s.branch_id||null,s.customer_id||null,s.product_id||null,s.source_type,s.source_id,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence),s.recommended_action,existing.id]});return existing.id;}
  const r=await db.execute({sql:`INSERT INTO loss_control_cases(signal_key,signal_type,category,severity,branch_id,customer_id,product_id,source_type,source_id,title,estimated_loss,at_risk_value,evidence_json,recommended_action) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[s.signal_key,s.signal_type,s.category,s.severity,s.branch_id||null,s.customer_id||null,s.product_id||null,s.source_type,s.source_id,s.title,r2(s.estimated_loss),r2(s.at_risk_value),JSON.stringify(s.evidence),s.recommended_action]});
  const id=Number(r.lastInsertRowid);await db.execute({sql:'INSERT INTO loss_control_case_events(case_id,event_type,employee_id,details) VALUES(?,?,?,?)',args:[id,'detected',employeeId||null,'Historical missing rental asset was marked returned and requires physical/inventory reconciliation.']});return id;
}
router.get('/rental-missing-asset-signals',async(req,res)=>{try{const p=period(req),rows=await signals(p);res.json({period:p,count:rows.length,signals:rows,warning:'These are reconciliation gaps. They do not establish customer or employee misconduct.'});}catch(e){res.status(500).json({error:e.message});}});
router.post('/rental-missing-asset-scan',async(req,res)=>{try{const p=period(req),rows=await signals(p),ids=[];for(const s of rows)ids.push(await upsert(s,req.employee?.id));res.json({period:p,detected:rows.length,case_ids:ids,message:'Missing-asset reconciliation cases recorded. No rental, inventory, customer, accounting or employee record was changed automatically.'});}catch(e){res.status(500).json({error:e.message});}});
module.exports=router;
