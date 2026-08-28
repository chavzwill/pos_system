'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {can,requireAnyPermission}=require('../lib/permissions');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS rental_financial_override_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agreement_id INTEGER NOT NULL REFERENCES rental_agreements(id),
      agreement_number TEXT,
      branch_id INTEGER REFERENCES branches(id),
      employee_id INTEGER REFERENCES employees(id),
      authorizer_employee_id INTEGER NOT NULL REFERENCES employees(id),
      override_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_value TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_rental_fin_override_agreement ON rental_financial_override_events(agreement_id,created_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_rental_fin_override_authorizer ON rental_financial_override_events(authorizer_employee_id,created_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function settingBool(key,fallback=false){const {rows:[r]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});const v=String(r?.value??(fallback?'true':'false')).toLowerCase();return ['1','true','yes','on'].includes(v);}
async function authorize(req,reason){
  const pin=String(req.body?.rental_override_pin||'').trim();
  if(!pin)return {error:'Supervisor authorization is required for this rental financial override.'};
  if(String(reason||'').trim().length<5)return {error:'A meaningful rental override reason is required.'};
  const {rows:employees}=await db.execute({sql:'SELECT e.id,e.first_name,e.last_name,e.pin,sg.permissions FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id WHERE e.active=1',args:[]});
  const authorizer=employees.find(e=>String(e.pin)===pin&&(()=>{let p={};try{p=JSON.parse(e.permissions||'{}')}catch{}return can(p,'reports_financial')||can(p,'security_manage')||can(p,'rentals_manage');})());
  if(!authorizer)return {error:'Invalid supervisor PIN or insufficient financial-control authority.'};
  if(!await settingBool('loss_control_rental_override_allow_self',false)&&req.employee&&String(authorizer.id)===String(req.employee.id))return {error:'Independent supervisor authorization is required for rental financial overrides.'};
  return {authorizer,reason:String(reason).trim()};
}
async function persist(req,agreement,events){
  for(const ev of events){await db.execute({sql:`INSERT INTO rental_financial_override_events(agreement_id,agreement_number,branch_id,employee_id,authorizer_employee_id,override_type,reason,requested_value,evidence_json) VALUES(?,?,?,?,?,?,?,?,?)`,args:[agreement.id,agreement.agreement_number||null,agreement.branch_id||null,req.employee?.id||req.body?.employee_id||null,ev.authorizer.id,ev.type,ev.reason,ev.value==null?null:String(ev.value),JSON.stringify(ev.evidence||{})]});}
}
function damageLike(v){const s=String(v||'').trim().toLowerCase();return ['damage','broken','poor','missing','unusable','repair'].some(x=>s.includes(x));}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Rental loss-prevention initialization failed',detail:e.message});}});

router.patch('/agreements/:id/return',requireAnyPermission('rentals_returns','rentals'),async(req,res,next)=>{
  try{
    const {rows:[agreement]}=await db.execute({sql:'SELECT * FROM rental_agreements WHERE id=?',args:[req.params.id]});
    if(!agreement)return next();
    const events=[];
    let sharedAuth=null;
    const requireAuth=async(control)=>{if(sharedAuth)return sharedAuth;const auth=await authorize(req,req.body?.rental_override_reason);if(auth.error){res.status(409).json({error:auth.error,control});return null;}sharedAuth=auth;return auth;};
    if(req.body?.duration_adjustment_override!=null){
      const auth=await requireAuth('duration_adjustment_override');if(!auth)return;
      events.push({type:'duration_adjustment_override',reason:auth.reason,authorizer:auth.authorizer,value:req.body.duration_adjustment_override,evidence:{original_due_date:agreement.due_date,checkout_datetime:agreement.checkout_datetime||agreement.checkout_date}});
    }
    if(req.body?.returned_at){
      const backdateMinutes=(Date.now()-new Date(req.body.returned_at).getTime())/60000;
      const threshold=15;
      if(Number.isFinite(backdateMinutes)&&backdateMinutes>threshold){
        const auth=await requireAuth('backdated_return');if(!auth)return;
        events.push({type:'backdated_return',reason:auth.reason,authorizer:auth.authorizer,value:req.body.returned_at,evidence:{minutes_backdated:Number(backdateMinutes.toFixed(1)),threshold_minutes:threshold,server_time:new Date().toISOString()}});
      }
    }
    const returnItems=Array.isArray(req.body?.items)?req.body.items:[];
    if(returnItems.length){
      const {rows:storedItems}=await db.execute({sql:'SELECT * FROM rental_agreement_items WHERE agreement_id=?',args:[agreement.id]});
      for(const input of returnItems){
        const stored=storedItems.find(x=>String(x.id)===String(input.item_id));if(!stored)continue;
        const incomingCondition=String(input.condition_in||stored.condition_in||'').trim(),outgoingCondition=String(stored.condition_out||'').trim();
        const fee=Number(input.damage_fee||0);
        if(damageLike(incomingCondition)&&incomingCondition.toLowerCase()!==outgoingCondition.toLowerCase()&&fee<=0.01){
          const auth=await requireAuth('damage_fee_waiver');if(!auth)return;
          events.push({type:'damage_fee_waiver',reason:auth.reason,authorizer:auth.authorizer,value:0,evidence:{agreement_item_id:stored.id,product_id:stored.product_id,product_name:stored.product_name,sku:stored.sku,condition_out:outgoingCondition||null,condition_in:incomingCondition,damage_fee:fee,damage_notes:input.damage_notes||null,quantity_returned:Number(input.quantity_returned||0)}});
        }
      }
    }
    delete req.body.rental_override_pin;delete req.body.rental_override_reason;
    if(!events.length)return next();
    const originalJson=res.json.bind(res);let handled=false;
    res.json=function(payload){if(handled)return originalJson(payload);handled=true;if(res.statusCode>=200&&res.statusCode<300)return persist(req,agreement,events).then(()=>originalJson({...payload,rental_financial_override_recorded:true,rental_financial_override_types:events.map(x=>x.type)})).catch(err=>{if(!res.headersSent){res.status(500);return originalJson({error:'Rental return posted but override evidence failed to persist; reconciliation required',agreement_id:agreement.id,detail:err.message});}});return originalJson(payload);};
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch('/agreements/:id/collect-balance',requireAnyPermission('pos','rentals'),async(req,res,next)=>{
  try{
    const {rows:[agreement]}=await db.execute({sql:'SELECT * FROM rental_agreements WHERE id=?',args:[req.params.id]});
    if(!agreement)return next();
    const balance=Number((Number(agreement.damage_fee_total||0)+Number(agreement.duration_adjustment_total||0)-Number(agreement.deposit_total||0)+Number(agreement.tax_adjustment_total||0)).toFixed(2));
    const method=String(req.body?.payment_method||'cash');
    const tendered=Number(req.body?.amount_tendered??balance);
    if(balance>0&&method==='cash'){
      if(!Number.isFinite(tendered)||tendered+0.009<balance)return res.status(409).json({error:`Cash tendered cannot be less than the rental balance due (${balance.toFixed(2)}).`,balance_due:balance});
      const employeeId=Number(req.body?.employee_id||req.employee?.id)||null,drawerSessionId=Number(req.body?.drawer_session_id)||null,branchId=Number(req.body?.branch_id||agreement.branch_id)||null;
      if(!employeeId||!drawerSessionId)return res.status(409).json({error:'Cash rental settlement requires the cashier and an open drawer session.',control:'rental_cash_drawer'});
      const {rows:[drawer]}=await db.execute({sql:`SELECT ds.id,ds.employee_id,ds.branch_id,ds.status FROM drawer_sessions ds WHERE ds.id=?`,args:[drawerSessionId]});
      if(!drawer||drawer.status!=='open')return res.status(409).json({error:'The selected cash drawer session is not open.',control:'rental_cash_drawer'});
      if(Number(drawer.employee_id)!==employeeId)return res.status(409).json({error:'The cash drawer session belongs to a different employee.',control:'rental_cash_drawer'});
      if(branchId&&Number(drawer.branch_id)!==branchId)return res.status(409).json({error:'The cash drawer session belongs to a different branch.',control:'rental_cash_drawer'});
    }
    next();
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
module.exports.ensureSchema=ensureSchema;