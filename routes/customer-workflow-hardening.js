'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const {cloudDestroy}=require('../lib/cloudinary');
const {validateMemoryUpload,imageMulterFilter}=require('../lib/uploadSecurity');

const clean=v=>String(v??'').trim();
const finiteNonNegative=v=>{const n=Number(v??0);return Number.isFinite(n)&&n>=0?n:null;};
const PUBLIC_ID_DIR=path.resolve(__dirname,'../uploads/customer-ids');
const PROTECTED_ID_DIR=path.resolve(__dirname,'../protected_uploads/customer-ids');
fs.mkdirSync(PROTECTED_ID_DIR,{recursive:true,mode:0o700});
try{
  // This module is loaded before the server begins listening. Move any legacy
  // local identity scans out of the generic /uploads static tree immediately,
  // so old database URLs cannot remain anonymously retrievable during startup.
  if(fs.existsSync(PUBLIC_ID_DIR)){
    for(const entry of fs.readdirSync(PUBLIC_ID_DIR,{withFileTypes:true})){
      if(!entry.isFile())continue;
      const source=path.join(PUBLIC_ID_DIR,entry.name),target=path.join(PROTECTED_ID_DIR,path.basename(entry.name));
      if(!fs.existsSync(target)){
        try{fs.renameSync(source,target);}catch(_){fs.copyFileSync(source,target);fs.unlinkSync(source);}
      }else fs.unlinkSync(source);
      try{fs.chmodSync(target,0o600);}catch(_){}
    }
  }
}catch(error){console.error('Unable to quarantine legacy customer identity scans:',error&&error.message);}

