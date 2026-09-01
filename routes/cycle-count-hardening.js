'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');
const {syncBinQty}=require('../lib/binSync');
const {valueStockAdjustment,ensureInventoryMovementValuation}=require('../lib/inventory-movement-valuation');

let readyPromise=null;
async function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS cycle_count_controls(
        session_id INTEGER PRIMARY KEY REFERENCES cycle_count_sessions(id),
        created_by_employee_id INTEGER REFERENCES employees(id),
        approved_by_employee_id INTEGER REFERENCES employees(id),
        approved_at DATETIME,
        snapshot_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        blind_count INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        completed_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS cycle_count_item_controls(
        item_id INTEGER PRIMARY KEY REFERENCES cycle_count_items(id),
        session_id INTEGER NOT NULL REFERENCES cycle_count_sessions(id),
        book_qty_at_count INTEGER,
        first_count_qty INTEGER,
        latest_count_qty INTEGER,
        counted_by_employee_id INTEGER REFERENCES employees(id),
        counted_at DATETIME,
        recount_count INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS cycle_count_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES cycle_count_sessions(id),
        item_id INTEGER REFERENCES cycle_count_items(id),
        event_type TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        quantity INTEGER,
        book_quantity INTEGER,
        variance INTEGER,
        details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_cycle_count_events_session ON cycle_count_events(session_id,created_at,id)'},
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_cycle_count_control_create
        AFTER INSERT ON cycle_count_sessions
        BEGIN
          INSERT OR IGNORE INTO cycle_count_controls(session_id,created_by_employee_id)
          VALUES(NEW.id,NEW.employee_id);
        END`},
      {sql:`CREATE TRIGGER IF NOT EXISTS trg_cycle_count_item_control_create
        AFTER INSERT ON cycle_count_items
        BEGIN
          INSERT OR IGNORE INTO cycle_count_item_controls(item_id,session_id)
          VALUES(NEW.id,NEW.session_id);
        END`}
    ],'write');
    await db.execute({sql:`INSERT OR IGNORE INTO cycle_count_controls(session_id,created_by_employee_id,snapshot_at)
      SELECT id,employee_id,created_at FROM cycle_count_sessions`,args:[]});
    await db.execute({sql:`INSERT OR IGNORE INTO cycle_count_item_controls(item_id,session_id,book_qty_at_count,first_count_qty,latest_count_qty,counted_at)
      SELECT id,session_id,CASE WHEN counted_qty IS NULL THEN NULL ELSE expected_qty END,counted_qty,counted_qty,CASE WHEN counted_qty IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END
      FROM cycle_count_items`,args:[]});
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
router.use(async(req,res,next)=>{try{await ensureSchema();next();}catch(e){res.status(500).json({error:'Cycle count integrity initialization failed',detail:e.message});}});

function actor(req){return req.employee?.id||null;}
function explicitApproval(req){
  if(req.apiKey)return true;
  return !!req.employee&&can(req.employee.permissions,'cyclecounts_approve');
}
async function settingBool(key,defaultValue=false){
  const {rows:[row]}=await db.execute({sql:'SELECT value FROM settings WHERE key=?',args:[key]});
  if(!row)return defaultValue;
  return ['1','true','yes','on'].includes(String(row.value||'').trim().toLowerCase());
}
async function liveBookQty(executor,session,item){
  if(item.bin_id){
    const {rows:[a]}=await executor.execute({sql:'SELECT quantity FROM product_bin_assignments WHERE product_id=? AND bin_id=?',args:[item.product_id,item.bin_id]});
    return Number(a?.quantity||0);
  }
  if(session.branch_id){
    const {rows:[b]}=await executor.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[item.product_id,session.branch_id]});
    return Number(b?.stock_qty||0);
  }
  const {rows:[p]}=await executor.execute({sql:'SELECT stock_qty FROM products WHERE id=?',args:[item.product_id]});
  return Number(p?.stock_qty||0);
}

// Creation is still performed by the established warehouse route, but the
// request is normalized and constrained here before legacy code can persist it.
router.post('/cycle-counts',requirePermission('cyclecounts_create'),async(req,res,next)=>{
  try{
    const branchId=Number(req.body?.branch_id);
    const scope=String(req.body?.scope_type||'all');
    const allowed=new Set(['all','category','bin']);
    if(!branchId)return res.status(400).json({error:'A branch is required for a cycle count'});
    if(!allowed.has(scope))return res.status(400).json({error:'Invalid cycle-count scope'});
    const {rows:[branch]}=await db.execute({sql:'SELECT id FROM branches WHERE id=? AND active=1',args:[branchId]});
    if(!branch)return res.status(400).json({error:'Selected branch is unavailable'});
    if(scope!=='all'&&!Number(req.body?.scope_id))return res.status(400).json({error:`${scope} scope requires a scope_id`});
    if(scope==='bin'){
      const {rows:[bin]}=await db.execute({sql:`SELECT sb.id,COALESCE(sb.branch_id,z.branch_id) branch_id FROM storage_bins sb LEFT JOIN warehouse_zones z ON z.id=sb.zone_id WHERE sb.id=?`,args:[Number(req.body.scope_id)]});
      if(!bin||String(bin.branch_id)!==String(branchId))return res.status(400).json({error:'Selected bin does not belong to the cycle-count branch'});
    }
    const {rows:[open]}=await db.execute({sql:`SELECT id,session_number FROM cycle_count_sessions WHERE branch_id=? AND status!='committed' AND scope_type=? AND COALESCE(scope_id,0)=COALESCE(?,0) ORDER BY id DESC LIMIT 1`,args:[branchId,scope,req.body?.scope_id||null]});
    if(open)return res.status(409).json({error:`An active count (${open.session_number}) already covers this branch and scope`});
    req.body.employee_id=actor(req);
    req.body.branch_id=branchId;
    next();
  }catch(e){res.status(500).json({error:e.message});}
});

// Counters use a blind count by default. Supervisors with approval authority can
// see frozen/book quantities and variance during review.
router.get('/cycle-counts/:id',requirePermission('cycle-counts'),async(req,res)=>{
  try{
    const {rows:[session]}=await db.execute({sql:`SELECT cc.*,b.name branch_name,e.first_name||' '||e.last_name employee_name,ctl.blind_count,ctl.created_by_employee_id,ctl.approved_by_employee_id,ctl.approved_at
      FROM cycle_count_sessions cc LEFT JOIN branches b ON b.id=cc.branch_id LEFT JOIN employees e ON e.id=cc.employee_id LEFT JOIN cycle_count_controls ctl ON ctl.session_id=cc.id WHERE cc.id=?`,args:[req.params.id]});
    if(!session)return res.status(404).json({error:'Not found'});
    const {rows:items}=await db.execute({sql:`SELECT ci.*,c.name category_name,cic.book_qty_at_count,cic.first_count_qty,cic.latest_count_qty,cic.counted_by_employee_id,cic.counted_at,cic.recount_count
      FROM cycle_count_items ci LEFT JOIN products p ON p.id=ci.product_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN cycle_count_item_controls cic ON cic.item_id=ci.id WHERE ci.session_id=? ORDER BY ci.bin_code,ci.product_name`,args:[req.params.id]});
    const reveal=explicitApproval(req)||!Number(session.blind_count)||session.status==='committed';
    session.items=items.map(i=>reveal?i:{...i,expected_qty:null,book_qty_at_count:null,variance:null});
    res.json(session);
  }catch(e){res.status(500).json({error:e.message});}
});

router.get('/cycle-counts/:id/export',requirePermission('cycle-counts'),async(req,res)=>{
  try{
    const {rows:[session]}=await db.execute({sql:'SELECT cc.*,ctl.blind_count FROM cycle_count_sessions cc LEFT JOIN cycle_count_controls ctl ON ctl.session_id=cc.id WHERE cc.id=?',args:[req.params.id]});
    if(!session)return res.status(404).json({error:'Not found'});
    const {rows:items}=await db.execute({sql:`SELECT ci.*,c.name category_name FROM cycle_count_items ci LEFT JOIN products p ON p.id=ci.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE ci.session_id=? ORDER BY ci.bin_code,ci.product_name`,args:[req.params.id]});
    const reveal=explicitApproval(req)||!Number(session.blind_count)||session.status==='committed';
    const headers=reveal?['Item ID','SKU','Product Name','Category','Bin Code','Book Qty','Counted Qty']:['Item ID','SKU','Product Name','Category','Bin Code','Counted Qty'];
    const rows=[headers];
    for(const i of items)rows.push(reveal?[i.id,i.sku,i.product_name,i.category_name||'',i.bin_code||'',i.expected_qty,i.counted_qty??'']:[i.id,i.sku,i.product_name,i.category_name||'',i.bin_code||'',i.counted_qty??'']);
    const csv=rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
    res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition',`attachment; filename="${session.session_number}-cycle-count.csv"`);res.send(csv);
  }catch(e){res.status(500).json({error:e.message});}
});

// Count entry captures the live book quantity at the moment the employee counts
// the item. This preserves movements that occur after session creation and lets
// the eventual posting apply only the true count discrepancy.
router.post('/cycle-counts/:id/import',requirePermission('cyclecounts_create'),async(req,res)=>{
  try{
    const {rows:[session]}=await db.execute({sql:'SELECT * FROM cycle_count_sessions WHERE id=?',args:[req.params.id]});
    if(!session)return res.status(404).json({error:'Not found'});
    if(session.status==='committed')return res.status(409).json({error:'Committed cycle counts are immutable'});
    const entries=Array.isArray(req.body?.items)?req.body.items:[];
    if(!entries.length)return res.status(400).json({error:'No count entries provided'});
    const tx=await db.transaction('write');let committed=false;
    try{
      for(const entry of entries){
        const itemId=Number(entry.item_id),counted=Number(entry.counted_qty);
        if(!itemId||!Number.isInteger(counted)||counted<0)throw new Error('Every count entry requires a valid item_id and a non-negative whole-number quantity');
        const {rows:[item]}=await tx.execute({sql:'SELECT * FROM cycle_count_items WHERE id=? AND session_id=?',args:[itemId,session.id]});
        if(!item)throw new Error(`Cycle-count item ${itemId} does not belong to this session`);
        const book=await liveBookQty(tx,session,item);const variance=counted-book;
        const {rows:[ctl]}=await tx.execute({sql:'SELECT * FROM cycle_count_item_controls WHERE item_id=?',args:[itemId]});
        const eventType=ctl?.latest_count_qty==null?'count':'recount';
        await tx.execute({sql:`UPDATE cycle_count_items SET expected_qty=?,counted_qty=?,variance=? WHERE id=?`,args:[book,counted,variance,itemId]});
        await tx.execute({sql:`UPDATE cycle_count_item_controls SET book_qty_at_count=?,first_count_qty=COALESCE(first_count_qty,?),latest_count_qty=?,counted_by_employee_id=?,counted_at=CURRENT_TIMESTAMP,recount_count=recount_count+?,updated_at=CURRENT_TIMESTAMP WHERE item_id=?`,args:[book,counted,counted,actor(req),eventType==='recount'?1:0,itemId]});
        await tx.execute({sql:`INSERT INTO cycle_count_events(session_id,item_id,event_type,employee_id,quantity,book_quantity,variance,details) VALUES(?,?,?,?,?,?,?,?)`,args:[session.id,itemId,eventType,actor(req),counted,book,variance,eventType==='recount'?'Count value replaced; prior event remains auditable':'Initial blind count captured against live book quantity']});
      }
      const {rows:[progress]}=await tx.execute({sql:`SELECT COUNT(*) total,SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END) counted FROM cycle_count_items WHERE session_id=?`,args:[session.id]});
      const complete=Number(progress?.total||0)>0&&Number(progress?.total||0)===Number(progress?.counted||0);
      await tx.execute({sql:`UPDATE cycle_count_sessions SET status=? WHERE id=? AND status!='committed'`,args:[complete?'review':'open',session.id]});
      if(complete)await tx.execute({sql:'UPDATE cycle_count_controls SET completed_at=CURRENT_TIMESTAMP,version=version+1 WHERE session_id=?',args:[session.id]});
      await tx.commit();committed=true;
    }catch(e){if(!committed)await tx.rollback();return res.status(400).json({error:e.message});}
    const {rows:[updated]}=await db.execute({sql:'SELECT * FROM cycle_count_sessions WHERE id=?',args:[session.id]});
    const {rows:items}=await db.execute({sql:'SELECT * FROM cycle_count_items WHERE session_id=? ORDER BY bin_code,product_name',args:[session.id]});
    updated.items=items;res.json(updated);
  }catch(e){res.status(500).json({error:e.message});}
});

// Approval/posting is deliberately separated from counting. All quantity,
// movement evidence and valuation updates commit atomically.
router.patch('/cycle-counts/:id/commit',requirePermission('cyclecounts_approve'),async(req,res)=>{
  try{
    const tx=await db.transaction('write');let committed=false;
    try{
      const {rows:[session]}=await tx.execute({sql:'SELECT * FROM cycle_count_sessions WHERE id=?',args:[req.params.id]});
      if(!session)throw Object.assign(new Error('Not found'),{status:404});
      if(session.status==='committed')throw Object.assign(new Error('Already committed'),{status:409});
      const {rows:[ctl]}=await tx.execute({sql:'SELECT * FROM cycle_count_controls WHERE session_id=?',args:[session.id]});
      const {rows:[progress]}=await tx.execute({sql:`SELECT COUNT(*) total,SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END) counted FROM cycle_count_items WHERE session_id=?`,args:[session.id]});
      if(!Number(progress?.total)||Number(progress.total)!==Number(progress.counted||0))throw Object.assign(new Error('Every item must be counted before approval'),{status:409});
      const allowSelf=await settingBool('cycle_count_allow_self_approval',false);
      if(!allowSelf&&ctl?.created_by_employee_id&&String(ctl.created_by_employee_id)===String(actor(req)))throw Object.assign(new Error('Independent approval is required: the employee who created this count cannot approve its inventory differences'),{status:403});
      const {rows:items}=await tx.execute({sql:'SELECT * FROM cycle_count_items WHERE session_id=? AND counted_qty IS NOT NULL AND variance!=0 ORDER BY id',args:[session.id]});
      for(const item of items){
        if(!item.product_id)continue;
        const live=await liveBookQty(tx,session,item);const after=live+Number(item.variance||0);
        if(after<0)throw Object.assign(new Error(`Posting ${item.sku||item.product_name} would make inventory negative; investigate intervening movements before approval`),{status:409});
        if(item.bin_id){
          const {rows:[a]}=await tx.execute({sql:'SELECT * FROM product_bin_assignments WHERE product_id=? AND bin_id=?',args:[item.product_id,item.bin_id]});
          if(!a)throw Object.assign(new Error(`Bin assignment missing for ${item.sku||item.product_name}; count cannot be posted safely`),{status:409});
          await tx.execute({sql:'UPDATE product_bin_assignments SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE id=?',args:[item.variance,a.id]});
        }
        if(session.branch_id){
          await tx.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,(SELECT min_stock FROM products WHERE id=?),CURRENT_TIMESTAMP)
            ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=stock_qty+excluded.stock_qty,updated_at=CURRENT_TIMESTAMP`,args:[item.product_id,session.branch_id,item.variance,item.product_id]});
          if(!item.bin_id)await syncBinQty(tx,item.product_id,session.branch_id,item.variance);
        }
        await tx.execute({sql:'UPDATE products SET stock_qty=stock_qty+? WHERE id=?',args:[item.variance,item.product_id]});
        const sm=await tx.execute({sql:`INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reference,reason) VALUES(?,?,?,?,?,?)`,args:[item.product_id,session.branch_id||null,item.variance,'cycle_count',session.session_number,`Approved cycle-count variance: book ${item.expected_qty}, counted ${item.counted_qty}`]});
        await valueStockAdjustment(tx,{stockMovementId:Number(sm.lastInsertRowid),productId:item.product_id,branchKey:Number(session.branch_id||0),quantityChange:item.variance,reason:`Cycle count ${session.session_number}`,physicalBefore:live});
      }
      await tx.execute({sql:`INSERT INTO cycle_count_events(session_id,event_type,employee_id,details) VALUES(?,?,?,?)`,args:[session.id,'approved',actor(req),`Approved ${items.length} variance line(s)`]});
      const changed=await tx.execute({sql:`UPDATE cycle_count_sessions SET status='committed',committed_at=CURRENT_TIMESTAMP WHERE id=? AND status!='committed'`,args:[session.id]});
      if(Number(changed.rowsAffected||0)!==1)throw Object.assign(new Error('Cycle count changed concurrently; reload before approving'),{status:409});
      await tx.execute({sql:'UPDATE cycle_count_controls SET approved_by_employee_id=?,approved_at=CURRENT_TIMESTAMP,version=version+1 WHERE session_id=?',args:[actor(req),session.id]});
      await tx.commit();committed=true;
      const {rows:[updated]}=await db.execute({sql:'SELECT * FROM cycle_count_sessions WHERE id=?',args:[session.id]});res.json(updated);
    }catch(e){if(!committed)await tx.rollback();res.status(e.status||400).json({error:e.message});}
  }catch(e){res.status(500).json({error:e.message});}
});

module.exports=router;
module.exports.ensureSchema=ensureSchema;
