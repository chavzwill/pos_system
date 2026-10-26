'use strict';
// Read-only projection of authoritative purchasing documents. No schema or ledger writes.
const router=require('express').Router(),{db}=require('../database'),{can}=require('../lib/permissions');
const sources={
 payment:{table:'supplier_payments',number:'payment_number',date:'payment_date',po:'NULL',permission:'reports_financial',amount:'d.amount',status:"'recorded'",label:'Supplier payment'},
 pr:{table:'purchase_requests',number:'pr_number',date:'created_at',po:'d.converted_to_po_id',permission:'purchase_requests',lines:['purchase_request_items','pr_id'],amount:'(SELECT COALESCE(SUM(total),0) FROM purchase_request_items WHERE pr_id=d.id)',label:'Purchase request'},
 po:{table:'purchase_orders',number:'po_number',date:'created_at',po:'d.id',permission:'purchasing',lines:['purchase_order_items','po_id'],amount:'d.total',label:'Purchase order'},
 receipt:{table:'purchase_receipts',number:'receipt_number',date:'received_at',po:'d.po_id',permission:'purchasing',lines:['purchase_receipt_items','receipt_id'],amount:'d.total_cost',label:'Goods received note',status:"'received'"},
 captured_invoice:{table:'captured_supplier_invoices',number:'invoice_number',date:'invoice_date',po:'d.purchase_order_id',permission:'reports_financial',amount:'d.total',label:'Captured supplier invoice'},
 invoice:{table:'supplier_invoices',number:'invoice_number',date:'invoice_date',po:'d.purchase_order_id',permission:'reports_financial',amount:'d.total',label:'Posted supplier invoice'},
 credit:{table:'supplier_credit_notes',number:'credit_number',date:'credit_date',po:'i.purchase_order_id',join:'LEFT JOIN supplier_invoices i ON i.id=d.supplier_invoice_id',permission:'reports_financial',lines:['supplier_credit_items','credit_note_id'],amount:'d.total_cents/100.0',label:'Supplier credit note'},
 return:{table:'supplier_returns',number:'return_number',date:'created_at',po:'d.po_id',permission:'purchasing',lines:['supplier_return_items','return_id'],amount:'NULL',label:'Supplier return'}
};
const fail=(status,message)=>Object.assign(new Error(message),{status});
const positive=(v)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'Choose a valid record or branch');return n};
const visible=(employee,type)=>can(employee.permissions,sources[type].permission);
async function context(req){
 if(!req.employee||req.apiKey)throw fail(401,'Sign in to view purchasing documents');
 const available=Object.keys(sources).filter(t=>visible(req.employee,t));if(!available.length)throw fail(403,'Purchasing document access is required');
 const {rows}=await db.execute({sql:"SELECT name FROM sqlite_master WHERE type='table'",args:[]});const tables=new Set(rows.map(x=>x.name));
 const all=can(req.employee.permissions,'branches')||can(req.employee.permissions,'security_manage');
 const own=req.employee.default_branch_id==null?null:positive(req.employee.default_branch_id);
 const branch=req.query.branch_id?positive(req.query.branch_id):null;
 if(branch&&!all&&branch!==own)throw fail(403,'This branch is outside your access');
 let currency=null;if(tables.has('procurement_currency_settings'))currency=(await db.execute({sql:'SELECT base_currency FROM procurement_currency_settings WHERE id=1',args:[]})).rows[0]?.base_currency||null;
 return {available,tables,all,own,branch,currency,employee:req.employee};
}
async function projection(type,ctx){
 const s=sources[type],{rows:info}=await db.execute({sql:`PRAGMA table_info(${s.table})`,args:[]});const columns=new Set(info.map(x=>x.name));
 // Older request schemas need not have a supplier yet.
 const supplier=columns.has('supplier_id')?'d.supplier_id':'NULL';
 const supplierJoin=ctx.tables.has('suppliers')?`LEFT JOIN suppliers s ON s.id=${supplier}`:'';
 const branchJoin=ctx.tables.has('branches')?'LEFT JOIN branches b ON b.id=d.branch_id':'';
 const sql=`SELECT '${type}' type,d.id,d.${s.number} number,${s.status||'d.status'} status,d.${s.date} date,d.branch_id,${supplier} supplier_id,${ctx.tables.has('suppliers')?'s.name':'NULL'} supplier_name,${ctx.tables.has('branches')?'b.name':'NULL'} branch_name,${s.po} po_id,${columns.has('base_currency')?'d.base_currency':type==='pr'&&columns.has('currency')?'d.currency':'NULL'} currency,${type==='pr'&&columns.has('tax_amount')?'('+s.amount+'+COALESCE(d.tax_amount,0))':s.amount} amount FROM ${s.table} d ${s.join||''} ${supplierJoin} ${branchJoin}`;
 const args=[],where=[];
 if(ctx.branch||(!ctx.all&&ctx.own!=null)){where.push('d.branch_id=?');args.push(ctx.branch||ctx.own)}
 else if(!ctx.all){
  // Unassigned requesters can track their own requests, without global visibility.
  if(type==='pr'){where.push('d.employee_id=?');args.push(ctx.employee.id)}else where.push('0=1');
 }
 return {sql:sql+' WHERE '+(where.join(' AND ')||'1=1'),args};
}
async function union(ctx){const parts=[],args=[];for(const t of ctx.available){if(!ctx.tables.has(sources[t].table))continue;const p=await projection(t,ctx);parts.push(p.sql);args.push(...p.args)}return {sql:parts.join(' UNION ALL '),args}}
function filters(query){const where=[],args=[];if(query.type){if(!sources[query.type])throw fail(400,'Unknown document type');where.push('type=?');args.push(query.type)}if(query.status){where.push('status=?');args.push(String(query.status).slice(0,60))}if(query.supplier_id){where.push('supplier_id=?');args.push(positive(query.supplier_id))}if(query.q){where.push("(instr(lower(number),lower(?))>0 OR instr(lower(COALESCE(supplier_name,'')),lower(?))>0)");const q=String(query.q).slice(0,160);args.push(q,q)}for(const [key,op]of [['start','>='],['end','<=']])if(query[key]){const value=String(query[key]);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw fail(400,'Dates must use YYYY-MM-DD');where.push(`date(date)${op}date(?)`);args.push(value)}return {where:where.length?' WHERE '+where.join(' AND '):'',args}}
const decorate=(r,ctx)=>({...r,label:sources[r.type].label,currency:r.currency||ctx.currency});
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next()});
router.get('/',async(req,res)=>{try{
 const ctx=await context(req),f=filters(req.query);if(req.query.type&&!ctx.available.includes(req.query.type))throw fail(403,'You do not have access to this document type');
 const limit=req.query.limit===undefined?30:Number(req.query.limit),offset=req.query.offset===undefined?0:Number(req.query.offset);if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw fail(400,'Invalid page size or offset');
 const u=await union(ctx),unavailable=ctx.available.filter(t=>!ctx.tables.has(sources[t].table));if(!u.sql)return res.json({records:[],total:0,types:ctx.available.map(type=>({type,label:sources[type].label})),facets:[],unavailable});
 const sql=' FROM ('+u.sql+') documents'+f.where,args=[...u.args,...f.args];
 const {rows:[count]}=await db.execute({sql:'SELECT COUNT(*) total'+sql,args});const {rows}=await db.execute({sql:'SELECT *'+sql+' ORDER BY date DESC,type,id DESC LIMIT ? OFFSET ?',args:[...args,limit,offset]});
 const {rows:facets}=await db.execute({sql:'SELECT DISTINCT branch_id,branch_name,supplier_id,supplier_name FROM ('+u.sql+') ORDER BY branch_name,supplier_name',args:u.args});
 res.json({facets,records:rows.map(r=>decorate(r,ctx)),total:Number(count.total),limit,offset,types:ctx.available.map(type=>({type,label:sources[type].label})),unavailable});
 }catch(e){res.status(e.status||500).json({error:e.status?e.message:'Unable to load purchasing documents. Try again.'})}});
