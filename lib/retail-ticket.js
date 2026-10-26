'use strict';
const {db}=require('../database');
const {extraTotals}=require('./retail-ticket-pricing');
let ready;
async function ensureSchema(){
  if(ready)return ready;
  ready=(async()=>{
    for(const [table,definitions] of Object.entries({transactions:['discount_mode TEXT','discount_value REAL','discount_source TEXT','discount_reference_id INTEGER'],transaction_items:["line_type TEXT NOT NULL DEFAULT 'product'",'line_discount_percent REAL NOT NULL DEFAULT 0','display_order INTEGER'],quotation_items:["line_type TEXT NOT NULL DEFAULT 'product'"]})){
      const {rows}=await db.execute(`PRAGMA table_info(${table})`);const names=new Set(rows.map(x=>x.name));
      for(const definition of definitions)if(!names.has(definition.split(' ')[0])){try{await db.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);}catch(e){if(!/duplicate column name/i.test(e.message))throw e;}}
    }
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS retail_line_discount_snapshots(transaction_item_id INTEGER PRIMARY KEY,transaction_id INTEGER NOT NULL,quantity REAL NOT NULL,gross_cents INTEGER NOT NULL,line_discount_cents INTEGER NOT NULL,ticket_discount_cents INTEGER NOT NULL,total_discount_cents INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`},
      {sql:`CREATE TRIGGER IF NOT EXISTS retail_line_discount_immutable_update BEFORE UPDATE ON retail_line_discount_snapshots BEGIN SELECT RAISE(ABORT,'Sale discount evidence is immutable'); END`},
      {sql:`CREATE TRIGGER IF NOT EXISTS retail_line_discount_immutable_delete BEFORE DELETE ON retail_line_discount_snapshots BEGIN SELECT RAISE(ABORT,'Sale discount evidence is immutable'); END`}
    ],'write');
  })().catch(e=>{ready=null;throw e;});return ready;
}
async function persistTicket(tx,req,id){
  if(req.body.source_hold_id){
    const heldId=Number(req.body.source_hold_id);
    const closed=await tx.execute({sql:"UPDATE transactions SET status='converted' WHERE id=? AND status='hold'",args:[heldId]});
    if(Number(closed.rowsAffected)!==1)throw new Error('Held sale was already completed or closed');
    await tx.execute({sql:`INSERT INTO held_sale_recall_links(held_transaction_id,held_transaction_number,completed_transaction_id,completed_transaction_number) SELECT h.id,h.transaction_number,s.id,s.transaction_number FROM transactions h,transactions s WHERE h.id=? AND s.id=?`,args:[heldId,id]});
    await tx.execute({sql:"UPDATE quotations SET status='converted',converted_to_tx=? WHERE converted_to_tx=?",args:[id,heldId]});
  }
  const evidence=req.retailTicketPricing;if(!evidence)throw new Error('Ticket pricing evidence is missing');
  await tx.execute({sql:'UPDATE transactions SET discount_mode=?,discount_value=?,discount_source=?,discount_reference_id=? WHERE id=?',args:[evidence.mode,evidence.value,evidence.source,evidence.referenceId,id]});
  const {rows}=await tx.execute({sql:'SELECT id,quantity,total FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[id]});
  if(rows.length!==req.body.items.length)throw new Error('Ticket line evidence does not match saved products');
  for(let i=0;i<rows.length;i++){
    const item=req.body.items[i],row=rows[i];
    if(Math.round(Number(row.total)*100)!==evidence.gross_cents[i])throw new Error('Selling price changed during checkout; review and retry');
    await tx.execute({sql:'UPDATE transaction_items SET discount_amount=?,line_discount_percent=?,display_order=? WHERE id=?',args:[evidence.allocations[i]/100,Number(item.line_discount_percent||0),item.display_order??i,row.id]});
    await tx.execute({sql:'INSERT INTO retail_line_discount_snapshots(transaction_item_id,transaction_id,quantity,gross_cents,line_discount_cents,ticket_discount_cents,total_discount_cents) VALUES(?,?,?,?,?,?,?)',args:[row.id,id,row.quantity,Math.round(Number(row.total)*100),evidence.line_discounts[i],evidence.ticket_shares[i],evidence.allocations[i]]});
  }
  for(const line of req.retailTicketExtras||[]){const t=extraTotals([line],req.body.tax_exempt);await tx.execute({sql:'INSERT INTO transaction_items(transaction_id,product_id,product_name,sku,quantity,unit_price,discount_amount,tax_amount,total,line_type,display_order) VALUES(?,NULL,?,\'\',1,?,0,?,?,?,?)',args:[id,line.product_name,line.unit_price,t.tax,t.subtotal,line.line_type,line.display_order]});}
}
module.exports={ensureSchema,persistTicket,extraTotals};