const secureIdUpload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:5*1024*1024,files:1,fields:4,parts:5,fieldNameSize:100,fieldSize:64*1024,headerPairs:50},
  fileFilter:imageMulterFilter,
});
const SENSITIVE_CUSTOMER_FIELDS=[
  'rental_id_number','rental_id_scan_path','rental_address_proof_type','rental_address_proof_details',
  'rental_reference_name','rental_reference_phone','rental_reference_relationship','tax_exemption_number',
];
const SENSITIVE_CUSTOMER_WRITE_FIELDS=[
  'rental_id_type','rental_id_number','rental_address_proof_type','rental_address_proof_details',
  'rental_reference_name','rental_reference_phone','rental_reference_relationship','tax_exempt','tax_exemption_number',
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
function sensitiveWriteRequested(body){return SENSITIVE_CUSTOMER_WRITE_FIELDS.some(key=>Object.prototype.hasOwnProperty.call(body||{},key));}
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
function filenameFromStoredPath(storedPath){
  if(!storedPath||String(storedPath).startsWith('https://'))return null;
  const value=String(storedPath);
  if(value.startsWith('/uploads/customer-ids/'))return path.basename(value);
  const marker='/id-scan/content?file=';
  const index=value.indexOf(marker);
  if(index>=0){try{return path.basename(decodeURIComponent(value.slice(index+marker.length)));}catch(_){return null;}}
  return null;
}
async function removeExistingIdentityScan(existingPath){
  if(!existingPath)return;
  if(String(existingPath).startsWith('https://'))return cloudDestroy(existingPath);
  const filename=filenameFromStoredPath(existingPath);
  if(!filename)throw new Error('Stored identity document path is not recognized as protected evidence');
  const resolved=path.resolve(PROTECTED_ID_DIR,filename);
  if(!resolved.startsWith(PROTECTED_ID_DIR+path.sep))throw new Error('Stored identity document path escapes protected evidence storage');
  if(fs.existsSync(resolved))fs.unlinkSync(resolved);
}
function normalize(req,res,next){
  const b=req.body||{};
  b.first_name=clean(b.first_name);b.last_name=clean(b.last_name);
  if(!b.first_name||!b.last_name)return res.status(400).json({error:'First and last name required'});
  b.email=clean(b.email).toLowerCase()||null;b.phone=clean(b.phone)||null;
  if(b.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))return res.status(400).json({error:'Enter a valid customer email address'});
  const type=clean(b.customer_type||'cash').toLowerCase();
  if(!['cash','credit'].includes(type))return res.status(400).json({error:'Customer type must be cash or credit'});
  b.customer_type=type;
  const terms=Number.parseInt(b.credit_terms_days??30,10),limit=finiteNonNegative(b.credit_limit);
  if(!Number.isInteger(terms)||terms<0||terms>3650)return res.status(400).json({error:'Credit terms must be between 0 and 3650 days'});
  if(limit===null)return res.status(400).json({error:'Credit limit must be zero or greater'});
  b.credit_terms_days=terms;b.credit_limit=limit;if(type!=='credit'){b.credit_terms_days=30;b.credit_limit=0;}
  b.tax_exemption_number=clean(b.tax_exemption_number)||null;
  if(b.tax_exempt&&!b.tax_exemption_number)return res.status(400).json({error:'Tax-exempt customers require an exemption/reference number'});
  next();
}
async function duplicate(req,res,next){
  try{
    const email=req.body.email,phone=req.body.phone,id=req.params.id||null;if(!email&&!phone)return next();
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

router.get('/:id/id-scan/content',employeeSensitiveOnly,async(req,res)=>{
  try{
    const {rows:[customer]}=await db.execute({sql:'SELECT id,rental_id_scan_path FROM customers WHERE id=?',args:[req.params.id]});
    if(!customer)return res.status(404).json({error:'Customer not found'});
    if(!customer.rental_id_scan_path)return res.status(404).json({error:'Identity document not found'});
    if(String(customer.rental_id_scan_path).startsWith('https://')){
      res.setHeader('Cache-Control','private, no-store');
      return res.redirect(customer.rental_id_scan_path);
    }
    const filename=filenameFromStoredPath(customer.rental_id_scan_path);
    if(!filename)return res.status(404).json({error:'Identity document not found'});
    if(req.query.file&&path.basename(String(req.query.file))!==filename)return res.status(404).json({error:'Identity document not found'});
    const filePath=path.resolve(PROTECTED_ID_DIR,filename);
    if(!filePath.startsWith(PROTECTED_ID_DIR+path.sep)||!fs.existsSync(filePath))return res.status(404).json({error:'Identity document not found'});
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('Content-Disposition',`inline; filename="identity-document${path.extname(filename)}"`);
    res.type(path.extname(filename));
    res.sendFile(filePath);
  }catch(e){res.status(500).json({error:'Unable to load customer identity document'});}
});
router.post('/:id/id-scan',employeeSensitiveOnly,secureIdUpload.single('id_scan'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'A JPEG, PNG, or WebP identity image is required'});
  const validation=validateMemoryUpload(req.file,{kind:'image'});if(!validation.ok)return res.status(415).json({error:validation.error});
  try{
    const customerId=Number(req.params.id);
    const {rows:[customer]}=await db.execute({sql:'SELECT id,rental_id_scan_path FROM customers WHERE id=?',args:[customerId]});
    if(!customer)return res.status(404).json({error:'Customer not found'});
    fs.mkdirSync(PROTECTED_ID_DIR,{recursive:true,mode:0o700});
    const filename=`customer-${customerId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${validation.extension}`;
    const fullPath=path.join(PROTECTED_ID_DIR,filename);
    fs.writeFileSync(fullPath,req.file.buffer,{mode:0o600});
    const contentUrl=`/api/customers/${customerId}/id-scan/content?file=${encodeURIComponent(filename)}`;
    try{
      await db.execute({sql:'UPDATE customers SET rental_id_scan_path=? WHERE id=?',args:[contentUrl,customerId]});
      await removeExistingIdentityScan(customer.rental_id_scan_path);
    }catch(error){try{fs.unlinkSync(fullPath);}catch(_){}throw error;}
    res.setHeader('Cache-Control','private, no-store');
    res.json({rental_id_scan_path:contentUrl});
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
module.exports.filenameFromStoredPath=filenameFromStoredPath;
