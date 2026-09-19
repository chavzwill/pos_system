'use strict';
const express=require('express');
const router=express.Router();
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const {db}=require('../database');
const {cloudUpload,cloudDestroy}=require('../lib/cloudinary');
const {requireAuth,requireAnyPermission}=require('../lib/permissions');

const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:5*1024*1024},
  fileFilter:(req,file,cb)=>cb(null,/^image\//.test(file.mimetype))
});
const clean=v=>String(v||'').trim();
const send=(res,status,error,code)=>res.status(status).json({error,code});
const nameConflict=e=>/unique constraint|idx_brands_name_normalized/i.test(String(e?.message||''));
const logoUpload=(req,res,next)=>upload.single('image')(req,res,error=>{
  if(!error)return next();
  if(error.code==='LIMIT_FILE_SIZE')return send(res,413,'Brand logo must be 5 MB or smaller.','BRAND_LOGO_TOO_LARGE');
  console.warn('brand_logo_upload_rejected',{code:error.code||'UPLOAD_REJECTED'});
  return send(res,400,'Choose a valid image file.','BRAND_LOGO_INVALID');
});

router.get('/',requireAuth,async(req,res)=>{
  try{
    const includeInactive=String(req.query.include_inactive||'')==='1';
    const {rows}=await db.execute({sql:`SELECT b.*,COUNT(p.id) product_count,
      SUM(CASE WHEN p.active=1 THEN 1 ELSE 0 END) active_product_count
      FROM brands b LEFT JOIN products p ON p.brand_id=b.id
      ${includeInactive?'':'WHERE b.active=1'} GROUP BY b.id ORDER BY b.name`,args:[]});
    res.json(rows);
  }catch(e){console.error('brand_list_error',{message:e?.message||'unknown'});send(res,500,'Unable to load brands right now.','BRAND_LIST_UNAVAILABLE');}
});
router.post('/',requireAnyPermission('settings','inventory'),async(req,res)=>{
  const name=clean(req.body?.name),description=clean(req.body?.description)||null;
  if(!name)return send(res,400,'Brand name is required.','BRAND_NAME_REQUIRED');
  try{
    const result=await db.execute({sql:`INSERT INTO brands(name,description,active)
      SELECT ?,?,1 WHERE NOT EXISTS(SELECT 1 FROM brands WHERE lower(trim(name))=lower(trim(?)))`,args:[name,description,name]});
    if(Number(result.rowsAffected||0)!==1)return send(res,409,'A brand with this name already exists.','BRAND_NAME_EXISTS');
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM brands WHERE id=?',args:[Number(result.lastInsertRowid)]});
    res.status(201).json(row);
  }catch(e){
    if(nameConflict(e))return send(res,409,'A brand with this name already exists.','BRAND_NAME_EXISTS');
    console.error('brand_create_error',{code:e?.code||'unknown'});send(res,500,'Unable to create this brand right now.','BRAND_CREATE_UNAVAILABLE');
  }
});

router.put('/:id',requireAnyPermission('settings','inventory'),async(req,res)=>{
  const id=Number(req.params.id),name=clean(req.body?.name),description=clean(req.body?.description)||null,active=Number(req.body?.active)===0?0:1;
  if(!Number.isInteger(id)||id<=0)return send(res,400,'A valid brand is required.','BRAND_ID_INVALID');
  if(!name)return send(res,400,'Brand name is required.','BRAND_NAME_REQUIRED');
  try{
    if(active===0){
      const {rows:[assigned]}=await db.execute({sql:'SELECT COUNT(*) c FROM products WHERE brand_id=? AND active=1',args:[id]});
      if(Number(assigned?.c||0)>0)return send(res,409,'Move active products to another brand before making this brand inactive.','BRAND_IN_USE');
    }
    const result=await db.execute({sql:`UPDATE brands SET name=?,description=?,active=? WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM brands other WHERE other.id<>? AND lower(trim(other.name))=lower(trim(?)))`,args:[name,description,active,id,id,name]});
    if(Number(result.rowsAffected||0)!==1){
      const {rows:[existing]}=await db.execute({sql:'SELECT id FROM brands WHERE id=?',args:[id]});
      if(!existing)return send(res,404,'Brand not found.','BRAND_NOT_FOUND');
      return send(res,409,'A brand with this name already exists.','BRAND_NAME_EXISTS');
    }
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM brands WHERE id=?',args:[id]});
    res.json(row);
  }catch(e){
    if(nameConflict(e))return send(res,409,'A brand with this name already exists.','BRAND_NAME_EXISTS');
    console.error('brand_update_error',{code:e?.code||'unknown'});send(res,500,'Unable to update this brand right now.','BRAND_UPDATE_UNAVAILABLE');
  }
});

