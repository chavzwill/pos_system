'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
router.get('/offer-alerts',requirePermission('purchase_requests'),async(req,res)=>{
  try{
    const days=Math.max(0,Number(req.query.expiry_days||14));
    const {rows}=await db.execute({sql:`SELECT o.*,s.name supplier_name,p.name product_name,p.sku product_sku,
      CASE
        WHEN o.active=0 OR s.active=0 THEN 'inactive'
        WHEN o.valid_until IS NOT NULL AND date(o.valid_until)<date('now') THEN 'expired'
        WHEN o.availability_qty IS NOT NULL AND o.availability_qty<=0 THEN 'unavailable'
        WHEN o.valid_until IS NOT NULL AND date(o.valid_until)<=date('now', ?) THEN 'expiring_soon'
        ELSE 'active'
      END alert_type
      FROM supplier_product_offers o JOIN suppliers s ON s.id=o.supplier_id JOIN products p ON p.id=o.product_id
      WHERE o.active=0 OR s.active=0 OR (o.valid_until IS NOT NULL AND date(o.valid_until)<=date('now', ?)) OR (o.availability_qty IS NOT NULL AND o.availability_qty<=0)
      ORDER BY CASE
        WHEN o.active=0 OR s.active=0 THEN 1
        WHEN o.valid_until IS NOT NULL AND date(o.valid_until)<date('now') THEN 2
        WHEN o.availability_qty IS NOT NULL AND o.availability_qty<=0 THEN 3
        ELSE 4 END,
        o.valid_until,o.updated_at`,args:[`+${days} days`,`+${days} days`]});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
