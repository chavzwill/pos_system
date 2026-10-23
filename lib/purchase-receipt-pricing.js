'use strict';
const {db}=require('../database');
const {can}=require('./permissions');
const sql=(sql,args=[])=>({sql,args});
const fail=(status,message)=>Object.assign(new Error(message),{status});
let ready;
async function ensureReceiptPricingSchema(){
 if(!ready)ready=(async()=>{
  await require('../routes/purchase-receiving-review').ensureReceivingReviewSchema();
  await db.batch([
   sql(`CREATE TABLE IF NOT EXISTS purchase_receipt_cost_adjustments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,purchase_receipt_item_id INTEGER NOT NULL UNIQUE REFERENCES purchase_receipt_items(id),
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id),po_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),
    product_id INTEGER REFERENCES products(id),ordered_unit_cost REAL NOT NULL,receipt_unit_cost REAL NOT NULL,
    previous_catalog_cost REAL,reason TEXT NOT NULL,recorded_by_employee_id INTEGER NOT NULL REFERENCES employees(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
   sql('CREATE INDEX IF NOT EXISTS idx_receipt_cost_adjustments_po ON purchase_receipt_cost_adjustments(po_id,id)'),
   sql("CREATE TRIGGER IF NOT EXISTS trg_receipt_cost_no_update BEFORE UPDATE ON purchase_receipt_cost_adjustments BEGIN SELECT RAISE(ABORT,'Receipt cost adjustments are immutable'); END"),
   sql("CREATE TRIGGER IF NOT EXISTS trg_receipt_cost_no_delete BEFORE DELETE ON purchase_receipt_cost_adjustments BEGIN SELECT RAISE(ABORT,'Receipt cost adjustments retain their audit history'); END")
  ],'write');
 })().catch(e=>{ready=null;throw e;});return ready;
}
function amount(value,places,label){
 const s=String(value??'').trim();if(!new RegExp('^\\d{1,9}(?:\\.\\d{1,'+places+'})?$').test(s))throw fail(400,label+' must be non-negative with up to '+places+' decimal places');
 const n=Number(s);if(!Number.isFinite(n))throw fail(400,label+' is invalid');return n;
}
function reason(value){const s=String(value||'').trim();if(s.length<5||s.length>1000)throw fail(400,'A pricing reason of 5–1,000 characters is required');return s;}
function assertStaffBranch(req,po){
 if(req.apiKey||!req.employee)throw fail(403,'Price adjustments require an authenticated staff session');
 const own=req.employee.default_branch_id;if(own!=null&&Number(own)!==Number(po.branch_id)&&!can(req.employee.permissions,'branches')&&!can(req.employee.permissions,'security_manage'))throw fail(403,'Price adjustments belong to another receiving branch');
}
async function resolveReceiptPricing(executor,{req,po,item,line}){
 const ordered=Number(item.unit_cost||0);
 const unitCost=line.receipt_unit_cost===undefined?ordered:amount(line.receipt_unit_cost,4,'Actual receipt unit cost');
 const costChanged=Math.round(unitCost*10000)!==Math.round(ordered*10000);
 const hasRetail=line.proposed_retail_price!==undefined;
 let proposed=null,expected=null;
 if(hasRetail){proposed=amount(line.proposed_retail_price,2,'Proposed retail price');expected=amount(line.expected_retail_price,2,'Current retail price');if(proposed<=0)throw fail(400,'Proposed retail price must be greater than zero');}
 if(!costChanged&&!hasRetail)return{unitCost,costChanged:false,proposed:null};
 assertStaffBranch(req,po);
 if(costChanged&&!can(req.employee.permissions,'inventory_edit'))throw fail(403,'Inventory edit permission is required to change receipt cost');
 const note=reason(line.pricing_reason);
 const product=item.product_id?(await executor.execute(sql('SELECT id,price,cost,is_rental,is_service,is_non_inventory FROM products WHERE id=?',[item.product_id]))).rows[0]:null;
 if(hasRetail){
  if(!product||Number(product.is_service)||Number(product.is_rental)||Number(product.is_non_inventory))throw fail(409,'Retail price proposals require a linked retail inventory item');
  if(Math.round(Number(product.price)*100)!==Math.round(expected*100))throw fail(409,'Retail price changed after loading. Reload the PO before receiving with a price proposal');
  if(Math.round(proposed*100)===Math.round(expected*100))proposed=null;
 }
 return{unitCost,costChanged,proposed,expected,reason:note,previousCatalogCost:product?Number(product.cost):null};
}
async function recordReceiptPricing(executor,{req,po,item,line,receiptItemId}){
 // Recheck permissions and current retail price inside the inventory transaction.
 const pricing=await resolveReceiptPricing(executor,{req,po,item,line});let proposalId=null;
 if(pricing.costChanged)await executor.execute(sql('INSERT INTO purchase_receipt_cost_adjustments(purchase_receipt_item_id,po_id,po_item_id,product_id,ordered_unit_cost,receipt_unit_cost,previous_catalog_cost,reason,recorded_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?)',[receiptItemId,po.id,item.id,item.product_id||null,Number(item.unit_cost||0),pricing.unitCost,pricing.previousCatalogCost,pricing.reason,req.employee.id]));
 if(pricing.proposed!==null){
  const pending=(await executor.execute(sql("SELECT id FROM purchase_retail_price_proposals WHERE product_id=? AND status='pending'",[item.product_id]))).rows[0];
  if(pending)throw fail(409,'This item already has a pending retail price proposal. Review it or receive without a new retail proposal');
  const result=await executor.execute(sql('INSERT INTO purchase_retail_price_proposals(po_id,po_item_id,product_id,previous_price_cents,proposed_price_cents,receipt_unit_cost_cents,reason,proposed_by_employee_id,purchase_receipt_item_id) VALUES(?,?,?,?,?,?,?,?,?)',[po.id,item.id,item.product_id,Math.round(pricing.expected*100),Math.round(pricing.proposed*100),Math.round(pricing.unitCost*100),pricing.reason,req.employee.id,receiptItemId]));proposalId=Number(result.lastInsertRowid);
 }
 return{receipt_item_id:receiptItemId,ordered_unit_cost:Number(item.unit_cost||0),receipt_unit_cost:pricing.unitCost,unit_cost_changed:pricing.costChanged,retail_price_proposal_id:proposalId};
}
module.exports={ensureReceiptPricingSchema,resolveReceiptPricing,recordReceiptPricing};
