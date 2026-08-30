'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAnyPermission}=require('../lib/permissions');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS dispatch_source_documents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_job_id INTEGER NOT NULL UNIQUE REFERENCES dispatch_jobs(id),
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      document_kind TEXT NOT NULL,
      document_number TEXT NOT NULL,
      party_type TEXT NOT NULL,
      party_id INTEGER,
      party_name TEXT NOT NULL,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      address_line TEXT NOT NULL,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      branch_id INTEGER REFERENCES branches(id),
      branch_name TEXT,
      branch_address TEXT,
      commercial_total REAL,
      snapshot_json TEXT NOT NULL,
      created_by_employee_id INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_dispatch_source_document_source ON dispatch_source_documents(source_type,source_id,created_at)'}
  ],'write').catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
function addr(x){return [x.address,x.city,x.state,x.zip].map(v=>String(v||'').trim()).filter(Boolean).join(', ');}
function branchAddr(x){return [x.branch_address,x.branch_city,x.branch_state,x.branch_zip].map(v=>String(v||'').trim()).filter(Boolean).join(', ');}
function jobNumber(){return `DSP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;}
async function existing(sourceType,sourceId,jobType){const {rows:[r]}=await db.execute({sql:`SELECT dj.*,dsd.document_kind,dsd.document_number,dsd.party_name,dsd.address_line FROM dispatch_jobs dj LEFT JOIN dispatch_source_documents dsd ON dsd.dispatch_job_id=dj.id WHERE dj.source_type=? AND dj.source_id=? AND dj.job_type=? AND dj.status NOT IN ('completed','cancelled') ORDER BY dj.id DESC LIMIT 1`,args:[sourceType,sourceId,jobType]});return r||null;}
async function createJob({sourceType,sourceId,branchId,origin,destination,jobType,priority='normal',promisedAt=null,notes,doc,employeeId}){
  const prior=await existing(sourceType,sourceId,jobType);if(prior)return prior;
  const tx=await db.transaction('write');let committed=false;
  try{
    const number=jobNumber();
    const r=await tx.execute({sql:`INSERT INTO dispatch_jobs(job_number,source_type,source_id,branch_id,origin_label,destination_label,job_type,priority,status,promised_at,notes,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,args:[number,sourceType,sourceId,branchId||null,origin,destination,jobType,priority,'unassigned',promisedAt,notes||null,employeeId||null]});
    const id=Number(r.lastInsertRowid);
    await tx.execute({sql:`INSERT INTO dispatch_source_documents(dispatch_job_id,source_type,source_id,document_kind,document_number,party_type,party_id,party_name,contact_name,contact_phone,contact_email,address_line,city,state,postal_code,branch_id,branch_name,branch_address,commercial_total,snapshot_json,created_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[id,sourceType,sourceId,doc.document_kind,doc.document_number,doc.party_type,doc.party_id||null,doc.party_name,doc.contact_name||null,doc.contact_phone||null,doc.contact_email||null,doc.address_line,doc.city||null,doc.state||null,doc.postal_code||null,branchId||null,doc.branch_name||null,doc.branch_address||null,doc.commercial_total==null?null:Number(doc.commercial_total),JSON.stringify(doc.snapshot||{}),employeeId||null]});
    await tx.execute({sql:`INSERT INTO dispatch_events(dispatch_job_id,event_type,new_status,details,actor_employee_id) VALUES(?,?,?,?,?)`,args:[id,'commercial_document_handoff','unassigned',`${doc.document_kind} ${doc.document_number} forwarded to Dispatch`,employeeId||null]});
    await tx.commit();committed=true;
    const {rows:[row]}=await db.execute({sql:`SELECT dj.*,dsd.document_kind,dsd.document_number,dsd.party_name,dsd.contact_name,dsd.contact_phone,dsd.contact_email,dsd.address_line,dsd.city,dsd.state,dsd.postal_code,dsd.branch_name,dsd.branch_address,dsd.commercial_total FROM dispatch_jobs dj JOIN dispatch_source_documents dsd ON dsd.dispatch_job_id=dj.id WHERE dj.id=?`,args:[id]});
    return row;
  }catch(e){if(!committed)await tx.rollback();throw e;}
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Commercial dispatch handoff failed to initialize',detail:e.message});}});

router.post('/from-purchase-order/:id',requireAnyPermission('purchasing','purchasing_approve','transfers'),async(req,res)=>{
  try{
    const {rows:[po]}=await db.execute({sql:`SELECT po.*,s.name supplier_name,s.contact_name supplier_contact,s.email supplier_email,s.phone supplier_phone,s.address,s.city,s.state,s.zip,b.name branch_name,b.address branch_address,b.city branch_city,b.state branch_state,b.zip branch_zip FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=po.branch_id WHERE po.id=?`,args:[req.params.id]});
    if(!po)return res.status(404).json({error:'Purchase order not found'});
    if(!['sent','approved','partial'].includes(String(po.status)))return res.status(409).json({error:'Only a sent, approved or partially received purchase order can be forwarded for supplier pickup.'});
    const supplierAddress=addr(po),destination=branchAddr(po);if(!supplierAddress)return res.status(409).json({error:'Supplier pickup cannot be dispatched until the supplier has a usable address.'});if(!destination)return res.status(409).json({error:'Receiving branch requires a usable address before supplier pickup can be dispatched.'});
    const {rows:items}=await db.execute({sql:'SELECT id,product_id,product_name,sku,quantity_ordered,quantity_received,unit_cost,total FROM purchase_order_items WHERE po_id=? ORDER BY id',args:[po.id]});
    const row=await createJob({sourceType:'purchase_order',sourceId:Number(po.id),branchId:Number(po.branch_id),origin:supplierAddress,destination,jobType:'supplier_pickup',priority:req.body?.priority||'normal',promisedAt:po.expected_date||null,notes:`Supplier pickup for ${po.po_number}`,employeeId:req.employee?.id||null,doc:{document_kind:'purchase_order',document_number:po.po_number,party_type:'supplier',party_id:po.supplier_id,party_name:po.supplier_name,contact_name:po.supplier_contact,contact_phone:po.supplier_phone,contact_email:po.supplier_email,address_line:po.address,city:po.city,state:po.state,postal_code:po.zip,branch_name:po.branch_name,branch_address:destination,commercial_total:po.total,snapshot:{purchase_order:{id:po.id,po_number:po.po_number,status:po.status,expected_date:po.expected_date,total:po.total,notes:po.notes},supplier:{id:po.supplier_id,name:po.supplier_name,contact_name:po.supplier_contact,email:po.supplier_email,phone:po.supplier_phone,address:po.address,city:po.city,state:po.state,zip:po.zip},items}}});
    res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/from-sales-invoice/:id',requireAnyPermission('transactions','pos','transfers'),async(req,res)=>{
  try{
    const {rows:[tx]}=await db.execute({sql:`SELECT t.*,c.first_name||' '||c.last_name customer_name,c.phone customer_phone,c.email customer_email,c.address,c.city,c.state,c.zip,b.name branch_name,b.address branch_address,b.city branch_city,b.state branch_state,b.zip branch_zip FROM transactions t JOIN customers c ON c.id=t.customer_id JOIN branches b ON b.id=t.branch_id WHERE t.id=?`,args:[req.params.id]});
    if(!tx)return res.status(404).json({error:'Sales invoice not found'});if(String(tx.status)!=='completed')return res.status(409).json({error:'Only a completed customer sale can be forwarded to Dispatch.'});
    const customerAddress=addr(tx),origin=branchAddr(tx);if(!customerAddress)return res.status(409).json({error:'Customer delivery cannot be dispatched until the customer has a usable address.'});if(!origin)return res.status(409).json({error:'Selling branch requires a usable address before customer delivery can be dispatched.'});
    const {rows:items}=await db.execute({sql:'SELECT id,product_id,product_name,sku,quantity,unit_price,tax_amount,total FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[tx.id]});
    const row=await createJob({sourceType:'sales_invoice',sourceId:Number(tx.id),branchId:Number(tx.branch_id),origin,destination:customerAddress,jobType:'customer_delivery',priority:req.body?.priority||'normal',promisedAt:req.body?.promised_at||null,notes:`Customer delivery for invoice ${tx.transaction_number}`,employeeId:req.employee?.id||null,doc:{document_kind:'sales_invoice',document_number:tx.transaction_number,party_type:'customer',party_id:tx.customer_id,party_name:tx.customer_name,contact_phone:tx.customer_phone,contact_email:tx.customer_email,address_line:tx.address,city:tx.city,state:tx.state,postal_code:tx.zip,branch_name:tx.branch_name,branch_address:origin,commercial_total:tx.total,snapshot:{invoice:{id:tx.id,transaction_number:tx.transaction_number,status:tx.status,total:tx.total,payment_method:tx.payment_method,created_at:tx.created_at},customer:{id:tx.customer_id,name:tx.customer_name,phone:tx.customer_phone,email:tx.customer_email,address:tx.address,city:tx.city,state:tx.state,zip:tx.zip},items}}});
    res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.post('/from-rental/:id',requireAnyPermission('rentals','rentals_manage','transfers'),async(req,res)=>{
  try{
    const direction=String(req.body?.direction||'delivery').toLowerCase();if(!['delivery','pickup'].includes(direction))return res.status(400).json({error:'direction must be delivery or pickup'});
    const {rows:[ra]}=await db.execute({sql:`SELECT ra.*,c.first_name||' '||c.last_name customer_name,c.phone customer_phone,c.email customer_email,c.address,c.city,c.state,c.zip,b.name branch_name,b.address branch_address,b.city branch_city,b.state branch_state,b.zip branch_zip,co.transaction_number checkout_invoice_number FROM rental_agreements ra JOIN customers c ON c.id=ra.customer_id JOIN branches b ON b.id=ra.branch_id LEFT JOIN transactions co ON co.id=ra.checkout_transaction_id WHERE ra.id=?`,args:[req.params.id]});
    if(!ra)return res.status(404).json({error:'Rental agreement not found'});
    if(direction==='delivery'&&!Number(ra.delivery_required))return res.status(409).json({error:'This rental is not configured for delivery.'});if(direction==='pickup'&&!Number(ra.pickup_required))return res.status(409).json({error:'This rental is not configured for return pickup.'});
    if(direction==='delivery'&&!['awaiting_issue','active'].includes(String(ra.status)))return res.status(409).json({error:'Rental delivery can only be forwarded once the rental is awaiting issue or active.'});if(direction==='pickup'&&!['active','returned'].includes(String(ra.status)))return res.status(409).json({error:'Rental pickup can only be forwarded for an active or returned rental.'});
    const customerAddress=String(ra.delivery_address||'').trim()||addr(ra),branch=branchAddr(ra);if(!customerAddress)return res.status(409).json({error:'Rental logistics requires a usable customer delivery/pickup address.'});if(!branch)return res.status(409).json({error:'Rental branch requires a usable address before dispatch.'});
    const {rows:items}=await db.execute({sql:'SELECT id,product_id,product_name,sku,quantity,daily_rate,rental_fee,deposit_amount FROM rental_agreement_items WHERE agreement_id=? AND parent_item_id IS NULL ORDER BY id',args:[ra.id]});
    const invoiceNumber=ra.checkout_invoice_number||ra.agreement_number;const origin=direction==='delivery'?branch:customerAddress,destination=direction==='delivery'?customerAddress:branch;
    const row=await createJob({sourceType:'rental',sourceId:Number(ra.id),branchId:Number(ra.branch_id),origin,destination,jobType:direction==='delivery'?'rental_delivery':'rental_pickup',priority:req.body?.priority||'normal',promisedAt:direction==='pickup'?ra.due_date:(req.body?.promised_at||null),notes:`${direction==='delivery'?'Rental delivery':'Rental return pickup'} for ${ra.agreement_number}`,employeeId:req.employee?.id||null,doc:{document_kind:'rental_invoice',document_number:invoiceNumber,party_type:'customer',party_id:ra.customer_id,party_name:ra.customer_name,contact_phone:ra.customer_phone,contact_email:ra.customer_email,address_line:customerAddress,city:ra.city,state:ra.state,postal_code:ra.zip,branch_name:ra.branch_name,branch_address:branch,commercial_total:ra.checkout_transaction_id?null:(Number(ra.rental_subtotal||0)+Number(ra.tax_amount||0)+Number(ra.delivery_cost||0)+Number(ra.pickup_cost||0)),snapshot:{rental:{id:ra.id,agreement_number:ra.agreement_number,status:ra.status,due_date:ra.due_date,delivery_required:!!ra.delivery_required,pickup_required:!!ra.pickup_required,delivery_address:ra.delivery_address,checkout_invoice_number:ra.checkout_invoice_number},customer:{id:ra.customer_id,name:ra.customer_name,phone:ra.customer_phone,email:ra.customer_email,address:customerAddress},items}}});
    res.status(201).json(row);
  }catch(e){res.status(400).json({error:e.message});}
});

router.get('/jobs/:id/source-document',requireAnyPermission('transfers','purchasing','transactions','rentals','work_orders'),async(req,res)=>{try{const {rows:[row]}=await db.execute({sql:'SELECT * FROM dispatch_source_documents WHERE dispatch_job_id=?',args:[req.params.id]});if(!row)return res.status(404).json({error:'Dispatch source document not found'});row.snapshot=JSON.parse(row.snapshot_json||'{}');delete row.snapshot_json;res.json(row);}catch(e){res.status(500).json({error:e.message});}});

router.use(require('./logistics-repair-handoff'));

module.exports=router;
module.exports.ensureSchema=ensureSchema;
