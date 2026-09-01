'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {ensureSupplierProcurementBaseSchema}=require('../lib/supplier-procurement-base-schema');
async function validate(req,res,next){
  try{
    await ensureSupplierProcurementBaseSchema();
    const isUpdate=!!req.params.id,b=req.body||{};let existing=null;
    if(isUpdate){const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_product_offers WHERE id=?',args:[Number(req.params.id)]});if(!row)return res.status(404).json({error:'Supplier offer not found'});existing=row;}
    const merged={...(existing||{}),...b},supplierId=Number(merged.supplier_id),productId=Number(merged.product_id),supplierSku=String(merged.supplier_sku||'').trim(),currency=String(merged.currency||'JMD').trim().toUpperCase();
    if(!(supplierId>0&&productId>0))return res.status(400).json({error:'supplier_id and product_id are required'});
    if(!/^[A-Z]{3}$/.test(currency))return res.status(400).json({error:'currency must be a 3-letter ISO currency code'});
    const {rows:[supplier]}=await db.execute({sql:'SELECT id,name,active FROM suppliers WHERE id=?',args:[supplierId]});if(!supplier)return res.status(404).json({error:'Supplier not found'});if(!Number(supplier.active))return res.status(409).json({error:`Supplier ${supplier.name} is inactive; reactivate or review the supplier before recording a new offer`});
    const {rows:[product]}=await db.execute({sql:'SELECT id,name,active,is_service,is_non_inventory FROM products WHERE id=?',args:[productId]});if(!product)return res.status(404).json({error:'Product not found'});if(!Number(product.active)||Number(product.is_service)||Number(product.is_non_inventory))return res.status(409).json({error:`Supplier offer requires an active physical inventory product; ${product.name} is not eligible`});
    const {rows:[dup]}=await db.execute({sql:`SELECT id FROM supplier_product_offers WHERE supplier_id=? AND product_id=? AND lower(COALESCE(supplier_sku,''))=lower(?) AND id<>? LIMIT 1`,args:[supplierId,productId,supplierSku,isUpdate?Number(req.params.id):0]});if(dup)return res.status(409).json({error:'An offer already exists for this supplier, product, and supplier SKU. Update the existing offer so price history remains continuous.',existing_offer_id:dup.id});
    req.body.currency=currency;req.body.supplier_sku=supplierSku||null;next();
  }catch(e){res.status(500).json({error:e.message});}
}
router.post('/offers',validate);
router.put('/offers/:id',validate);
module.exports=router;
