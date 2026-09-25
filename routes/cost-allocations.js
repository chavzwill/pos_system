'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {ensureInventoryMovementValuation,valueStockAdjustment}=require('../lib/inventory-movement-valuation');
const {ensureCostAllocationSchema,normalizeAllocations,insertAllocations}=require('../lib/cost-allocations');
const {enqueueSpendEvent}=require('../lib/spendos-outbox');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureCostAllocationSchema();
    await ensureInventoryMovementValuation();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS internal_consumptions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        consumption_number TEXT NOT NULL UNIQUE,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        employee_id INTEGER REFERENCES employees(id),
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'posted',
        total_tracked_value REAL NOT NULL DEFAULT 0,
        valuation_status TEXT NOT NULL DEFAULT 'fully_valued',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS internal_consumption_items(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        consumption_id INTEGER NOT NULL REFERENCES internal_consumptions(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity REAL NOT NULL,
        tracked_value REAL NOT NULL DEFAULT 0,
        valuation_status TEXT NOT NULL,
        stock_movement_id INTEGER REFERENCES stock_movements(id)
      )`}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(requirePermission('purchasing'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:e.message});}});

router.get('/targets',async(req,res)=>{
  try{
    const type=String(req.query.type||'');
    let rows=[];
    if(type==='rental_asset'){
      ({rows}=await db.execute({sql:`SELECT ra.id,ra.asset_number code,p.name||' · '||ra.asset_number name,ra.branch_id
        FROM rental_assets ra JOIN products p ON p.id=ra.product_id
        WHERE ra.status NOT IN ('disposed','sold','lost') ORDER BY ra.asset_number`,args:[]}));
    }else if(type==='vehicle'){
      ({rows}=await db.execute({sql:`SELECT id,vehicle_number code,description name,NULL branch_id
        FROM dispatch_vehicles WHERE active=1 ORDER BY vehicle_number`,args:[]}));
    }else if(type==='branch'){
      ({rows}=await db.execute({sql:'SELECT id,branch_code code,name,id branch_id FROM branches WHERE active=1 ORDER BY name',args:[]}));
    }else if(type==='work_order'){
      ({rows}=await db.execute({sql:`SELECT id,wo_number code,'Work Order '||wo_number name,branch_id
        FROM work_orders WHERE status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 200`,args:[]}));
    }else{
      ({rows}=await db.execute({sql:'SELECT id,code,name,branch_id,department FROM cost_objects WHERE object_type=? AND active=1 ORDER BY name',args:[type]}));
    }
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/objects',async(req,res)=>{
  try{
    const {object_type,code,name,branch_id,department,metadata}=req.body||{};
    if(!['equipment','building','department','project','general_overhead'].includes(object_type))return res.status(400).json({error:'Unsupported custom cost object type'});
    if(!name)return res.status(400).json({error:'Name is required'});
    const r=await db.execute({sql:`INSERT INTO cost_objects(object_type,code,name,branch_id,department,metadata_json)
      VALUES(?,?,?,?,?,?) RETURNING *`,args:[object_type,code||null,name,branch_id||null,department||null,JSON.stringify(metadata||{})]});
    res.status(201).json(r.rows[0]);
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/consumptions',async(req,res)=>{
  try{
    const {branch_id,limit=100}=req.query;
    let sql=`SELECT ic.*,b.name branch_name,e.first_name||' '||e.last_name employee_name
      FROM internal_consumptions ic
      JOIN branches b ON b.id=ic.branch_id
      LEFT JOIN employees e ON e.id=ic.employee_id WHERE 1=1`;
    const args=[];
    if(branch_id){sql+=' AND ic.branch_id=?';args.push(branch_id);}
    sql+=' ORDER BY ic.created_at DESC LIMIT ?';args.push(Math.min(500,Number(limit)||100));
    const {rows}=await db.execute({sql,args});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});

router.post('/consumptions',async(req,res)=>{
  const {branch_id,notes,items}=req.body||{};
  const employee_id=req.employee?.id||req.body?.employee_id||null;
  if(!branch_id)return res.status(400).json({error:'Branch is required'});
  if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'At least one consumption item is required'});
  const tx=await db.transaction('write');let committed=false;
  try{
    const number=await nextNumber(tx,'internal_consumptions','consumption_number','CON-',6);
    const {rows:[branch]}=await tx.execute({sql:'SELECT currency FROM branches WHERE id=?',args:[branch_id]});
    const branchCurrency=branch?.currency||null;
    const head=await tx.execute({sql:`INSERT INTO internal_consumptions(consumption_number,branch_id,employee_id,notes)
      VALUES(?,?,?,?)`,args:[number,branch_id,employee_id||null,notes||null]});
    const consumptionId=Number(head.lastInsertRowid);
    let totalTracked=0;let overall='fully_valued';
    const eventItems=[];
    for(const raw of items){
      const productId=Number(raw.product_id),qty=Number(raw.quantity);
      if(!productId||!Number.isFinite(qty)||qty<=0)throw new Error('Each consumption item requires a valid product and quantity');
      const {rows:[product]}=await tx.execute({sql:'SELECT id,name,sku FROM products WHERE id=?',args:[productId]});
      if(!product)throw new Error('Product not found');
      const {rows:[inv]}=await tx.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branch_id]});
      const physicalBefore=Number(inv?.stock_qty||0);
      if(physicalBefore<qty)throw new Error(`Insufficient branch stock for ${product.name}`);
      const {rows:[bin]}=await tx.execute({sql:'SELECT id FROM product_bin_assignments WHERE product_id=? AND branch_id=? LIMIT 1',args:[productId,branch_id]});
      if(bin&&!raw.bin_id)throw new Error(`${product.name} is bin-controlled; select the exact bin`);
      if(raw.bin_id){
        const br=await tx.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND bin_id=? AND quantity>=?',args:[qty,productId,branch_id,raw.bin_id,qty]});
        if(Number(br.rowsAffected||0)!==1)throw new Error(`Bin stock changed for ${product.name}`);
      }
      const upd=await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND stock_qty>=?',args:[qty,productId,branch_id,qty]});
      if(Number(upd.rowsAffected||0)!==1)throw new Error(`Stock changed for ${product.name}`);
      await tx.execute({sql:'UPDATE products SET stock_qty=(SELECT COALESCE(SUM(stock_qty),0) FROM branch_inventory WHERE product_id=?) WHERE id=?',args:[productId,productId]});
      const mov=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason)
        VALUES(?,?,?,?,?,?)`,args:[productId,branch_id,-qty,'internal_consumption',number,raw.purpose||'Internal consumption']});
      const movementId=Number(mov.lastInsertRowid);
      await valueStockAdjustment(tx,{stockMovementId:movementId,productId,branchKey:branch_id,quantityChange:-qty,reason:raw.purpose||'Internal consumption',physicalBefore});
      const {rows:[val]}=await tx.execute({sql:'SELECT * FROM inventory_adjustment_valuations WHERE stock_movement_id=?',args:[movementId]});
      const trackedValue=Number(val?.tracked_value||0);
      const incomplete=Number(val?.legacy_quantity||0)+Number(val?.untracked_quantity||0)>0;
      const valuationStatus=incomplete?(trackedValue>0?'partial':'unvalued'):'fully_valued';
      if(valuationStatus!=='fully_valued')overall=overall==='unvalued'||valuationStatus==='unvalued'?'unvalued':'partial';
      totalTracked+=trackedValue;
      const line=await tx.execute({sql:`INSERT INTO internal_consumption_items(consumption_id,product_id,quantity,tracked_value,valuation_status,stock_movement_id)
        VALUES(?,?,?,?,?,?)`,args:[consumptionId,productId,qty,trackedValue,valuationStatus,movementId]});
      const lineId=Number(line.lastInsertRowid);
      const allocations=Array.isArray(raw.allocations)?raw.allocations:[];
      if(!allocations.length)throw new Error(`Allocate ${product.name} to a machine, vehicle, branch, department, building, project, work order, or overhead`);
      const pctTotal=allocations.reduce((s,a)=>s+Number(a.allocation_percent||0),0);
      if(Math.abs(pctTotal-100)>0.01)throw new Error(`Allocations for ${product.name} must total 100%`);
      const normalized=allocations.map(a=>({
        ...a,
        allocation_amount:Number((trackedValue*Number(a.allocation_percent||0)/100).toFixed(2)),
        allocation_quantity:Number((qty*Number(a.allocation_percent||0)/100).toFixed(4)),
        valuation_status:valuationStatus
      }));
      await insertAllocations(tx,{sourceType:'internal_consumption',sourceId:consumptionId,sourceLineId:lineId,allocations:normalized,createdBy:employee_id});
      eventItems.push({
        productId:String(productId),sku:product.sku||null,productName:product.name,quantity:qty,trackedValue,
        valuationStatus,allocations:normalized.map(a=>({
          targetType:a.target_type,targetId:a.target_id,targetLabel:a.target_label,
          amount:a.allocation_amount,quantity:a.allocation_quantity,percent:a.allocation_percent,
          purpose:a.purpose,expenseCategory:a.expense_category,valuationStatus:a.valuation_status
        }))
      });
    }
    await tx.execute({sql:'UPDATE internal_consumptions SET total_tracked_value=?,valuation_status=? WHERE id=?',args:[Number(totalTracked.toFixed(2)),overall,consumptionId]});
    await enqueueSpendEvent(tx,{
      id:`total-tools:internal-consumption:${consumptionId}:1`,type:'consumable.issued',
      occurredAt:new Date().toISOString(),tenantId:process.env.SPENDOS_TENANT_ID||'total-tools',
      source:'total-tools-pos',sourceRecordId:String(consumptionId),sourceVersion:1,
      actorId:employee_id?String(employee_id):null,locationId:String(branch_id),departmentId:null,
      payload:{consumptionNumber:number,currency:branchCurrency,totalTrackedValue:Number(totalTracked.toFixed(2)),valuationStatus:overall,items:eventItems}
    });
    await tx.commit();committed=true;
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM internal_consumptions WHERE id=?',args:[consumptionId]});
    res.status(201).json(row);
  }catch(e){
    if(!committed)try{await tx.rollback();}catch{}
    res.status(400).json({error:e.message});
  }
});

module.exports=router;
