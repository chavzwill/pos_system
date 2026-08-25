const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');

let ready=false;
async function ensureSchema(){
  if(ready)return;
  await db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS supplier_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      label TEXT NOT NULL,
      contact_name TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      country TEXT,
      phone TEXT,
      email TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_locations_supplier ON supplier_locations(supplier_id,active)'}
  ],'write');
  const cols=(await db.execute({sql:'PRAGMA table_info(purchase_orders)',args:[]})).rows.map(x=>String(x.name));
  const add=async(name,type)=>{if(!cols.includes(name))await db.execute({sql:`ALTER TABLE purchase_orders ADD COLUMN ${name} ${type}`,args:[]});};
  await add('supplier_location_id','INTEGER');
  await add('supplier_address_snapshot','TEXT');
  await add('supplier_contact_snapshot','TEXT');
  await add('ship_to_branch_id','INTEGER');
  await add('ship_to_name','TEXT');
  await add('ship_to_address','TEXT');
  await add('ship_to_city','TEXT');
  await add('ship_to_state','TEXT');
  await add('ship_to_zip','TEXT');
  await add('ship_to_country','TEXT');
  await add('ship_to_phone','TEXT');
  await add('ship_to_email','TEXT');
  ready=true;
}
function joinedAddress(x={}){return [x.address,x.city,x.state,x.zip,x.country].map(v=>String(v||'').trim()).filter(Boolean).join(', ');}
async function defaultSupplierLocation(supplier){
  const {rows:[existing]}=await db.execute({sql:'SELECT * FROM supplier_locations WHERE supplier_id=? AND active=1 ORDER BY is_default DESC,id LIMIT 1',args:[supplier.id]});
  if(existing)return existing;
  if(!supplier.address&&!supplier.city&&!supplier.state&&!supplier.zip)return null;
  const r=await db.execute({sql:`INSERT INTO supplier_locations(supplier_id,label,contact_name,address,city,state,zip,country,phone,email,is_default) VALUES(?,?,?,?,?,?,?,?,?,?,1)`,args:[supplier.id,'Primary',supplier.contact_name||null,supplier.address||null,supplier.city||null,supplier.state||null,supplier.zip||null,null,supplier.phone||null,supplier.email||null]});
  return (await db.execute({sql:'SELECT * FROM supplier_locations WHERE id=?',args:[Number(r.lastInsertRowid)]})).rows[0];
}
router.use(requirePermission('purchasing'));
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Purchase-order document context initialization failed',detail:e.message});}});

