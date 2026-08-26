'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {ensurePurchaseReceivingControls,getReceivingControl}=require('../lib/purchase-receiving-controls');
const {moveStockStatus}=require('../lib/inventory-stock-status');

router.use(async(req,res,next)=>{try{await ensurePurchaseReceivingControls();next();}catch(e){res.status(500).json({error:'Receiving-control initialization failed',detail:e.message});}});

router.get('/products/:productId',requirePermission('purchasing'),async(req,res)=>{
  try{res.json(await getReceivingControl(db,Number(req.params.productId)));}catch(e){res.status(500).json({error:e.message});}
});
router.put('/products/:productId',requirePermission('purchasing_approve'),async(req,res)=>{
  try{
    const productId=Number(req.params.productId),tolerance=Number(req.body?.overreceipt_tolerance_pct||0);
    if(!Number.isInteger(productId)||productId<=0)return res.status(400).json({error:'Valid product id required'});
    if(!Number.isFinite(tolerance)||tolerance<0||tolerance>100)return res.status(400).json({error:'overreceipt_tolerance_pct must be from 0 to 100'});
    const {rows:[p]}=await db.execute({sql:'SELECT id FROM products WHERE id=?',args:[productId]});if(!p)return res.status(404).json({error:'Product not found'});
    await db.execute({sql:`INSERT INTO product_receiving_controls(product_id,inspection_required,overreceipt_tolerance_pct,updated_by_employee_id,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(product_id) DO UPDATE SET inspection_required=excluded.inspection_required,overreceipt_tolerance_pct=excluded.overreceipt_tolerance_pct,updated_by_employee_id=excluded.updated_by_employee_id,updated_at=CURRENT_TIMESTAMP`,args:[productId,req.body?.inspection_required?1:0,tolerance,req.employee?.id||null]});
    res.json(await getReceivingControl(db,productId));
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/exceptions',requirePermission('purchasing'),async(req,res)=>{
  try{
    const args=[];let sql=`SELECT e.*,po.po_number,p.name product_name,p.sku FROM purchase_receipt_exceptions e JOIN purchase_orders po ON po.id=e.po_id LEFT JOIN products p ON p.id=e.product_id WHERE 1=1`;
    if(req.query.po_id){sql+=' AND e.po_id=?';args.push(req.query.po_id);}
    if(req.query.type){sql+=' AND e.exception_type=?';args.push(req.query.type);}
    sql+=' ORDER BY e.created_at DESC,e.id DESC LIMIT 500';const {rows}=await db.execute({sql,args});res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/quality-holds',requirePermission('purchasing'),async(req,res)=>{
  try{const args=[];let sql=`SELECT h.*,p.name product_name,p.sku,b.name branch_name,pri.receipt_id FROM purchase_receipt_quality_holds h JOIN products p ON p.id=h.product_id JOIN branches b ON b.id=h.branch_id JOIN purchase_receipt_items pri ON pri.id=h.receipt_item_id WHERE 1=1`;if(req.query.status){sql+=' AND h.status=?';args.push(req.query.status);}sql+=' ORDER BY h.created_at DESC,h.id DESC LIMIT 500';const {rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

router.post('/quality-holds/:id/release',requirePermission('purchasing_approve'),async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;
  try{
    const {rows:[hold]}=await tx.execute({sql:'SELECT * FROM purchase_receipt_quality_holds WHERE id=?',args:[req.params.id]});
    if(!hold){await tx.rollback();return res.status(404).json({error:'Quality hold not found'});}if(hold.status!=='inspection'){await tx.rollback();return res.status(409).json({error:`Quality hold is already ${hold.status}`});}
    const disposition=String(req.body?.disposition||'available').toLowerCase();
    if(!['available','quarantine','damaged','blocked'].includes(disposition)){await tx.rollback();return res.status(400).json({error:'disposition must be available, quarantine, damaged, or blocked'});}
    const reason=String(req.body?.reason||'').trim();if(!reason){await tx.rollback();return res.status(400).json({error:'Inspection disposition reason is required'});}
    await moveStockStatus(tx,{productId:hold.product_id,branchId:hold.branch_id,fromStatus:'inspection',toStatus:disposition,quantity:Number(hold.quantity),reason,employeeId:req.employee?.id||null,reference:`purchase_quality_hold:${hold.id}`});
    await tx.execute({sql:`UPDATE purchase_receipt_quality_holds SET status=?,released_by_employee_id=?,released_at=CURRENT_TIMESTAMP WHERE id=? AND status='inspection'`,args:[disposition,req.employee?.id||null,hold.id]});
    await tx.commit();committed=true;res.json({id:hold.id,status:disposition,released:true});
  }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
});
module.exports=router;
