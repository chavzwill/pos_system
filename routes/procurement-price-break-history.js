'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
let readyPromise=null;
async function ensurePriceBreakHistory(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS supplier_price_break_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        offer_id INTEGER NOT NULL,
        min_purchase_qty REAL NOT NULL,
        unit_cost_per_purchase_uom REAL NOT NULL,
        change_type TEXT NOT NULL,
        captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_price_break_history_offer ON supplier_price_break_history(offer_id,captured_at,id)'},
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_supplier_price_break_insert_history AFTER INSERT ON supplier_price_breaks BEGIN
        INSERT INTO supplier_price_break_history(offer_id,min_purchase_qty,unit_cost_per_purchase_uom,change_type) VALUES(NEW.offer_id,NEW.min_purchase_qty,NEW.unit_cost_per_purchase_uom,'insert');
      END`},
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_supplier_price_break_update_history BEFORE UPDATE ON supplier_price_breaks BEGIN
        INSERT INTO supplier_price_break_history(offer_id,min_purchase_qty,unit_cost_per_purchase_uom,change_type) VALUES(OLD.offer_id,OLD.min_purchase_qty,OLD.unit_cost_per_purchase_uom,'before_update');
      END`},
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_supplier_price_break_delete_history BEFORE DELETE ON supplier_price_breaks BEGIN
        INSERT INTO supplier_price_break_history(offer_id,min_purchase_qty,unit_cost_per_purchase_uom,change_type) VALUES(OLD.offer_id,OLD.min_purchase_qty,OLD.unit_cost_per_purchase_uom,'delete');
      END`}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensurePriceBreakHistory();next();}catch(e){res.status(500).json({error:'Supplier price-break history initialization failed',detail:e.message});}});
router.get('/price-break-history',requirePermission('purchase_requests'),async(req,res)=>{
  try{const args=[];let sql=`SELECT h.*,o.supplier_id,o.product_id,o.supplier_sku,s.name supplier_name,p.name product_name,p.sku product_sku FROM supplier_price_break_history h LEFT JOIN supplier_product_offers o ON o.id=h.offer_id LEFT JOIN suppliers s ON s.id=o.supplier_id LEFT JOIN products p ON p.id=o.product_id WHERE 1=1`;if(req.query.offer_id){sql+=' AND h.offer_id=?';args.push(Number(req.query.offer_id));}if(req.query.product_id){sql+=' AND o.product_id=?';args.push(Number(req.query.product_id));}if(req.query.supplier_id){sql+=' AND o.supplier_id=?';args.push(Number(req.query.supplier_id));}sql+=' ORDER BY h.captured_at DESC,h.id DESC LIMIT 1000';const{rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
module.exports.ensurePriceBreakHistory=ensurePriceBreakHistory;
