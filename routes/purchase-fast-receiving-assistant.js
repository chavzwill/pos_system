'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const {getReceivingControl}=require('../lib/purchase-receiving-controls');
const {getTrackingProfile}=require('../lib/inventory-traceability');
router.use(requirePermission('purchasing_receive'));
const branchId=req=>req.employee?.default_branch_id||null;
const text=v=>String(v||'').trim();
function assertBranch(req,po){const branch=branchId(req);if(branch&&Number(po.branch_id)!==Number(branch)){const e=new Error('This purchase order belongs to another branch');e.status=403;throw e;}}
router.get('/search',async(req,res)=>{
 try{
  const q=text(req.query.q);if(q.length<2)return res.json({query:q,rows:[]});
  const branch=branchId(req),like=`%${q}%`;
  const {rows}=await db.execute({sql:`SELECT DISTINCT po.id,po.po_number,po.status,po.expected_date,po.branch_id,s.name supplier_name,b.name branch_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id=po.supplier_id
    LEFT JOIN branches b ON b.id=po.branch_id
    LEFT JOIN purchase_order_items poi ON poi.po_id=po.id
    LEFT JOIN products p ON p.id=poi.product_id
    WHERE po.status IN ('approved','partial')
      AND (? IS NULL OR po.branch_id=?)
      AND (po.po_number LIKE ? OR s.name LIKE ? OR poi.sku LIKE ? OR poi.product_name LIKE ? OR p.barcode LIKE ?)
    ORDER BY po.expected_date IS NULL,po.expected_date,po.id DESC LIMIT 20`,args:[branch,branch,like,like,like,like,like]});
  res.json({query:q,rows});
 }catch(e){res.status(500).json({error:e.message});}
});
router.get('/:id',async(req,res)=>{
 try{
  const id=Number(req.params.id);if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Valid purchase order id required'});
  const {rows:[po]}=await db.execute({sql:`SELECT po.*,s.name supplier_name,b.name branch_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN branches b ON b.id=po.branch_id WHERE po.id=?`,args:[id]});
  if(!po)return res.status(404).json({error:'Purchase order not found'});assertBranch(req,po);
  if(!['approved','partial'].includes(String(po.status)))return res.status(409).json({error:`Purchase order is ${po.status}; only approved or partially received orders can be received`});
  const {rows:items}=await db.execute({sql:`SELECT poi.*,p.barcode FROM purchase_order_items poi LEFT JOIN products p ON p.id=poi.product_id WHERE poi.po_id=? ORDER BY poi.id`,args:[id]});
  for(const item of items){
    const ordered=Number(item.quantity_ordered||0),received=Number(item.quantity_received||0);item.remaining=Math.max(0,ordered-received);
    item.receiving_control=await getReceivingControl(db,item.product_id);
    item.tracking_profile=item.product_id?await getTrackingProfile(db,item.product_id):{tracking_mode:'none',expiry_required:0,manufacture_date_required:0};
    item.put_away=null;
    if(item.product_id&&po.branch_id){
      const {rows:[bin]}=await db.execute({sql:`SELECT pba.id assignment_id,pba.quantity located_quantity,pba.is_primary,sb.id bin_id,sb.bin_code,wz.name zone_name
        FROM product_bin_assignments pba JOIN storage_bins sb ON sb.id=pba.bin_id LEFT JOIN warehouse_zones wz ON wz.id=sb.zone_id
        WHERE pba.product_id=? AND pba.branch_id=? ORDER BY pba.is_primary DESC,pba.id ASC LIMIT 1`,args:[item.product_id,po.branch_id]});
      if(bin)item.put_away=bin;
    }
  }
  res.json({po:{id:po.id,po_number:po.po_number,status:po.status,supplier_name:po.supplier_name,branch_id:po.branch_id,branch_name:po.branch_name,expected_date:po.expected_date},can_close_short:!!req.apiKey||can(req.employee?.permissions||{},'purchasing_approve'),items});
 }catch(e){res.status(e.status||500).json({error:e.message});}
});
module.exports=router;