router.get('/document-context',async(req,res)=>{
  try{
    const {rows:branches}=await db.execute({sql:'SELECT id,branch_code,name,address,city,state,zip,phone,email FROM branches WHERE active=1 ORDER BY name',args:[]});
    res.json({branches,default_branch_id:req.employee?.default_branch_id||null});
  }catch(e){res.status(500).json({error:e.message});}
});
router.get('/supplier-locations/:supplierId',async(req,res)=>{
  try{
    const {rows:[supplier]}=await db.execute({sql:'SELECT * FROM suppliers WHERE id=? AND active=1',args:[req.params.supplierId]});
    if(!supplier)return res.status(404).json({error:'Supplier not found'});
    await defaultSupplierLocation(supplier);
    const {rows}=await db.execute({sql:'SELECT * FROM supplier_locations WHERE supplier_id=? AND active=1 ORDER BY is_default DESC,label,id',args:[supplier.id]});
    res.json(rows);
  }catch(e){res.status(500).json({error:e.message});}
});
router.post('/quick-suppliers',requirePermission('purchasing_create'),async(req,res)=>{
  try{
    const b=req.body||{};if(!String(b.name||'').trim())return res.status(400).json({error:'Supplier name is required'});
    const supplier_number=await nextNumber(db,'suppliers','supplier_number','SUP-',4);
    const tx=await db.transaction('write');let committed=false;
    try{
      const r=await tx.execute({sql:'INSERT INTO suppliers (supplier_number,name,contact_name,email,phone,address,city,state,zip,payment_terms,notes,is_local) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',args:[supplier_number,String(b.name).trim(),b.contact_name||null,b.email||null,b.phone||null,b.address||null,b.city||null,b.state||null,b.zip||null,b.payment_terms||'Net 30',b.notes||null,b.is_local?1:0]});
      const supplierId=Number(r.lastInsertRowid);
      let locationId=null;
      if(b.address||b.city||b.state||b.zip){const lr=await tx.execute({sql:`INSERT INTO supplier_locations(supplier_id,label,contact_name,address,city,state,zip,country,phone,email,is_default) VALUES(?,?,?,?,?,?,?,?,?,?,1)`,args:[supplierId,b.location_label||'Primary',b.contact_name||null,b.address||null,b.city||null,b.state||null,b.zip||null,b.country||null,b.phone||null,b.email||null]});locationId=Number(lr.lastInsertRowid);}
      await tx.commit();committed=true;
      const {rows:[supplier]}=await db.execute({sql:'SELECT * FROM suppliers WHERE id=?',args:[supplierId]});
      res.status(201).json({...supplier,location_id:locationId});
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }catch(e){res.status(400).json({error:e.message});}
});
router.post('/supplier-locations/:supplierId',requirePermission('purchasing_create'),async(req,res)=>{
  try{
    const b=req.body||{};const sid=Number(req.params.supplierId);if(!sid)return res.status(400).json({error:'Supplier is required'});
    if(!String(b.label||'').trim())return res.status(400).json({error:'Location label is required'});
    if(b.is_default)await db.execute({sql:'UPDATE supplier_locations SET is_default=0 WHERE supplier_id=?',args:[sid]});
    const r=await db.execute({sql:`INSERT INTO supplier_locations(supplier_id,label,contact_name,address,city,state,zip,country,phone,email,is_default) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[sid,String(b.label).trim(),b.contact_name||null,b.address||null,b.city||null,b.state||null,b.zip||null,b.country||null,b.phone||null,b.email||null,b.is_default?1:0]});
    const {rows:[row]}=await db.execute({sql:'SELECT * FROM supplier_locations WHERE id=?',args:[Number(r.lastInsertRowid)]});res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/',requirePermission('purchasing_create'),async(req,res,next)=>{
  const b=req.body||{};
  if(!b.ship_to_address)return res.status(400).json({error:'A ship-to address is required for a purchase order'});
  if(!b.branch_id&&!b.ship_to_branch_id)return res.status(400).json({error:'A receiving inventory branch is required so received stock has an inventory destination'});
  try{
    const {rows:[supplier]}=await db.execute({sql:'SELECT * FROM suppliers WHERE id=?',args:[b.supplier_id]});
    if(!supplier)return res.status(400).json({error:'Supplier not found'});
    let loc=null;
    if(b.supplier_location_id){loc=(await db.execute({sql:'SELECT * FROM supplier_locations WHERE id=? AND supplier_id=? AND active=1',args:[b.supplier_location_id,b.supplier_id]})).rows[0];if(!loc)return res.status(400).json({error:'Selected supplier location is invalid'});}
    if(!loc)loc=await defaultSupplierLocation(supplier);
    const supplierSnapshot={address:b.supplier_address||loc?.address||supplier.address||'',city:b.supplier_city||loc?.city||supplier.city||'',state:b.supplier_state||loc?.state||supplier.state||'',zip:b.supplier_zip||loc?.zip||supplier.zip||'',country:b.supplier_country||loc?.country||'',contact_name:b.supplier_contact||loc?.contact_name||supplier.contact_name||''};
    const originalJson=res.json.bind(res);
    res.json=function(payload){
      if(res.statusCode===201&&payload&&payload.id){
        Promise.resolve().then(async()=>{
          await db.execute({sql:`UPDATE purchase_orders SET supplier_location_id=?,supplier_address_snapshot=?,supplier_contact_snapshot=?,ship_to_branch_id=?,ship_to_name=?,ship_to_address=?,ship_to_city=?,ship_to_state=?,ship_to_zip=?,ship_to_country=?,ship_to_phone=?,ship_to_email=? WHERE id=?`,args:[loc?.id||null,joinedAddress(supplierSnapshot),supplierSnapshot.contact_name||null,b.ship_to_branch_id||b.branch_id||null,b.ship_to_name||null,b.ship_to_address||null,b.ship_to_city||null,b.ship_to_state||null,b.ship_to_zip||null,b.ship_to_country||null,b.ship_to_phone||null,b.ship_to_email||null,payload.id]});
          Object.assign(payload,{supplier_location_id:loc?.id||null,supplier_address_snapshot:joinedAddress(supplierSnapshot),supplier_contact_snapshot:supplierSnapshot.contact_name||null,ship_to_branch_id:b.ship_to_branch_id||b.branch_id||null,ship_to_name:b.ship_to_name||null,ship_to_address:b.ship_to_address||null,ship_to_city:b.ship_to_city||null,ship_to_state:b.ship_to_state||null,ship_to_zip:b.ship_to_zip||null,ship_to_country:b.ship_to_country||null,ship_to_phone:b.ship_to_phone||null,ship_to_email:b.ship_to_email||null});
          originalJson(payload);
        }).catch(e=>{console.error('PO address snapshot failed',e);if(!res.headersSent)res.status(500);originalJson({error:'Purchase order was created but its document address snapshot could not be preserved'});});
        return res;
      }
      return originalJson(payload);
    };
    next();
  }catch(e){res.status(400).json({error:e.message});}
});
module.exports=router;
