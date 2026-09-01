'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,requirePermission,can}=require('../lib/permissions');
const {STANDARD_UNITS,code,standardDimension,convertStandard,ensureUomSchema,getProfile,resolveSellEconomics}=require('../lib/unit-of-measure');

function commerceAllowed(req){if(req.apiKey)return true;const perms=req.employee?.permissions||{};return['pos','transactions','purchasing','purchase_requests','purchasing_receive','quotations','transfers','inventory'].some(k=>can(perms,k));}
router.use(async(req,res,next)=>{try{await ensureUomSchema();next();}catch(e){res.status(500).json({error:'Unit-of-measure initialization failed',detail:e.message});}});
router.get('/standard-units',requirePermission('inventory'),(req,res)=>res.json(STANDARD_UNITS));
router.get('/convert',requirePermission('inventory'),(req,res)=>{try{res.json(convertStandard(req.query.value,req.query.from,req.query.to,Number(req.query.precision||6)));}catch(e){res.status(400).json({error:e.message});}});
router.get('/commerce/resolve-barcode',requireAuth,async(req,res)=>{
  try{
    if(!commerceAllowed(req))return res.status(403).json({error:'Not permitted to resolve selling-unit barcodes'});
    const barcode=String(req.query.barcode||'').trim();if(!barcode)return res.status(400).json({error:'barcode is required'});
    const {rows:[row]}=await db.execute({sql:`SELECT c.*,p.name product_name,p.sku product_sku,p.price product_price,p.tax_rate,p.stock_qty,p.active product_active FROM product_uom_conversions c JOIN products p ON p.id=c.product_id WHERE c.barcode=? AND c.active=1 AND c.sell_allowed=1 LIMIT 1`,args:[barcode]});
    if(!row||!row.product_active)return res.status(404).json({error:'No active selling unit matches this barcode'});
    const profile=await getProfile(db,row.product_id),economics=resolveSellEconomics(row.product_price,row);
    res.json({product:{id:row.product_id,name:row.product_name,sku:row.product_sku,price:row.product_price,tax_rate:row.tax_rate,stock_qty:row.stock_qty},unit:{uom_code:row.uom_code,uom_name:row.uom_name,factor_to_base:row.factor_to_base,barcode:row.barcode,sell_price:row.sell_price,sell_allowed:row.sell_allowed,purchase_allowed:row.purchase_allowed,is_base:false,effective_sell_price:economics.entered_unit_price,base_equivalent_sell_price:economics.base_unit_price,pricing_mode:economics.pricing_mode},profile});
  }catch(e){res.status(500).json({error:e.message});}
});
router.get('/commerce/products/:productId',requireAuth,async(req,res)=>{
  try{
    if(!commerceAllowed(req))return res.status(403).json({error:'Not permitted to view product units of measure'});
    const productId=Number(req.params.productId);const profile=await getProfile(db,productId);
    const {rows:[product]}=await db.execute({sql:'SELECT id,name,sku,price,tax_rate,stock_qty FROM products WHERE id=?',args:[productId]});if(!product)return res.status(404).json({error:'Product not found'});
    const {rows}=await db.execute({sql:'SELECT uom_code,uom_name,factor_to_base,sell_allowed,purchase_allowed,barcode,sell_price FROM product_uom_conversions WHERE product_id=? AND active=1 ORDER BY factor_to_base,uom_name',args:[productId]});
    const baseEconomics=resolveSellEconomics(product.price,{factor_to_base:1,sell_price:null});
    const base={uom_code:profile.base_uom,uom_name:profile.base_uom,factor_to_base:1,sell_allowed:1,purchase_allowed:1,barcode:null,sell_price:null,is_base:true,effective_sell_price:baseEconomics.entered_unit_price,base_equivalent_sell_price:baseEconomics.base_unit_price,pricing_mode:'base'};
    const units=[base,...rows.map(x=>{const economics=resolveSellEconomics(product.price,x);return{...x,is_base:false,effective_sell_price:economics.entered_unit_price,base_equivalent_sell_price:economics.base_unit_price,pricing_mode:economics.pricing_mode};})];
    res.json({profile,product,units});
  }catch(e){res.status(500).json({error:e.message});}
});
router.get('/usage',requireAuth,async(req,res)=>{
  try{
    const sourceType=String(req.query.source_type||'').trim(),sourceId=String(req.query.source_id||'').trim();if(!sourceType||!sourceId)return res.status(400).json({error:'source_type and source_id are required'});
    const {rows}=await db.execute({sql:'SELECT * FROM uom_usage_snapshots WHERE source_type=? AND source_id=? ORDER BY id',args:[sourceType,sourceId]});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});
router.get('/products/:productId',requirePermission('inventory'),async(req,res)=>{try{const productId=Number(req.params.productId);const profile=await getProfile(db,productId);const {rows:conversions}=await db.execute({sql:'SELECT * FROM product_uom_conversions WHERE product_id=? ORDER BY active DESC,uom_name',args:[productId]});res.json({profile,conversions});}catch(e){res.status(500).json({error:e.message});}});
router.put('/products/:productId/profile',requirePermission('inventory_edit'),async(req,res)=>{
  try{
    const productId=Number(req.params.productId),base=code(req.body?.base_uom||'each'),dimension=String(req.body?.dimension||standardDimension(base)||'count'),precision=Number(req.body?.base_precision||0);
    if(!Number.isInteger(productId)||productId<=0)return res.status(400).json({error:'Valid product id required'});
    if(!base)return res.status(400).json({error:'Base UOM is required'});
    if(!Number.isInteger(precision)||precision<0||precision>6)return res.status(400).json({error:'base_precision must be an integer from 0 to 6'});
    const {rows:[p]}=await db.execute({sql:'SELECT id FROM products WHERE id=?',args:[productId]});if(!p)return res.status(404).json({error:'Product not found'});
    const {rows:[history]}=await db.execute({sql:'SELECT id FROM uom_usage_snapshots WHERE product_id=? LIMIT 1',args:[productId]});
    const existing=await getProfile(db,productId);
    if(history&&(code(existing.base_uom)!==base||Number(existing.base_precision)!==precision))return res.status(409).json({error:'Base UOM or precision cannot be changed after transactional UOM history exists'});
    await db.execute({sql:`INSERT INTO product_uom_profiles(product_id,base_uom,dimension,base_precision,updated_by_employee_id,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id) DO UPDATE SET base_uom=excluded.base_uom,dimension=excluded.dimension,base_precision=excluded.base_precision,updated_by_employee_id=excluded.updated_by_employee_id,updated_at=CURRENT_TIMESTAMP`,args:[productId,base,dimension,precision,req.employee?.id||null]});
    await db.execute({sql:'UPDATE products SET unit=? WHERE id=?',args:[base,productId]});res.json(await getProfile(db,productId));
  }catch(e){res.status(500).json({error:e.message});}
});
router.post('/products/:productId/conversions',requirePermission('inventory_edit'),async(req,res)=>{
  try{
    const productId=Number(req.params.productId),uom=code(req.body?.uom_code),name=String(req.body?.uom_name||uom).trim(),factor=Number(req.body?.factor_to_base);
    const rawSellPrice=req.body?.sell_price;const sellPrice=rawSellPrice==null||rawSellPrice===''?null:Number(rawSellPrice);
    if(!uom||!name||!Number.isFinite(factor)||factor<=0)return res.status(400).json({error:'uom_code, uom_name and a positive factor_to_base are required'});
    if(sellPrice!=null&&(!Number.isFinite(sellPrice)||sellPrice<0))return res.status(400).json({error:'sell_price must be blank or a non-negative amount'});
    const barcode=String(req.body?.barcode||'').trim()||null;
    if(barcode){const {rows:[duplicate]}=await db.execute({sql:'SELECT product_id,uom_code FROM product_uom_conversions WHERE barcode=? AND NOT(product_id=? AND uom_code=?) LIMIT 1',args:[barcode,productId,uom]});if(duplicate)return res.status(409).json({error:'This packaging barcode is already assigned to another unit conversion'});}
    const profile=await getProfile(db,productId);if(uom===code(profile.base_uom))return res.status(409).json({error:'Do not create a conversion for the base UOM; its factor is always 1'});
    await db.execute({sql:`INSERT INTO product_uom_conversions(product_id,uom_code,uom_name,factor_to_base,sell_allowed,purchase_allowed,barcode,sell_price,active,updated_by_employee_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,uom_code) DO UPDATE SET uom_name=excluded.uom_name,factor_to_base=excluded.factor_to_base,sell_allowed=excluded.sell_allowed,purchase_allowed=excluded.purchase_allowed,barcode=excluded.barcode,sell_price=excluded.sell_price,active=excluded.active,updated_by_employee_id=excluded.updated_by_employee_id,updated_at=CURRENT_TIMESTAMP`,args:[productId,uom,name,factor,req.body?.sell_allowed===false?0:1,req.body?.purchase_allowed===false?0:1,barcode,sellPrice,req.body?.active===false?0:1,req.employee?.id||null]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM product_uom_conversions WHERE product_id=? AND uom_code=?',args:[productId,uom]});res.status(201).json(row);
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
