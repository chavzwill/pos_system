'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {MODES,ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');

router.use('/uom',require('./unit-of-measure'));
router.use('/compositions',require('./product-compositions'));
router.use('/composition-procurement',require('./product-composition-procurement'));
router.use('/procurement-fx',require('./procurement-fx'));
router.use('/composition-supplier-procurement',require('./procurement-price-break-history'));
router.use('/composition-supplier-procurement',require('./procurement-offer-integrity-guard'));
router.use('/composition-supplier-procurement',require('./procurement-currency-guard'));
router.use('/composition-supplier-procurement',require('./product-composition-supplier-procurement'));
router.use('/procurement-governance',require('./procurement-decision-governance'));
router.use('/procurement-market',require('./procurement-market-alerts-hardening'));
router.use('/procurement-market',require('./procurement-what-changed-hardening'));
router.use('/procurement-market',require('./procurement-market-intelligence'));
router.use('/procurement-outcomes',require('./procurement-outcome-intelligence'));
router.use('/accounting-retail-cogs',require('./accounting-retail-cogs-sync'));
router.use('/rental-economics',require('./rental-asset-economics-bootstrap'));
router.use('/rental-economics',require('./rental-asset-economics-financial-guard'));
router.use('/rental-economics',require('./rental-asset-lifecycle'));
router.use('/rental-economics',require('./rental-asset-lifetime-economics').router);
router.use('/loss-control',require('./loss-control-intelligence'));
router.use('/loss-control',require('./loss-control-expanded'));
router.use('/loss-control',require('./loss-control-operational-leaks'));
router.use('/loss-control',require('./loss-control-commercial-service-leaks'));
router.use('/loss-control',require('./loss-control-rental-leaks'));
router.use('/loss-control',require('./loss-control-rental-payment-leaks'));
router.use('/loss-control',require('./loss-control-rental-missing-asset-reconciliation'));
router.use('/loss-control',require('./loss-control-rental-missing-asset-leaks'));
router.use('/loss-control',require('./loss-control-supplier-payment-near-duplicates'));
router.use('/loss-control',require('./loss-control-writeoff-leaks'));
router.use('/loss-control',require('./loss-control-systemic-margin-intelligence'));
router.use('/loss-control',require('./loss-control-value-preservation'));
router.use('/loss-control',require('./loss-control-economic-depth'));
router.use('/loss-control',require('./loss-control-unit-economics'));
router.use(async(req,res,next)=>{try{await ensureInventoryTraceability();next();}catch(e){res.status(500).json({error:'Inventory traceability initialization failed',detail:e.message});}});

router.get('/profiles/:productId',requirePermission('inventory'),async(req,res)=>{
  try{res.json(await getTrackingProfile(db,Number(req.params.productId)));}catch(e){res.status(500).json({error:e.message});}
});

