'use strict';
const {db}=require('../database');
const {can}=require('./permissions');
const {ensureProcurementFx,getBaseCurrency,getRate}=require('./procurement-fx');
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
let ready;
function validateCurrency(value){const code=String(value||'').trim().toUpperCase();if(!/^[A-Z]{3}$/.test(code))throw failure('Choose a three-letter currency code');return code;}
function decimal(value,places,label,max){const s=(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<1&&String(value).includes('e')?value.toFixed(places):String(value??'')).trim();if(!new RegExp('^\\d+(?:\\.\\d{1,'+places+'})?$').test(s)||!Number.isFinite(Number(s))||Number(s)>max)throw failure(`${label} is invalid or exceeds the supported precision`);return s;}
function validateRate(value){const s=decimal(value,8,'Exchange rate',1000000);if(Number(s)<=0)throw failure('Exchange rate must be greater than zero');return Number(s);}
function scaled(value,places){const [a,b='']=String(value).split('.');return BigInt(a)*10n**BigInt(places)+BigInt(b.padEnd(places,'0'));}
function convertUnitCost(value,rate){const cost=decimal(value,6,'Supplier unit cost',999999999),r=validateRate(rate);const result=(scaled(cost,6)*scaled(r.toFixed(8),8)+50000000n)/100000000n;const n=Number(result)/1000000;if(n>999999999)throw failure('Converted unit cost is too large');return n;}
async function ensureSchema(){if(ready)return ready;ready=(async()=>{
 await ensureProcurementFx();
 const tables={purchase_orders:['currency TEXT','base_currency TEXT','fx_rate_to_base REAL','currency_subtotal REAL','currency_total REAL'],purchase_order_items:['supplier_unit_cost REAL','supplier_line_total REAL']};
 for(const [table,defs]of Object.entries(tables)){const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});const names=new Set(rows.map(x=>x.name));for(const def of defs)if(!names.has(def.split(' ')[0])){try{await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${def}`,args:[]});}catch(e){if(!/duplicate column name/i.test(e.message))throw e;}}}
 await db.batch([
 {sql:`CREATE TABLE IF NOT EXISTS purchase_order_fx_snapshots(po_id INTEGER PRIMARY KEY REFERENCES purchase_orders(id),currency TEXT NOT NULL,base_currency TEXT NOT NULL,rate_to_base REAL NOT NULL,rate_mode TEXT NOT NULL,rate_id INTEGER,rate_date TEXT NOT NULL,source_reference TEXT NOT NULL,recorded_by_employee_id INTEGER,supplier_total REAL NOT NULL,base_total REAL NOT NULL,lines_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`},
 {sql:`CREATE TRIGGER IF NOT EXISTS po_fx_snapshot_no_update BEFORE UPDATE ON purchase_order_fx_snapshots BEGIN SELECT RAISE(ABORT,'PO currency evidence is immutable'); END`},
 {sql:`CREATE TRIGGER IF NOT EXISTS po_fx_snapshot_no_delete BEFORE DELETE ON purchase_order_fx_snapshots BEGIN SELECT RAISE(ABORT,'PO currency evidence is immutable'); END`}
 ],'write');
 })().catch(e=>{ready=null;throw e;});return ready;}
async function resolveCurrency(req,items,executor=db){
 await ensureSchema();const b=req.body||{},base=await getBaseCurrency(executor),currency=validateCurrency(b.currency||base),mode=b.fx_mode||'managed';
 if(!['managed','manual'].includes(mode))throw failure('Choose a saved rate or a documented one-order rate');
 const date=String(b.fx_date||new Date().toISOString().slice(0,10));if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw failure('Exchange-rate date is invalid');
 let rate=1,reference='base_currency',rateId=null;
 if(currency===base){if(b.fx_rate_to_base!=null&&Number(b.fx_rate_to_base)!==1)throw failure('The base-currency exchange rate must be 1');}
 else if(mode==='manual'){
  if(req.apiKey||!req.employee||!can(req.employee.permissions,'purchasing_approve'))throw failure('Purchasing approval authority is required for a one-order exchange rate',403);
  rate=validateRate(b.fx_rate_to_base);reference=String(b.fx_source_reference||'').trim();if(reference.length<5||reference.length>500)throw failure('Document the exchange-rate source in 5–500 characters');
 }else{
  const saved=await getRate(executor,currency,date);rate=validateRate(saved.rate_to_base);rateId=Number(saved.id);reference=String(saved.source_reference);
  if(b.fx_rate_id!=null&&Number(b.fx_rate_id)!==rateId)throw failure('The saved exchange rate changed. Refresh the currency options before creating this PO',409);
  if(b.fx_rate_to_base!=null&&validateRate(b.fx_rate_to_base)!==rate)throw failure('The saved exchange rate changed. Refresh the currency options',409);
 }
 const sourceLines=items.map((item,index)=>{const qty=Number(item.quantity_ordered??item.quantity??1);if(!Number.isFinite(qty)||qty<=0)throw failure('Purchase quantities must be positive');const cost=Number(decimal(item.unit_cost??0,6,'Supplier unit cost',999999999));return{index,product_id:item.product_id||null,entered_quantity:qty,entered_unit_cost:cost,uom_code:item.uom_code||item.unit||null,line_total:Number((qty*cost).toFixed(2))};});
 const converted=items.map((item,i)=>({...item,unit_cost:convertUnitCost(sourceLines[i].entered_unit_cost,rate)}));
 return{currency,base_currency:base,rate_to_base:rate,rate_mode:currency===base?'base':mode,rate_id:rateId,rate_date:date,source_reference:reference,sourceLines,items:converted};
}
async function persistCurrency(tx,req,poId,context=req.purchaseCurrency){
 if(!context)throw failure('Purchase-order currency evidence is missing');
 // Re-resolve managed rates in the same write transaction to reject stale previews.
 const check=await resolveCurrency(req,context.sourceLines.map(x=>({product_id:x.product_id,quantity:x.entered_quantity,unit_cost:x.entered_unit_cost,uom_code:x.uom_code})),tx);
 if(check.base_currency!==context.base_currency||check.rate_to_base!==context.rate_to_base||check.rate_id!==context.rate_id)throw failure('Exchange rate changed while saving this purchase order',409);
 const {rows:items}=await tx.execute({sql:'SELECT * FROM purchase_order_items WHERE po_id=? ORDER BY id',args:[poId]});if(items.length!==context.sourceLines.length)throw failure('Currency evidence does not match the saved PO lines');
 for(let i=0;i<items.length;i++){const source=context.sourceLines[i],line=items[i],factor=Number(line.quantity_ordered)/source.entered_quantity;const expected=Number((convertUnitCost(source.entered_unit_cost,context.rate_to_base)/factor).toFixed(6));if(Math.abs(Number(line.unit_cost)-expected)>0.0000011)throw failure('PO unit conversion does not match currency evidence');await tx.execute({sql:'UPDATE purchase_order_items SET supplier_unit_cost=?,supplier_line_total=? WHERE id=?',args:[Number((source.entered_unit_cost/factor).toFixed(6)),source.line_total,line.id]});}
 const total=Number(context.sourceLines.reduce((sum,x)=>sum+x.line_total,0).toFixed(2));const {rows:[po]}=await tx.execute({sql:'SELECT total FROM purchase_orders WHERE id=?',args:[poId]});
 await tx.execute({sql:'UPDATE purchase_orders SET currency=?,base_currency=?,fx_rate_to_base=?,currency_subtotal=?,currency_total=? WHERE id=?',args:[context.currency,context.base_currency,context.rate_to_base,total,total,poId]});
 await tx.execute({sql:'INSERT INTO purchase_order_fx_snapshots(po_id,currency,base_currency,rate_to_base,rate_mode,rate_id,rate_date,source_reference,recorded_by_employee_id,supplier_total,base_total,lines_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',args:[poId,context.currency,context.base_currency,context.rate_to_base,context.rate_mode,context.rate_id,context.rate_date,context.source_reference,req.employee?.id||null,total,po.total,JSON.stringify(context.sourceLines)]});
}
module.exports={validateCurrency,validateRate,convertUnitCost,ensureSchema,resolveCurrency,persistCurrency};
