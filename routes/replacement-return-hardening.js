'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {nextNumber}=require('../lib/nextNumber');
const {syncBinQty}=require('../lib/binSync');
const {ensureInventoryTraceability,getTrackingProfile}=require('../lib/inventory-traceability');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryTraceability();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS replacement_fulfillments(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        return_item_id INTEGER NOT NULL REFERENCES return_items(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        transaction_item_id INTEGER NOT NULL REFERENCES transaction_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        variation_id INTEGER REFERENCES product_variations(id),
        branch_id INTEGER REFERENCES branches(id),
        quantity INTEGER NOT NULL,
        unit_cost_at_issue REAL,
        issued_by_employee_id INTEGER REFERENCES employees(id),
        issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(return_item_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS return_quarantine(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        return_item_id INTEGER NOT NULL REFERENCES return_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER REFERENCES branches(id),
        quantity INTEGER NOT NULL,
        unit_cost_at_return REAL,
        disposition_status TEXT NOT NULL DEFAULT 'quarantine',
        disposition_notes TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        UNIQUE(return_item_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS inventory_return_identity_allocations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        serial_id INTEGER REFERENCES inventory_serials(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        quantity INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(return_id,serial_id),
        UNIQUE(return_id,lot_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS replacement_identity_movements(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        return_item_id INTEGER NOT NULL REFERENCES return_items(id),
        original_transaction_id INTEGER NOT NULL REFERENCES transactions(id),
        transaction_item_id INTEGER NOT NULL REFERENCES transaction_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        tracking_mode TEXT NOT NULL CHECK(tracking_mode IN ('serial','lot')),
        direction TEXT NOT NULL CHECK(direction IN ('returned','issued')),
        serial_id INTEGER REFERENCES inventory_serials(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        quantity INTEGER NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK((serial_id IS NOT NULL AND lot_id IS NULL) OR (serial_id IS NULL AND lot_id IS NOT NULL))
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS replacement_financial_evidence(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        return_item_id INTEGER NOT NULL REFERENCES return_items(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER REFERENCES branches(id),
        quantity INTEGER NOT NULL,
        returned_unit_cost REAL,
        issued_unit_cost REAL,
        inventory_value_out REAL NOT NULL DEFAULT 0,
        accounting_state TEXT NOT NULL DEFAULT 'evidence_recorded',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(return_item_id)
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_replacement_return ON replacement_fulfillments(return_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_return_quarantine_return ON return_quarantine(return_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_replacement_identity_return ON replacement_identity_movements(return_id,return_item_id,direction)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_replacement_identity_serial ON replacement_identity_movements(serial_id,direction)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_replacement_identity_lot ON replacement_identity_movements(lot_id,direction)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_replacement_financial_return ON replacement_financial_evidence(return_id)'}
    ],'write');
    const {rows:cols}=await db.execute({sql:'PRAGMA table_info(replacement_fulfillments)',args:[]});
    if(!cols.some(c=>c.name==='variation_id'))await db.execute({sql:'ALTER TABLE replacement_fulfillments ADD COLUMN variation_id INTEGER REFERENCES product_variations(id)',args:[]});
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Replacement return integrity initialization failed',detail:e.message});}});

function money(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):0;}
function conflict(message,control='replacement_concurrency'){const e=new Error(message);e.status=409;e.control=control;return e;}
function text(v){return String(v??'').trim();}
function serialList(v){return Array.isArray(v)?v.map(x=>text(typeof x==='string'?x:x?.serial_number)).filter(Boolean):[];}
function lotList(v,label){
  if(!Array.isArray(v))return [];
  const out=v.map(x=>({lot_number:text(x?.lot_number),quantity:Number(x?.quantity)})).filter(x=>x.lot_number);
  if(out.some(x=>!Number.isInteger(x.quantity)||x.quantity<=0))throw conflict(`${label} lot quantities must be positive whole numbers`,'replacement_identity_invalid');
  const seen=new Set();for(const x of out){const k=x.lot_number.toLowerCase();if(seen.has(k))throw conflict(`${label} lot ${x.lot_number} is duplicated; combine its quantity into one line`,'replacement_identity_invalid');seen.add(k);}
  return out;
}
async function returnedQuantities(executor,transactionId){
  const {rows}=await executor.execute({sql:`SELECT ri.transaction_item_id,COALESCE(SUM(ri.quantity),0) returned_qty
    FROM return_items ri JOIN returns r ON r.id=ri.return_id
    WHERE r.original_transaction_id=? AND COALESCE(r.status,'completed')!='cancelled'
    GROUP BY ri.transaction_item_id`,args:[transactionId]});
  return new Map(rows.map(r=>[Number(r.transaction_item_id),Number(r.returned_qty||0)]));
}
async function identityOptions(executor,sale,line,profile){
  const productId=Number(line.product_id),branchId=Number(sale.branch_id);
  if(profile.tracking_mode==='serial'){
    const {rows:returned}=await executor.execute({sql:`SELECT s.id,s.serial_number,s.unit_cost,s.status
      FROM inventory_serials s
      JOIN inventory_identity_events e ON e.serial_id=s.id AND e.event_type='sold' AND e.reference_type='transaction' AND e.reference_id=?
      WHERE s.product_id=? AND s.status='sold'
        AND NOT EXISTS(SELECT 1 FROM inventory_return_identity_allocations a WHERE a.original_transaction_id=? AND a.serial_id=s.id)
      GROUP BY s.id,s.serial_number,s.unit_cost,s.status ORDER BY s.serial_number`,args:[String(sale.id),productId,sale.id]});
    const {rows:available}=await executor.execute({sql:`SELECT id,serial_number,unit_cost,expiry_date FROM inventory_serials
      WHERE product_id=? AND branch_id=? AND status='available' AND (expiry_date IS NULL OR date(expiry_date)>=date('now'))
      ORDER BY serial_number`,args:[productId,branchId]});
    return {tracking_mode:'serial',returnable_serials:returned,available_replacement_serials:available};
  }
  if(profile.tracking_mode==='lot'){
    const {rows:sold}=await executor.execute({sql:`SELECT l.id,l.lot_number,l.unit_cost,l.expiry_date,
        COALESCE(SUM(e.quantity),0) sold_qty,
        COALESCE((SELECT SUM(a.quantity) FROM inventory_return_identity_allocations a WHERE a.original_transaction_id=? AND a.lot_id=l.id),0) returned_qty
      FROM inventory_lots l JOIN inventory_identity_events e ON e.lot_id=l.id
      WHERE l.product_id=? AND e.event_type='sold' AND e.reference_type='transaction' AND e.reference_id=?
      GROUP BY l.id,l.lot_number,l.unit_cost,l.expiry_date HAVING sold_qty>returned_qty ORDER BY l.lot_number`,args:[sale.id,productId,String(sale.id)]});
    const {rows:available}=await executor.execute({sql:`SELECT id,lot_number,available_quantity,unit_cost,expiry_date FROM inventory_lots
      WHERE product_id=? AND branch_id=? AND status='available' AND available_quantity>0 AND (expiry_date IS NULL OR date(expiry_date)>=date('now'))
      ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,date(expiry_date),created_at,id`,args:[productId,branchId]});
    return {tracking_mode:'lot',returnable_lots:sold.map(x=>({...x,remaining_returnable:Number(x.sold_qty||0)-Number(x.returned_qty||0)})),available_replacement_lots:available};
  }
  return {tracking_mode:'none'};
}

router.get('/:id/replacement-identities',requirePermission('transactions_returns'),async(req,res)=>{
  try{
    const transactionId=Number(req.params.id);if(!transactionId)return res.status(400).json({error:'Invalid transaction id'});
    const {rows:[sale]}=await db.execute({sql:'SELECT id,status,branch_id,transaction_number FROM transactions WHERE id=?',args:[transactionId]});
    if(!sale)return res.status(404).json({error:'Transaction not found'});
    if(sale.status!=='completed')return res.status(409).json({error:'Only completed transactions can be inspected for replacement identities'});
    if(!sale.branch_id)return res.status(409).json({error:'Original transaction has no authoritative branch identity'});
    const {rows:lines}=await db.execute({sql:'SELECT id,product_id,product_name,sku,variation_id,quantity FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[sale.id]});
    const remaining=await returnedQuantities(db,sale.id);const items=[];
    for(const line of lines){
      if(!line.product_id)continue;const profile=await getTrackingProfile(db,Number(line.product_id));
      items.push({...line,remaining_returnable:Math.max(0,Number(line.quantity||0)-Number(remaining.get(Number(line.id))||0)),...(await identityOptions(db,sale,line,profile))});
    }
    res.json({transaction_id:sale.id,transaction_number:sale.transaction_number,branch_id:sale.branch_id,items});
  }catch(e){res.status(e.status||500).json({error:e.message,control:e.control});}
});

router.post('/:id/return',requirePermission('transactions_returns'),async(req,res,next)=>{
  if(req.body?.resolution!=='replacement')return next();
  try{
    const transactionId=Number(req.params.id),items=Array.isArray(req.body?.items)?req.body.items:[];
    if(!transactionId)return res.status(400).json({error:'Invalid transaction id'});
    if(!items.length)return res.status(400).json({error:'No items selected for replacement'});
    if(!req.employee)return res.status(401).json({error:'Authenticated employee required for replacement issue'});
    const {rows:[sale]}=await db.execute({sql:'SELECT * FROM transactions WHERE id=?',args:[transactionId]});
    if(!sale)return res.status(404).json({error:'Transaction not found'});
    if(sale.status!=='completed')return res.status(409).json({error:'Only completed transactions can be replaced'});
    if(!sale.branch_id)return res.status(409).json({error:'Replacement issue requires the original sale branch'});
    const {rows:[linkedRental]}=await db.execute({sql:'SELECT agreement_number FROM rental_agreements WHERE checkout_transaction_id=? OR settlement_transaction_id=?',args:[sale.id,sale.id]});
    if(linkedRental)return res.status(409).json({error:`This transaction belongs to rental agreement ${linkedRental.agreement_number}; use the Rentals workflow.`});
    const {rows:[linkedRepair]}=await db.execute({sql:'SELECT wo_number FROM work_orders WHERE assessment_transaction_id=? OR deposit_transaction_id=? OR final_transaction_id=?',args:[sale.id,sale.id,sale.id]});
    if(linkedRepair)return res.status(409).json({error:`This transaction belongs to work order ${linkedRepair.wo_number}; use the Repairs workflow.`});

    const {rows:saleItems}=await db.execute({sql:'SELECT * FROM transaction_items WHERE transaction_id=? ORDER BY id',args:[sale.id]});
    const returnedMap=await returnedQuantities(db,sale.id);
    let subtotal=0,tax=0;const prepared=[];
    for(const requestItem of items){
      const line=saleItems.find(x=>Number(x.id)===Number(requestItem.transaction_item_id));
      if(!line)return res.status(400).json({error:`Item ${requestItem.transaction_item_id} not found in transaction`});
      if(!line.product_id)return res.status(409).json({error:`Replacement cannot be issued for non-inventory line ${line.product_name}`});
      const qty=Number(requestItem.quantity||0),maxQty=Number(line.quantity||0)-Number(returnedMap.get(Number(line.id))||0);
      if(!Number.isInteger(qty)||qty<=0||qty>maxQty)return res.status(409).json({error:`Invalid replacement quantity for ${line.product_name}. Max replaceable: ${Math.max(0,maxQty)}`});
      const profile=await getTrackingProfile(db,Number(line.product_id));
      if(profile.tracking_mode!=='none'&&line.variation_id)return res.status(409).json({error:`${line.product_name} is a tracked variation, but existing serial/lot identities are not variation-bound. Replacement is blocked rather than risking the wrong variation.`,control:'replacement_identity_variation_unbound'});
      const {rows:[product]}=await db.execute({sql:'SELECT id,name,stock_qty,cost FROM products WHERE id=?',args:[line.product_id]});
      if(!product)return res.status(409).json({error:`Replacement product ${line.product_id} no longer exists`});
      let variation=null;
      if(line.variation_id){
        const {rows:[v]}=await db.execute({sql:'SELECT id,product_id,stock_qty FROM product_variations WHERE id=? AND product_id=?',args:[line.variation_id,line.product_id]});
        if(!v)return res.status(409).json({error:`The original variation for ${line.product_name} no longer exists`});variation=v;
        if(Number(v.stock_qty||0)<qty)return res.status(409).json({error:`Insufficient variation stock to issue ${qty} replacement unit(s) of ${line.product_name}`});
      }else if(Number(product.stock_qty||0)<qty)return res.status(409).json({error:`Insufficient stock to issue ${qty} replacement unit(s) of ${line.product_name}`});
      const {rows:[branchStock]}=await db.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[line.product_id,sale.branch_id]});
      if(!branchStock||Number(branchStock.stock_qty||0)<qty)return res.status(409).json({error:`Insufficient branch stock to issue ${qty} replacement unit(s) of ${line.product_name}`});

      let identity={tracking_mode:profile.tracking_mode};
      if(profile.tracking_mode==='serial'){
        const returnedSerials=serialList(requestItem.returned_serial_numbers||requestItem.serial_numbers);
        const issuedSerials=serialList(requestItem.replacement_serial_numbers||requestItem.issued_serial_numbers);
        if(returnedSerials.length!==qty||issuedSerials.length!==qty)return res.status(409).json({error:`${line.product_name} requires exactly ${qty} returned serial(s) and ${qty} replacement serial(s).`,control:'replacement_identity_invalid'});
        if(new Set(returnedSerials.map(x=>x.toLowerCase())).size!==qty||new Set(issuedSerials.map(x=>x.toLowerCase())).size!==qty)return res.status(409).json({error:`Duplicate serial numbers are not allowed for ${line.product_name}.`,control:'replacement_identity_invalid'});
        if(returnedSerials.some(x=>issuedSerials.some(y=>y.toLowerCase()===x.toLowerCase())))return res.status(409).json({error:'A returned serial cannot also be issued as its own replacement while it is in quarantine.',control:'replacement_identity_invalid'});
        identity={tracking_mode:'serial',returnedSerials,issuedSerials};
      }else if(profile.tracking_mode==='lot'){
        let returnedLots,issuedLots;try{returnedLots=lotList(requestItem.returned_lots||requestItem.lots,'Returned');issuedLots=lotList(requestItem.replacement_lots||requestItem.issued_lots,'Replacement');}catch(e){return res.status(e.status||409).json({error:e.message,control:e.control});}
        if(returnedLots.reduce((s,x)=>s+x.quantity,0)!==qty||issuedLots.reduce((s,x)=>s+x.quantity,0)!==qty)return res.status(409).json({error:`${line.product_name} returned and replacement lot quantities must each total ${qty}.`,control:'replacement_identity_invalid'});
        identity={tracking_mode:'lot',returnedLots,issuedLots};
      }
      const ratio=qty/Number(line.quantity||1),lineSubtotal=money(Number(line.total||0)*ratio),lineTax=money(Number(line.tax_amount||0)*ratio);
      subtotal=money(subtotal+lineSubtotal);tax=money(tax+lineTax);prepared.push({line,product,variation,qty,lineSubtotal,lineTax,identity});
    }

    const total=money(subtotal+tax),returnNumber=await nextNumber(db,'returns','return_number','RET-',6),actorId=req.employee.id;
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[liveSale]}=await tx.execute({sql:'SELECT id,status,branch_id FROM transactions WHERE id=?',args:[sale.id]});
      if(!liveSale||liveSale.status!=='completed'||Number(liveSale.branch_id)!==Number(sale.branch_id))throw conflict('The original sale changed before replacement issue; refresh before trying again');
      const liveMap=await returnedQuantities(tx,sale.id);
      const resolvedIdentity=new Map();
      for(const p of prepared){
        const max=Number(p.line.quantity||0)-Number(liveMap.get(Number(p.line.id))||0);if(p.qty>max)throw conflict(`Another return changed ${p.line.product_name}; only ${Math.max(0,max)} unit(s) remain replaceable`);
        const resolved={returned:[],issued:[]};
        if(p.identity.tracking_mode==='serial'){
          for(const sn of p.identity.returnedSerials){
            const {rows:[s]}=await tx.execute({sql:`SELECT * FROM inventory_serials WHERE lower(serial_number)=lower(?) AND product_id=? AND status='sold'`,args:[sn,p.line.product_id]});
            if(!s)throw conflict(`Returned serial ${sn} is not currently recorded as sold for ${p.line.product_name}`,'replacement_identity_conflict');
            const {rows:[sold]}=await tx.execute({sql:`SELECT id FROM inventory_identity_events WHERE serial_id=? AND event_type='sold' AND reference_type='transaction' AND reference_id=? ORDER BY id DESC LIMIT 1`,args:[s.id,String(sale.id)]});
            if(!sold)throw conflict(`Serial ${sn} was not sold on transaction ${sale.transaction_number}`,'replacement_identity_conflict');
            const {rows:[used]}=await tx.execute({sql:'SELECT id FROM inventory_return_identity_allocations WHERE original_transaction_id=? AND serial_id=? LIMIT 1',args:[sale.id,s.id]});
            if(used)throw conflict(`Serial ${sn} has already been returned against this sale`,'replacement_identity_conflict');
            resolved.returned.push({serial:s,quantity:1});
          }
          for(const sn of p.identity.issuedSerials){
            const {rows:[s]}=await tx.execute({sql:`SELECT * FROM inventory_serials WHERE lower(serial_number)=lower(?) AND product_id=? AND branch_id=? AND status='available' AND (expiry_date IS NULL OR date(expiry_date)>=date('now'))`,args:[sn,p.line.product_id,sale.branch_id]});
            if(!s)throw conflict(`Replacement serial ${sn} is not available at the original sale branch`,'replacement_identity_conflict');
            resolved.issued.push({serial:s,quantity:1});
          }
        }else if(p.identity.tracking_mode==='lot'){
          for(const r of p.identity.returnedLots){
            const {rows:[lot]}=await tx.execute({sql:`SELECT * FROM inventory_lots WHERE product_id=? AND lot_number=? ORDER BY id LIMIT 1`,args:[p.line.product_id,r.lot_number]});
            if(!lot)throw conflict(`Returned lot ${r.lot_number} is not present in traceability history`,'replacement_identity_conflict');
            const {rows:[sold]}=await tx.execute({sql:`SELECT COALESCE(SUM(quantity),0) qty FROM inventory_identity_events WHERE lot_id=? AND event_type='sold' AND reference_type='transaction' AND reference_id=?`,args:[lot.id,String(sale.id)]});
            const {rows:[returned]}=await tx.execute({sql:`SELECT COALESCE(SUM(quantity),0) qty FROM inventory_return_identity_allocations WHERE original_transaction_id=? AND lot_id=?`,args:[sale.id,lot.id]});
            const remaining=Number(sold?.qty||0)-Number(returned?.qty||0);if(remaining<r.quantity)throw conflict(`Lot ${r.lot_number} has only ${remaining} unit(s) remaining returnable from this sale`,'replacement_identity_conflict');
            resolved.returned.push({lot,quantity:r.quantity});
          }
          for(const r of p.identity.issuedLots){
            const {rows:[lot]}=await tx.execute({sql:`SELECT * FROM inventory_lots WHERE product_id=? AND branch_id=? AND lot_number=? AND status='available' AND (expiry_date IS NULL OR date(expiry_date)>=date('now')) ORDER BY id LIMIT 1`,args:[p.line.product_id,sale.branch_id,r.lot_number]});
            if(!lot||Number(lot.available_quantity||0)<r.quantity)throw conflict(`Replacement lot ${r.lot_number} does not have ${r.quantity} available non-expired unit(s) at the original sale branch`,'replacement_identity_conflict');
            resolved.issued.push({lot,quantity:r.quantity});
          }
        }
        resolvedIdentity.set(Number(p.line.id),resolved);
        if(p.variation){const u=await tx.execute({sql:'UPDATE product_variations SET stock_qty=stock_qty-? WHERE id=? AND product_id=? AND stock_qty>=?',args:[p.qty,p.variation.id,p.line.product_id,p.qty]});if(Number(u.rowsAffected||0)!==1)throw conflict(`Replacement variation stock changed for ${p.line.product_name}; refresh and retry`);}
        else {const u=await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty-? WHERE id=? AND stock_qty>=?',args:[p.qty,p.line.product_id,p.qty]});if(Number(u.rowsAffected||0)!==1)throw conflict(`Replacement stock changed for ${p.line.product_name}; refresh and retry`);}
        const bu=await tx.execute({sql:'UPDATE branch_inventory SET stock_qty=stock_qty-?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND branch_id=? AND stock_qty>=?',args:[p.qty,p.line.product_id,sale.branch_id,p.qty]});if(Number(bu.rowsAffected||0)!==1)throw conflict(`Branch stock changed for ${p.line.product_name}; refresh and retry`);
        for(const a of resolved.issued){
          if(a.serial){const u=await tx.execute({sql:`UPDATE inventory_serials SET status='sold',updated_at=CURRENT_TIMESTAMP WHERE id=? AND branch_id=? AND status='available'`,args:[a.serial.id,sale.branch_id]});if(Number(u.rowsAffected||0)!==1)throw conflict(`Replacement serial ${a.serial.serial_number} changed before issue`,'replacement_identity_conflict');}
          else if(a.lot){const u=await tx.execute({sql:`UPDATE inventory_lots SET available_quantity=available_quantity-? WHERE id=? AND branch_id=? AND status='available' AND available_quantity>=?`,args:[a.quantity,a.lot.id,sale.branch_id,a.quantity]});if(Number(u.rowsAffected||0)!==1)throw conflict(`Replacement lot ${a.lot.lot_number} changed before issue`,'replacement_identity_conflict');}
        }
        for(const a of resolved.returned)if(a.serial){const u=await tx.execute({sql:`UPDATE inventory_serials SET status='replacement_quarantine',branch_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='sold'`,args:[sale.branch_id,a.serial.id]});if(Number(u.rowsAffected||0)!==1)throw conflict(`Returned serial ${a.serial.serial_number} changed before quarantine`,'replacement_identity_conflict');}
      }

      const rr=await tx.execute({sql:`INSERT INTO returns(return_number,original_transaction_id,customer_id,employee_id,branch_id,resolution,subtotal,tax_amount,total,notes) VALUES(?,?,?,?,?,'replacement',?,?,?,?)`,args:[returnNumber,sale.id,sale.customer_id||null,actorId,sale.branch_id,subtotal,tax,total,req.body?.notes||null]});
      const returnId=Number(rr.lastInsertRowid);
      for(const p of prepared){
        const ri=await tx.execute({sql:`INSERT INTO return_items(return_id,transaction_item_id,product_id,product_name,sku,quantity,unit_price,tax_amount,total,unit_cost_at_return) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[returnId,p.line.id,p.line.product_id,p.line.product_name,p.line.sku,p.qty,p.line.unit_price,p.lineTax,p.lineSubtotal,p.line.unit_cost_at_sale??null]});
        const returnItemId=Number(ri.lastInsertRowid),resolved=resolvedIdentity.get(Number(p.line.id));
        await tx.execute({sql:`INSERT INTO return_quarantine(return_id,return_item_id,product_id,branch_id,quantity,unit_cost_at_return,disposition_status,disposition_notes) VALUES(?,?,?,?,?,?,'quarantine',?)`,args:[returnId,returnItemId,p.line.product_id,sale.branch_id,p.qty,p.line.unit_cost_at_sale??null,p.identity.tracking_mode==='none'?'Returned unit withheld from sellable inventory pending inspection/disposition':`Returned ${p.identity.tracking_mode}-controlled identity withheld from sellable inventory pending inspection/disposition`]});
        if(p.identity.tracking_mode!=='none'){
          for(const a of resolved.returned){
            await tx.execute({sql:`INSERT INTO inventory_return_identity_allocations(return_id,original_transaction_id,product_id,branch_id,serial_id,lot_id,quantity) VALUES(?,?,?,?,?,?,?)`,args:[returnId,sale.id,p.line.product_id,sale.branch_id,a.serial?.id||null,a.lot?.id||null,a.quantity]});
            await tx.execute({sql:`INSERT INTO replacement_identity_movements(return_id,return_item_id,original_transaction_id,transaction_item_id,product_id,branch_id,tracking_mode,direction,serial_id,lot_id,quantity,employee_id) VALUES(?,?,?,?,?,?,?,'returned',?,?,?,?)`,args:[returnId,returnItemId,sale.id,p.line.id,p.line.product_id,sale.branch_id,p.identity.tracking_mode,a.serial?.id||null,a.lot?.id||null,a.quantity,actorId]});
            await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,?, 'return',?,?,?)`,args:[p.line.product_id,sale.branch_id,a.lot?.id||null,a.serial?.id||null,'replacement_returned',a.quantity,String(returnId),actorId,'Identity returned and quarantined during like-for-like replacement']});
          }
          for(const a of resolved.issued){
            await tx.execute({sql:`INSERT INTO replacement_identity_movements(return_id,return_item_id,original_transaction_id,transaction_item_id,product_id,branch_id,tracking_mode,direction,serial_id,lot_id,quantity,employee_id) VALUES(?,?,?,?,?,?,?,'issued',?,?,?,?)`,args:[returnId,returnItemId,sale.id,p.line.id,p.line.product_id,sale.branch_id,p.identity.tracking_mode,a.serial?.id||null,a.lot?.id||null,a.quantity,actorId]});
            await tx.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,lot_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,?,?,?, 'return',?,?,?)`,args:[p.line.product_id,sale.branch_id,a.lot?.id||null,a.serial?.id||null,'replacement_issued',a.quantity,String(returnId),actorId,'Identity issued to customer during like-for-like replacement']});
          }
        }
        await syncBinQty(tx,p.line.product_id,sale.branch_id,-p.qty);
        await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,'replacement_issue',?,?)`,args:[p.line.product_id,sale.branch_id,-p.qty,returnNumber,`Like-for-like replacement issued for transaction ${sale.transaction_number}`]});
        const issuedCost=p.identity.tracking_mode==='serial'&&resolved.issued.length?money(resolved.issued.reduce((s,a)=>s+Number(a.serial?.unit_cost??p.product.cost??0),0)/resolved.issued.length):p.identity.tracking_mode==='lot'&&resolved.issued.length?money(resolved.issued.reduce((s,a)=>s+Number(a.lot?.unit_cost??p.product.cost??0)*a.quantity,0)/p.qty):Number(p.product.cost||0);
        await tx.execute({sql:`INSERT INTO replacement_fulfillments(return_id,return_item_id,original_transaction_id,transaction_item_id,product_id,variation_id,branch_id,quantity,unit_cost_at_issue,issued_by_employee_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,args:[returnId,returnItemId,sale.id,p.line.id,p.line.product_id,p.variation?.id||null,sale.branch_id,p.qty,issuedCost,actorId]});
        await tx.execute({sql:`INSERT INTO replacement_financial_evidence(return_id,return_item_id,product_id,branch_id,quantity,returned_unit_cost,issued_unit_cost,inventory_value_out,accounting_state) VALUES(?,?,?,?,?,?,?,?, 'evidence_recorded')`,args:[returnId,returnItemId,p.line.product_id,sale.branch_id,p.qty,p.line.unit_cost_at_sale??null,issuedCost,money(issuedCost*p.qty)]});
      }
      await tx.commit();committed=true;
      const {rows:[ret]}=await db.execute({sql:'SELECT * FROM returns WHERE id=?',args:[returnId]});
      const {rows:retItems}=await db.execute({sql:'SELECT * FROM return_items WHERE return_id=? ORDER BY id',args:[returnId]});
      const {rows:fulfillments}=await db.execute({sql:'SELECT * FROM replacement_fulfillments WHERE return_id=? ORDER BY id',args:[returnId]});
      const {rows:quarantine}=await db.execute({sql:'SELECT * FROM return_quarantine WHERE return_id=? ORDER BY id',args:[returnId]});
      const {rows:identity}=await db.execute({sql:'SELECT * FROM replacement_identity_movements WHERE return_id=? ORDER BY id',args:[returnId]});
      const {rows:financial}=await db.execute({sql:'SELECT * FROM replacement_financial_evidence WHERE return_id=? ORDER BY id',args:[returnId]});
      res.status(201).json({...ret,items:retItems,replacement_fulfillments:fulfillments,quarantine,identity_movements:identity,financial_evidence:financial});
    }catch(e){if(!committed)await tx.rollback();res.status(e.status||500).json({error:e.message,control:e.control||(e.status===409?'replacement_concurrency':undefined)});}
  }catch(e){res.status(e.status||500).json({error:e.message,control:e.control});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
