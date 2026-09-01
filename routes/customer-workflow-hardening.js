'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

const clean=v=>String(v??'').trim();
const finiteNonNegative=v=>{const n=Number(v??0);return Number.isFinite(n)&&n>=0?n:null;};
function normalize(req,res,next){
  const b=req.body||{};
  b.first_name=clean(b.first_name);b.last_name=clean(b.last_name);
  if(!b.first_name||!b.last_name)return res.status(400).json({error:'First and last name required'});
  b.email=clean(b.email).toLowerCase()||null;
  b.phone=clean(b.phone)||null;
  if(b.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))return res.status(400).json({error:'Enter a valid customer email address'});
  const type=clean(b.customer_type||'cash').toLowerCase();
  if(!['cash','credit'].includes(type))return res.status(400).json({error:'Customer type must be cash or credit'});
  b.customer_type=type;
  const terms=Number.parseInt(b.credit_terms_days??30,10);
  const limit=finiteNonNegative(b.credit_limit);
  if(!Number.isInteger(terms)||terms<0||terms>3650)return res.status(400).json({error:'Credit terms must be between 0 and 3650 days'});
  if(limit===null)return res.status(400).json({error:'Credit limit must be zero or greater'});
  b.credit_terms_days=terms;b.credit_limit=limit;
  if(type!=='credit'){b.credit_terms_days=30;b.credit_limit=0;}
  b.tax_exemption_number=clean(b.tax_exemption_number)||null;
  if(b.tax_exempt&&!b.tax_exemption_number)return res.status(400).json({error:'Tax-exempt customers require an exemption/reference number'});
  next();
}
async function duplicate(req,res,next){
  try{
    const email=req.body.email,phone=req.body.phone,id=req.params.id||null;
    if(!email&&!phone)return next();
    const where=[];const args=[];
    if(email){where.push('LOWER(email)=LOWER(?)');args.push(email);}
    if(phone){where.push("REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')','')=REPLACE(REPLACE(REPLACE(REPLACE(?,' ',''),'-',''),'(',''),')','')");args.push(phone);}
    let sql=`SELECT id,customer_number,first_name,last_name,email,phone FROM customers WHERE active=1 AND (${where.join(' OR ')})`;
    if(id){sql+=' AND id!=?';args.push(id);}
    const {rows:[hit]}=await db.execute({sql,args});
    if(hit)return res.status(409).json({error:`A customer with this ${email&&hit.email&&String(hit.email).toLowerCase()===email?'email':'phone number'} already exists`,existing_customer:{id:hit.id,customer_number:hit.customer_number,name:`${hit.first_name||''} ${hit.last_name||''}`.trim()}});
    next();
  }catch(e){res.status(500).json({error:e.message});}
}
router.post('/',requirePermission('customers_add'),normalize,duplicate);
router.put('/:id',requirePermission('customers_edit'),normalize,duplicate);
module.exports=router;
