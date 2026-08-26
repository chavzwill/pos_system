'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {TYPES,ALLOCATION_MODES,ensureProductComposition,getComposition,calculateAvailability,transformBreakPack,transformAssemble}=require('../lib/product-composition');

router.use(async(req,res,next)=>{try{await ensureProductComposition();next();}catch(e){res.status(500).json({error:'Product composition initialization failed',detail:e.message});}});

router.get('/',requirePermission('inventory'),async(req,res)=>{
  try{const args=[];let sql=`SELECT pc.*,p.name parent_product_name,p.sku parent_sku FROM product_compositions pc JOIN products p ON p.id=pc.parent_product_id WHERE 1=1`;if(req.query.parent_product_id){sql+=' AND pc.parent_product_id=?';args.push(Number(req.query.parent_product_id));}if(req.query.type){sql+=' AND pc.composition_type=?';args.push(String(req.query.type));}if(req.query.active!==undefined){sql+=' AND pc.active=?';args.push(String(req.query.active)==='0'?0:1);}sql+=' ORDER BY pc.updated_at DESC,pc.id DESC';const {rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}
});

router.get('/:id',requirePermission('inventory'),async(req,res)=>{try{const row=await getComposition(db,Number(req.params.id));if(!row)return res.status(404).json({error:'Composition not found'});res.json(row);}catch(e){res.status(500).json({error:e.message});}});

router.get('/:id/availability',requirePermission('inventory'),async(req,res)=>{
  try{const branchId=Number(req.query.branch_id);if(!branchId)return res.status(400).json({error:'branch_id is required'});const composition=await getComposition(db,Number(req.params.id));if(!composition)return res.status(404).json({error:'Composition not found'});res.json(await calculateAvailability(db,composition,branchId));}catch(e){res.status(500).json({error:e.message});}
});

router.post('/',requirePermission('inventory_edit'),async(req,res)=>{
  try{
    const parentProductId=Number(req.body?.parent_product_id),type=String(req.body?.composition_type||''),name=String(req.body?.name||'').trim(),mode=String(req.body?.cost_allocation_mode||'relative_cost'),components=Array.isArray(req.body?.components)?req.body.components:[];
    if(!parentProductId||!TYPES.has(type)||!name||!ALLOCATION_MODES.has(mode))return res.status(400).json({error:'parent_product_id, valid composition_type, name and cost_allocation_mode are required'});
    if(!components.length)return res.status(400).json({error:'At least one component is required'});
    const {rows:[parent]}=await db.execute({sql:'SELECT id,is_service,is_non_inventory FROM products WHERE id=?',args:[parentProductId]});if(!parent)return res.status(404).json({error:'Parent product not found'});if(parent.is_service||parent.is_non_inventory)return res.status(409).json({error:'Kit parent must be a physical inventory product'});
    const tx=await db.transaction('write');let committed=false;
    try{
      const cr=await tx.execute({sql:`INSERT INTO product_compositions(parent_product_id,composition_type,name,cost_allocation_mode,created_by_employee_id,updated_by_employee_id) VALUES(?,?,?,?,?,?)`,args:[parentProductId,type,name,mode,req.employee?.id||null,req.employee?.id||null]});const id=Number(cr.lastInsertRowid);let order=0;
      for(const c of components){const productId=Number(c.component_product_id),qty=Number(c.quantity_per_parent);if(!productId||productId===parentProductId||!Number.isFinite(qty)||qty<=0)throw new Error('Every component requires a different valid product and quantity_per_parent greater than zero');const {rows:[p]}=await tx.execute({sql:'SELECT id,is_service,is_non_inventory FROM products WHERE id=?',args:[productId]});if(!p||p.is_service||p.is_non_inventory)throw new Error(`Component product ${productId} is not valid physical inventory`);await tx.execute({sql:`INSERT INTO product_composition_components(composition_id,component_product_id,quantity_per_parent,allocation_weight,explicit_cost_per_parent,sort_order) VALUES(?,?,?,?,?,?)`,args:[id,productId,qty,c.allocation_weight==null?null:Number(c.allocation_weight),c.explicit_cost_per_parent==null?null:Number(c.explicit_cost_per_parent),order++]});}
      await tx.commit();committed=true;res.status(201).json(await getComposition(db,id));
    }catch(e){if(!committed)await tx.rollback();res.status(400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/:id/break-pack',requirePermission('inventory_adjust'),async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;try{const composition=await getComposition(tx,Number(req.params.id));if(!composition)throw Object.assign(new Error('Composition not found'),{status:404});const result=await transformBreakPack(tx,{composition,branchId:Number(req.body?.branch_id),parentQuantity:Number(req.body?.quantity||1),employeeId:req.employee?.id||null,reason:req.body?.reason});await tx.commit();committed=true;res.status(201).json(result);}catch(e){if(!committed)await tx.rollback();res.status(e.status||409).json({error:e.message});}
});

router.post('/:id/assemble',requirePermission('inventory_adjust'),async(req,res)=>{
  const tx=await db.transaction('write');let committed=false;try{const composition=await getComposition(tx,Number(req.params.id));if(!composition)throw Object.assign(new Error('Composition not found'),{status:404});const result=await transformAssemble(tx,{composition,branchId:Number(req.body?.branch_id),parentQuantity:Number(req.body?.quantity||1),employeeId:req.employee?.id||null,reason:req.body?.reason,serialAssignments:req.body?.serial_assignments||[]});await tx.commit();committed=true;res.status(201).json(result);}catch(e){if(!committed)await tx.rollback();res.status(e.status||409).json({error:e.message});}
});

router.get('/instances/list/all',requirePermission('inventory'),async(req,res)=>{try{const args=[];let sql=`SELECT k.*,p.name parent_product_name,p.sku parent_sku,b.name branch_name FROM product_kit_instances k JOIN products p ON p.id=k.parent_product_id JOIN branches b ON b.id=k.branch_id WHERE 1=1`;if(req.query.branch_id){sql+=' AND k.branch_id=?';args.push(Number(req.query.branch_id));}if(req.query.status){sql+=' AND k.status=?';args.push(String(req.query.status));}sql+=' ORDER BY k.created_at DESC,k.id DESC LIMIT 500';const {rows}=await db.execute({sql,args});res.json(rows);}catch(e){res.status(500).json({error:e.message});}});

module.exports=router;
