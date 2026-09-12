'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');

async function productStock(id){
  const {rows:[row]}=await db.execute({sql:'SELECT stock_qty FROM products WHERE id=?',args:[id]});
  return row;
}
async function variationStock(productId,variationId){
  const {rows:[row]}=await db.execute({sql:'SELECT stock_qty FROM product_variations WHERE id=? AND product_id=?',args:[variationId,productId]});
  return row;
}
function changed(requested,current){
  if(requested===undefined||requested===null||requested==='')return false;
  const n=Number(requested);
  return !Number.isFinite(n)||Math.abs(n-Number(current||0))>1e-9;
}
router.post('/',async(req,res,next)=>{
  const qty=Number(req.body?.stock_qty||0);
  if(!Number.isFinite(qty)||qty<0)return res.status(400).json({error:'Opening stock must be a non-negative number'});
  if(qty>0)return res.status(409).json({error:'Create the catalog item with zero opening stock, then use the controlled stock-adjustment workflow so physical stock has attributable movement evidence.'});
  next();
});

router.put('/:id',async(req,res,next)=>{
  try{
    const row=await productStock(req.params.id);
    if(!row)return next();
    if(changed(req.body?.stock_qty,row.stock_qty))return res.status(409).json({error:'Physical stock cannot be changed through product editing. Use the controlled stock-adjustment workflow.'});
    next();
  }catch(e){res.status(500).json({error:'Unable to verify physical stock authority'});}
});
router.post('/:id/variations',async(req,res,next)=>{
  const qty=Number(req.body?.stock_qty||0);
  if(!Number.isFinite(qty)||qty<0)return res.status(400).json({error:'Opening variation stock must be a non-negative number'});
  if(qty>0)return res.status(409).json({error:'Create the variation with zero opening stock, then use the controlled variation stock-adjustment workflow.'});
  next();
});
router.put('/:id/variations/:vid',async(req,res,next)=>{
  try{
    const row=await variationStock(req.params.id,req.params.vid);
    if(!row)return next();
    if(changed(req.body?.stock_qty,row.stock_qty))return res.status(409).json({error:'Variation stock changes must use the controlled adjustment workflow.'});
    next();
  }catch(e){res.status(500).json({error:'Unable to verify variation stock authority'});}
});
router.patch('/:id/variations/:vid/stock',requirePermission('inventory_adjust'),async(req,res)=>{
  const adj=Number(req.body?.adjustment);
  const reason=String(req.body?.reason||'').trim();
  if(!Number.isFinite(adj)||Math.abs(adj)<1e-12)return res.status(400).json({error:'A non-zero numeric stock adjustment is required'});
  if(reason.length<5)return res.status(400).json({error:'A meaningful adjustment reason is required'});
  const tx=await db.transaction('write');
  let committed=false;
  try{
    await tx.execute({sql:`CREATE TABLE IF NOT EXISTS variation_stock_movements(id INTEGER PRIMARY KEY AUTOINCREMENT,product_id INTEGER NOT NULL REFERENCES products(id),variation_id INTEGER NOT NULL REFERENCES product_variations(id),employee_id INTEGER REFERENCES employees(id),quantity_change REAL NOT NULL,quantity_before REAL NOT NULL,quantity_after REAL NOT NULL,type TEXT NOT NULL,reason TEXT NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,args:[]});
    const {rows:[v]}=await tx.execute({sql:'SELECT stock_qty FROM product_variations WHERE id=? AND product_id=?',args:[req.params.vid,req.params.id]});
    if(!v)throw Object.assign(new Error('Variation not found'),{status:404});
    const before=Number(v.stock_qty||0);
    const after=before+adj;
    if(after<-1e-9)throw Object.assign(new Error(`Adjustment would make variation stock negative (${before} on hand)`),{status:409});
    await tx.execute({sql:'UPDATE product_variations SET stock_qty=? WHERE id=?',args:[after,req.params.vid]});
    const m=await tx.execute({sql:'INSERT INTO variation_stock_movements(product_id,variation_id,employee_id,quantity_change,quantity_before,quantity_after,type,reason) VALUES(?,?,?,?,?,?,?,?)',args:[req.params.id,req.params.vid,req.employee?.id||null,adj,before,after,'adjustment',reason]});
    await tx.commit(); committed=true;
    res.json({stock_qty:after,movement_id:Number(m.lastInsertRowid)});
  }catch(e){
    if(!committed)await tx.rollback();
    res.status(e.status||400).json({error:e.message});
  }
});

module.exports=router;