router.put('/profiles/:productId',requirePermission('inventory_edit'),async(req,res)=>{
  try{
    const productId=Number(req.params.productId),mode=String(req.body?.tracking_mode||'none').toLowerCase();
    if(!Number.isInteger(productId)||productId<=0)return res.status(400).json({error:'Valid product id required'});
    if(!MODES.has(mode))return res.status(400).json({error:'tracking_mode must be none, lot, or serial'});
    const {rows:[product]}=await db.execute({sql:'SELECT id,is_service,is_non_inventory FROM products WHERE id=?',args:[productId]});
    if(!product)return res.status(404).json({error:'Product not found'});
    if(product.is_service||product.is_non_inventory)return res.status(409).json({error:'Only physical inventory products can use serial/lot tracking'});
    const {rows:[existing]}=await db.execute({sql:'SELECT tracking_mode FROM inventory_tracking_profiles WHERE product_id=?',args:[productId]});
    if(existing&&existing.tracking_mode!==mode){
      const {rows:[evidence]}=await db.execute({sql:`SELECT (SELECT COUNT(*) FROM inventory_serials WHERE product_id=?) serials,(SELECT COUNT(*) FROM inventory_lots WHERE product_id=?) lots`,args:[productId,productId]});
      if(Number(evidence?.serials||0)+Number(evidence?.lots||0)>0)return res.status(409).json({error:'Tracking mode cannot be changed after serial/lot identity history exists'});
    }
    await db.execute({sql:`INSERT INTO inventory_tracking_profiles(product_id,tracking_mode,expiry_required,manufacture_date_required,updated_by_employee_id,updated_at)
      VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(product_id) DO UPDATE SET tracking_mode=excluded.tracking_mode,expiry_required=excluded.expiry_required,manufacture_date_required=excluded.manufacture_date_required,updated_by_employee_id=excluded.updated_by_employee_id,updated_at=CURRENT_TIMESTAMP`,args:[productId,mode,req.body?.expiry_required?1:0,req.body?.manufacture_date_required?1:0,req.employee?.id||null]});
    res.json(await getTrackingProfile(db,productId));
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/lots',requirePermission('inventory'),async(req,res)=>{
  try{
    const args=[];let sql=`SELECT l.*,p.name product_name,p.sku,b.name branch_name,sb.bin_code FROM inventory_lots l JOIN products p ON p.id=l.product_id JOIN branches b ON b.id=l.branch_id LEFT JOIN storage_bins sb ON sb.id=l.bin_id WHERE 1=1`;
    if(req.query.product_id){sql+=' AND l.product_id=?';args.push(req.query.product_id);}
    if(req.query.branch_id){sql+=' AND l.branch_id=?';args.push(req.query.branch_id);}
    if(req.query.status){sql+=' AND l.status=?';args.push(req.query.status);}
    if(req.query.expiring_before){sql+=' AND l.expiry_date IS NOT NULL AND date(l.expiry_date)<=date(?)';args.push(req.query.expiring_before);}
    sql+=' ORDER BY CASE WHEN l.expiry_date IS NULL THEN 1 ELSE 0 END,l.expiry_date,l.created_at,l.id LIMIT 500';
    const {rows}=await db.execute({sql,args});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/serials',requirePermission('inventory'),async(req,res)=>{
  try{
    const args=[];let sql=`SELECT s.*,p.name product_name,p.sku,b.name branch_name,sb.bin_code FROM inventory_serials s JOIN products p ON p.id=s.product_id JOIN branches b ON b.id=s.branch_id LEFT JOIN storage_bins sb ON sb.id=s.bin_id WHERE 1=1`;
    if(req.query.serial_number){sql+=' AND lower(s.serial_number)=lower(?)';args.push(req.query.serial_number);}
    if(req.query.product_id){sql+=' AND s.product_id=?';args.push(req.query.product_id);}
    if(req.query.branch_id){sql+=' AND s.branch_id=?';args.push(req.query.branch_id);}
    if(req.query.status){sql+=' AND s.status=?';args.push(req.query.status);}
    sql+=' ORDER BY s.created_at DESC,s.id DESC LIMIT 500';
    const {rows}=await db.execute({sql,args});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/events',requirePermission('inventory'),async(req,res)=>{
  try{
    const args=[];let sql=`SELECT e.*,p.name product_name,p.sku,s.serial_number,l.lot_number,b.name branch_name FROM inventory_identity_events e JOIN products p ON p.id=e.product_id LEFT JOIN inventory_serials s ON s.id=e.serial_id LEFT JOIN inventory_lots l ON l.id=e.lot_id LEFT JOIN branches b ON b.id=e.branch_id WHERE 1=1`;
    if(req.query.product_id){sql+=' AND e.product_id=?';args.push(req.query.product_id);}
    if(req.query.branch_id){sql+=' AND e.branch_id=?';args.push(req.query.branch_id);}
    sql+=' ORDER BY e.created_at DESC,e.id DESC LIMIT 500';
    const {rows}=await db.execute({sql,args});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;