router.delete('/:id',requireAnyPermission('settings','inventory'),async(req,res)=>{
  try{
    const {rows:[inUse]}=await db.execute({sql:'SELECT COUNT(*) c FROM products WHERE brand_id=?',args:[req.params.id]});
    if(Number(inUse?.c||0)>0)return send(res,409,'Move the products to another brand before deleting it.','BRAND_IN_USE');
    const {rows:[brand]}=await db.execute({sql:'SELECT logo_path FROM brands WHERE id=?',args:[req.params.id]});
    if(!brand)return send(res,404,'Brand not found.','BRAND_NOT_FOUND');
    if(brand.logo_path?.startsWith('https://'))await cloudDestroy(brand.logo_path);
    else if(brand.logo_path){const old=path.join(__dirname,'..',brand.logo_path);if(fs.existsSync(old))fs.unlinkSync(old);}
    await db.execute({sql:'DELETE FROM brands WHERE id=?',args:[req.params.id]});
    res.json({success:true});
  }catch(e){console.error('brand_delete_error',{message:e?.message||'unknown'});send(res,500,'Unable to delete this brand right now.','BRAND_DELETE_UNAVAILABLE');}
});
router.delete('/:id/logo',requireAnyPermission('settings','inventory'),async(req,res)=>{
  try{
    const {rows:[brand]}=await db.execute({sql:'SELECT id,logo_path FROM brands WHERE id=?',args:[req.params.id]});
    if(!brand)return send(res,404,'Brand not found.','BRAND_NOT_FOUND');
    if(brand.logo_path?.startsWith('https://'))await cloudDestroy(brand.logo_path);
    else if(brand.logo_path){const old=path.join(__dirname,'..',brand.logo_path);if(fs.existsSync(old))fs.unlinkSync(old);}
    await db.execute({sql:'UPDATE brands SET logo_path=NULL WHERE id=?',args:[req.params.id]});
    res.json({success:true,logo_path:null});
  }catch(e){console.error('brand_logo_remove_error',{code:e?.code||'unknown'});send(res,500,'Unable to remove this brand logo right now.','BRAND_LOGO_REMOVE_UNAVAILABLE');}
});
router.post('/:id/logo',requireAnyPermission('settings','inventory'),logoUpload,async(req,res)=>{
  if(!req.file)return send(res,400,'Choose an image to upload.','BRAND_LOGO_REQUIRED');
  try{
    const {rows:[brand]}=await db.execute({sql:'SELECT id,logo_path FROM brands WHERE id=?',args:[req.params.id]});
    if(!brand)return send(res,404,'Brand not found.','BRAND_NOT_FOUND');
    if(brand.logo_path?.startsWith('https://'))await cloudDestroy(brand.logo_path);
    else if(brand.logo_path){const old=path.join(__dirname,'..',brand.logo_path);if(fs.existsSync(old))fs.unlinkSync(old);}
    const result=await cloudUpload(req.file.buffer,{folder:'pos-system/brands',public_id:`brand-${req.params.id}`,overwrite:true,resource_type:'image'});
    let logoPath=result?.secure_url||null;
    if(!logoPath){
      const dir=path.join(__dirname,'../uploads/brands');fs.mkdirSync(dir,{recursive:true});
      const ext=path.extname(req.file.originalname).toLowerCase()||'.img';
      const filename=`brand-${req.params.id}-${Date.now()}${ext}`;fs.writeFileSync(path.join(dir,filename),req.file.buffer);logoPath=`/uploads/brands/${filename}`;
    }
    await db.execute({sql:'UPDATE brands SET logo_path=? WHERE id=?',args:[logoPath,req.params.id]});
    res.json({logo_path:logoPath});
  }catch(e){console.error('brand_logo_error',{message:e?.message||'unknown'});send(res,500,'Unable to save this brand logo right now.','BRAND_LOGO_UNAVAILABLE');}
});
module.exports=router;
