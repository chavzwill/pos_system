'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { ensureInventoryStockStatus, getAvailableQty, moveStockStatus } = require('../lib/inventory-stock-status');
const { ensureIdentityStatus, moveIdentityStatus } = require('../lib/inventory-identity-status');
const { getTrackingProfile } = require('../lib/inventory-traceability');

router.use('/writeoffs', require('./inventory-writeoffs'));

router.get('/availability/:productId', requirePermission('inventory'), async (req,res) => {
  try {
    const branchId = Number(req.query.branch_id);
    if (!Number.isInteger(branchId) || branchId <= 0) return res.status(400).json({error:'branch_id is required'});
    await ensureInventoryStockStatus();
    await ensureIdentityStatus();
    const productId=Number(req.params.productId);
    const state = await getAvailableQty(db, productId, branchId);
    const { rows: statuses } = await db.execute({sql:'SELECT status,quantity FROM inventory_stock_status_balances WHERE product_id=? AND branch_id=? AND quantity>0 ORDER BY status',args:[productId,branchId]});
    const profile=await getTrackingProfile(db,productId);
    let identities=null;
    if(profile.tracking_mode==='serial'){
      const {rows}=await db.execute({sql:`SELECT status,COUNT(*) quantity FROM inventory_serials WHERE product_id=? AND branch_id=? GROUP BY status ORDER BY status`,args:[productId,branchId]});
      identities={tracking_mode:'serial',statuses:rows};
    }else if(profile.tracking_mode==='lot'){
      const {rows}=await db.execute({sql:`SELECT l.id,l.lot_number,l.available_quantity,l.expiry_date,COALESCE(SUM(b.quantity),0) restricted_quantity FROM inventory_lots l LEFT JOIN inventory_lot_status_balances b ON b.lot_id=l.id WHERE l.product_id=? AND l.branch_id=? GROUP BY l.id ORDER BY CASE WHEN l.expiry_date IS NULL THEN 1 ELSE 0 END,l.expiry_date,l.created_at,l.id`,args:[productId,branchId]});
      identities={tracking_mode:'lot',lots:rows};
    }
    res.json({ product_id:productId, branch_id:branchId, ...state, statuses, identities });
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/events', requirePermission('inventory'), async (req,res) => {
  try {
    await ensureInventoryStockStatus();
    const params=[];
    let sql=`SELECT e.*,p.name product_name,p.sku,b.name branch_name,
      emp.first_name || ' ' || emp.last_name employee_name
      FROM inventory_stock_status_events e
      JOIN products p ON p.id=e.product_id
      JOIN branches b ON b.id=e.branch_id
      LEFT JOIN employees emp ON emp.id=e.employee_id WHERE 1=1`;
    if (req.query.product_id) { sql+=' AND e.product_id=?'; params.push(req.query.product_id); }
    if (req.query.branch_id) { sql+=' AND e.branch_id=?'; params.push(req.query.branch_id); }
    sql+=' ORDER BY e.created_at DESC,e.id DESC LIMIT 250';
    const {rows}=await db.execute({sql,args:params});
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/move', requirePermission('inventory_disposition'), async (req,res) => {
  try {
    await ensureInventoryStockStatus();
    await ensureIdentityStatus();
    const productId=Number(req.body.product_id), branchId=Number(req.body.branch_id), quantity=Number(req.body.quantity);
    const fromStatus=String(req.body.from_status||'available').trim().toLowerCase();
    const toStatus=String(req.body.to_status||'').trim().toLowerCase();
    if (!Number.isInteger(productId) || productId<=0 || !Number.isInteger(branchId) || branchId<=0) return res.status(400).json({error:'product_id and branch_id are required'});
    const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE id=? AND active=1',args:[branchId]});
    if (!branch) return res.status(400).json({error:'Selected branch is unavailable'});
    const tx=await db.transaction('write');
    try {
      const identity=await moveIdentityStatus(tx,{productId,branchId,fromStatus,toStatus,quantity,serialNumbers:req.body.serial_numbers,lots:req.body.lots,employeeId:req.employee?.id||null,reason:req.body.reason,reference:req.body.reference||null});
      await moveStockStatus(tx,{productId,branchId,fromStatus,toStatus,quantity,reason:req.body.reason,employeeId:req.employee?.id || null,reference:req.body.reference || null});
      await tx.commit();
      const state=await getAvailableQty(db,productId,branchId);
      return res.status(201).json({success:true,...state,identity});
    } catch(e) { await tx.rollback(); return res.status(400).json({error:e.message}); }
  } catch(e) { res.status(500).json({error:e.message}); }
});

module.exports=router;