router.get('/:type/:id',async(req,res)=>{try{
 const ctx=await context(req),{type}=req.params,id=positive(req.params.id),s=sources[type];if(!s)throw fail(400,'Unknown document type');if(!visible(req.employee,type))throw fail(403,'You do not have access to this document type');if(!ctx.tables.has(s.table))throw fail(404,'Document not found');
 const p=await projection(type,ctx),{rows:[record]}=await db.execute({sql:'SELECT * FROM ('+p.sql+') WHERE id=?',args:[...p.args,id]});if(!record)throw fail(404,'Document not found');
 const {rows:[detail]}=await db.execute({sql:`SELECT * FROM ${s.table} WHERE id=?`,args:[id]});let lines=[];if(s.lines&&ctx.tables.has(s.lines[0]))lines=(await db.execute({sql:`SELECT * FROM ${s.lines[0]} WHERE ${s.lines[1]}=? ORDER BY id`,args:[id]})).rows;
 let related=[];const u=await union(ctx);if(record.po_id&&u.sql)related=(await db.execute({sql:'SELECT * FROM ('+u.sql+') WHERE po_id=? AND NOT(type=? AND id=?) ORDER BY date,type,id',args:[...u.args,record.po_id,type,id]})).rows.map(r=>decorate(r,ctx));
 // Return only document fields that are useful in the register, never internal operation payloads.
 let payments=[];if(can(req.employee.permissions,'reports_financial')&&record.po_id&&ctx.tables.has('supplier_payment_allocations')&&ctx.tables.has('supplier_payments')){
 const p=await projection('payment',ctx);payments=(await db.execute({sql:'SELECT * FROM ('+p.sql+') WHERE id IN (SELECT a.payment_id FROM supplier_payment_allocations a JOIN supplier_invoices i ON i.id=a.supplier_invoice_id WHERE i.purchase_order_id=?)',args:[...p.args,record.po_id]})).rows.map(r=>({...decorate(r,ctx),relationship:'Payment allocated to an invoice on this PO'}));
 }
 if(type==='payment'&&ctx.tables.has('supplier_payment_allocations')&&ctx.tables.has('supplier_invoices')){const p=await projection('invoice',ctx);related=(await db.execute({sql:'SELECT * FROM ('+p.sql+') WHERE id IN (SELECT supplier_invoice_id FROM supplier_payment_allocations WHERE payment_id=?)',args:[...p.args,id]})).rows.map(r=>({...decorate(r,ctx),relationship:'Invoice with payment allocation'}));}
 related=related.map(r=>({...r,relationship:r.relationship||'Same purchase order'}));related.push(...payments.filter(r=>r.type!==type||Number(r.id)!==id));
 const fields={};for(const key of ['notes','department','required_date','expected_date','received_at','due_date','reason','reason_code','reason_detail','resolution','dispatch_reference','subtotal','tax_amount','total','supplier_invoice_id','converted_to_po_id','payment_method','reference'])if(detail[key]!=null)fields[key]=detail[key];
 let settlement=null;if(type==='invoice'&&record.status!=='void'&&['supplier_payment_allocations','supplier_credit_applications','supplier_credit_notes','consumable_credit_applications','consumable_credit_notes'].every(t=>ctx.tables.has(t))){const balance=await require('../lib/supplier-ap-balances').invoiceBalance(db,id);settlement={paid:balance.paid_amount,credited:balance.credited_amount,balance:balance.balance_cents/100};}
 let matchedReceiptIds=[];const allocation=type==='invoice'?['supplier_invoice_receipt_allocations','supplier_invoice_id']:type==='captured_invoice'?['captured_supplier_invoice_receipts','captured_invoice_id']:null;
 if(allocation&&ctx.tables.has(allocation[0])&&ctx.tables.has('purchase_receipt_items')){lines=(await db.execute({sql:`SELECT a.id,l.product_name,l.sku,a.quantity_invoiced quantity,a.invoice_unit_cost_cents/100.0 unit_cost,a.invoice_line_cents/100.0 total FROM ${allocation[0]} a JOIN purchase_receipt_items l ON l.id=a.purchase_receipt_item_id WHERE a.${allocation[1]}=? ORDER BY a.id`,args:[id]})).rows;matchedReceiptIds=(await db.execute({sql:`SELECT DISTINCT l.receipt_id FROM ${allocation[0]} a JOIN purchase_receipt_items l ON l.id=a.purchase_receipt_item_id WHERE a.${allocation[1]}=?`,args:[id]})).rows.map(x=>Number(x.receipt_id));}
 related=related.map(r=>r.type==='receipt'&&matchedReceiptIds.includes(Number(r.id))?{...r,relationship:'Matched receipt evidence'}:r);
 res.json({record:decorate(record,ctx),fields,lines,related,settlement});
 }catch(e){res.status(e.status||500).json({error:e.status?e.message:'Unable to open this purchasing document. Try again.'})}});
module.exports=router;
