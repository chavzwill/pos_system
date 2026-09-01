'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const {cloudDestroy}=require('../lib/cloudinary');
const {validateMemoryUpload,imageMulterFilter}=require('../lib/uploadSecurity');

const clean=v=>String(v??'').trim();
const finiteNonNegative=v=>{const n=Number(v??0);return Number.isFinite(n)&&n>=0?n:null;};
const secureIdUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:4},fileFilter:imageMulterFilter});
const SENSITIVE_CUSTOMER_FIELDS=[
  'rental_id_number',
  'rental_id_scan_path',
  'rental_address_proof_type',
  'rental_address_proof_details',
  'rental_reference_name',
  'rental_reference_phone',
  'rental_reference_relationship',
  'tax_exemption_number',
];
const SENSITIVE_CUSTOMER_WRITE_FIELDS=[
  'rental_id_type',
  'rental_id_number',
  'rental_address_proof_type',
  'rental_address_proof_details',
  'rental_reference_name',
  'rental_reference_phone',
  'rental_reference_relationship',
  'tax_exempt',
  'tax_exemption_number',
];
function mayViewSensitive(req){
  if(req.apiKey)return false;
  return can(req.employee?.permissions,'customers_sensitive') || can(req.employee?.permissions,'security_manage');
}
function redactCustomer(customer){
  if(!customer||typeof customer!=='object'||Array.isArray(customer))return customer;
  const out={...customer};
  for(const key of SENSITIVE_CUSTOMER_FIELDS)delete out[key];
  if(out.rental_id_type)out.rental_identity_on_file=true;
  if(out.tax_exempt)out.tax_exemption_on_file=true;
  return out;
}
function redactPayload(payload){
  if(Array.isArray(payload))return payload.map(redactCustomer);
  if(payload&&typeof payload==='object'&&('customer_number'in payload||'rental_id_number'in payload||'rental_id_scan_path'in payload))return redactCustomer(payload);
  return payload;
}
function redactSensitiveCustomerReads(req,res,next){
  if(req.method!=='GET'||mayViewSensitive(req))return next();
  const original=res.json.bind(res);
  res.json=payload=>original(redactPayload(payload));
  res.setHeader('X-Customer-Data-Scope','minimized');
  next();
}
function sensitiveWriteRequested(body){
  return SENSITIVE_CUSTOMER_WRITE_FIELDS.some(key=>Object.prototype.hasOwnProperty.call(body||{},key));
}
function requireSensitiveCustomerWrite(req,res,next){
  if(!sensitiveWriteRequested(req.body))return next();
  if(req.apiKey)return res.status(403).json({error:'Integration API keys cannot write customer identity/compliance data'});
  if(can(req.employee?.permissions,'customers_sensitive')||can(req.employee?.permissions,'security_manage'))return next();
  return res.status(403).json({error:'Missing permission: customers_sensitive'});
}
function employeeSensitiveOnly(req,res,next){
  if(req.apiKey)return res.status(403).json({error:'Integration API keys cannot access customer identity documents'});
  return requirePermission('customers_sensitive')(req,res,next);
}
async function removeExistingIdentityScan(existingPath){
  if(!existingPath)return;
  if(String(existingPath).startsWith('https://'))return cloudDestroy(existingPath);
  const relative=String(existingPath).replace(/^\/+/, '');
  const root=path.resolve(__dirname,'..');
  const resolved=path.resolve(root,relative);
  const allowedRoot=path.resolve(root,'uploads','customer-ids')+path.sep;
  if(!resolved.startsWith(allowedRoot))throw new Error('Stored identity document path is outside the protected evidence directory');
  if(fs.existsSync(resolved))fs.unlinkSync(resolved);
}
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
  }catch(e){res.status(500).json({error:'Unable to validate customer uniqueness'});}
}
router.use(redactSensitiveCustomerReads);
router.post('/:id/id-scan',employeeSensitiveOnly,secureIdUpload.single('id_scan'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'A JPEG, PNG, or WebP identity image is required'});
  const validation=validateMemoryUpload(req.file,{kind:'image'});
  if(!validation.ok)return res.status(415).json({error:validation.error});
  try{
    const {rows:[customer]}=await db.execute({sql:'SELECT id,rental_id_scan_path FROM customers WHERE id=?',args:[req.params.id]});
    if(!customer)return res.status(404).json({error:'Customer not found'});
    const dir=path.join(__dirname,'../uploads/customer-ids');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const filename=`customer-${Number(req.params.id)}-${Date.now()}${validation.extension}`;
    const fullPath=path.join(dir,filename);
    fs.writeFileSync(fullPath,req.file.buffer,{mode:0o600});
    try{
      await db.execute({sql:'UPDATE customers SET rental_id_scan_path=? WHERE id=?',args:[`/uploads/customer-ids/${filename}`,req.params.id]});
      await removeExistingIdentityScan(customer.rental_id_scan_path);
    }catch(error){try{fs.unlinkSync(fullPath);}catch(_){}throw error;}
    res.setHeader('Cache-Control','private, no-store');
    res.json({rental_id_scan_path:`/uploads/customer-ids/${filename}`});
  }catch(e){res.status(500).json({error:'Unable to store customer identity document'});}
});
router.delete('/:id/id-scan',employeeSensitiveOnly,async(req,res)=>{
  try{
    const {rows:[customer]}=await db.execute({sql:'SELECT id,rental_id_scan_path FROM customers WHERE id=?',args:[req.params.id]});
    if(!customer)return res.status(404).json({error:'Customer not found'});
    await removeExistingIdentityScan(customer.rental_id_scan_path);
    await db.execute({sql:'UPDATE customers SET rental_id_scan_path=NULL WHERE id=?',args:[req.params.id]});
    res.json({success:true});
  }catch(e){res.status(500).json({error:'Unable to remove customer identity document'});}
});
router.post('/',requirePermission('customers_add'),requireSensitiveCustomerWrite,normalize,duplicate);
router.put('/:id',requirePermission('customers_edit'),requireSensitiveCustomerWrite,normalize,duplicate);
module.exports=router;
module.exports.SENSITIVE_CUSTOMER_FIELDS=SENSITIVE_CUSTOMER_FIELDS;
module.exports.redactCustomer=redactCustomer;
module.exports.requireSensitiveCustomerWrite=requireSensitiveCustomerWrite;
