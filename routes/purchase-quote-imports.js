'use strict';
const express=require('express');
const crypto=require('crypto');
const router=express.Router();
const {db}=require('../database');
const {requirePermission,can}=require('../lib/permissions');

let readyPromise=null;
function ensureSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=db.batch([
    {sql:`CREATE TABLE IF NOT EXISTS purchase_quote_imports(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER REFERENCES suppliers(id),
      source_name TEXT,
      source_type TEXT,
      source_sha256 TEXT,
      extracted_text TEXT,
      status TEXT NOT NULL DEFAULT 'staged',
      created_by_employee_id INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      converted_po_id INTEGER REFERENCES purchase_orders(id)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS purchase_quote_import_lines(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES purchase_quote_imports(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      supplier_part_number TEXT,
      description TEXT NOT NULL,
      entered_quantity REAL NOT NULL DEFAULT 1,
      entered_uom TEXT,
      entered_unit_price REAL NOT NULL DEFAULT 0,
      product_id INTEGER REFERENCES products(id),
      match_status TEXT NOT NULL DEFAULT 'unmatched',
      match_confidence REAL,
      match_basis TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(import_id,line_no)
    )`},
    {sql:`CREATE TABLE IF NOT EXISTS supplier_product_aliases(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      supplier_part_number TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      confirmed_by_employee_id INTEGER REFERENCES employees(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(supplier_id,supplier_part_number)
    )`},
    {sql:'CREATE INDEX IF NOT EXISTS idx_purchase_quote_import_lines_import ON purchase_quote_import_lines(import_id,line_no)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_supplier_product_alias_lookup ON supplier_product_aliases(supplier_id,supplier_part_number)'}
  ],'write').catch(e=>{readyPromise=null;throw e});
  return readyPromise;
}
function norm(v){return String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
function sha(v){return crypto.createHash('sha256').update(String(v||'')).digest('hex')}
function money(v){const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(2)):0}
function parseText(text){
  const rows=[];for(const raw of String(text||'').split(/\r?\n/)){const line=raw.trim();if(!line)continue;
    const m=line.match(/^([A-Za-z0-9._\/-]{2,})\s+(.+?)\s+(\d+(?:\.\d+)?)\s+([A-Za-z]{1,8})?\s*[$]?([\d,]+(?:\.\d{1,2})?)$/);
    if(m)rows.push({supplier_part_number:m[1],description:m[2].trim(),entered_quantity:Number(m[3]),entered_uom:m[4]||null,entered_unit_price:money(m[5].replace(/,/g,''))});
  }return rows;
}
async function matchLine(line,supplierId){
  const part=String(line.supplier_part_number||'').trim();if(part&&supplierId){const {rows:[alias]}=await db.execute({sql:'SELECT product_id FROM supplier_product_aliases WHERE supplier_id=? AND lower(supplier_part_number)=lower(?)',args:[supplierId,part]});if(alias)return{product_id:alias.product_id,match_status:'matched',match_confidence:1,match_basis:'supplier_alias'};}
  if(part){const {rows:[sku]}=await db.execute({sql:'SELECT id FROM products WHERE active=1 AND lower(sku)=lower(?) LIMIT 1',args:[part]});if(sku)return{product_id:sku.id,match_status:'matched',match_confidence:1,match_basis:'sku_exact'};}
  const desc=norm(line.description);if(desc){const {rows:products}=await db.execute({sql:'SELECT id,name,sku FROM products WHERE active=1 LIMIT 1000',args:[]});const exact=products.find(p=>norm(p.name)===desc);if(exact)return{product_id:exact.id,match_status:'matched',match_confidence:.98,match_basis:'description_exact'};const tokens=new Set(desc.split(' ').filter(x=>x.length>2));let best=null,bestScore=0;for(const p of products){const pt=new Set(norm(`${p.name} ${p.sku||''}`).split(' ').filter(x=>x.length>2));const common=[...tokens].filter(x=>pt.has(x)).length;const score=tokens.size?common/tokens.size:0;if(score>bestScore){best=p;bestScore=score}}if(best&&bestScore>=.6)return{product_id:best.id,match_status:'possible_match',match_confidence:Number(bestScore.toFixed(3)),match_basis:'description_similarity'};}
  return{product_id:null,match_status:'unmatched',match_confidence:0,match_basis:null};
}
async function hydrate(id){const {rows:[doc]}=await db.execute({sql:`SELECT q.*,s.name supplier_name,po.po_number converted_po_number FROM purchase_quote_imports q LEFT JOIN suppliers s ON s.id=q.supplier_id LEFT JOIN purchase_orders po ON po.id=q.converted_po_id WHERE q.id=?`,args:[id]});if(!doc)return null;const {rows:lines}=await db.execute({sql:`SELECT l.*,p.name product_name,p.sku product_sku FROM purchase_quote_import_lines l LEFT JOIN products p ON p.id=l.product_id WHERE l.import_id=? ORDER BY l.line_no,l.id`,args:[id]});return{...doc,lines};}
router.use(async(req,res,next)=>{try{await ensureSchema();next()}catch(e){res.status(500).json({error:'Quote import initialization failed',detail:e.message})}});
router.use(requirePermission('purchasing'));
router.get('/',async(req,res)=>{try{const {rows}=await db.execute({sql:`SELECT q.*,s.name supplier_name,(SELECT COUNT(*) FROM purchase_quote_import_lines l WHERE l.import_id=q.id) line_count,(SELECT COUNT(*) FROM purchase_quote_import_lines l WHERE l.import_id=q.id AND l.match_status='unmatched') unmatched_count FROM purchase_quote_imports q LEFT JOIN suppliers s ON s.id=q.supplier_id ORDER BY q.id DESC LIMIT 200`,args:[]});res.json(rows)}catch(e){res.status(500).json({error:e.message})}});
router.get('/:id',async(req,res)=>{try{const doc=await hydrate(Number(req.params.id));if(!doc)return res.status(404).json({error:'Quote import not found'});res.json(doc)}catch(e){res.status(500).json({error:e.message})}});
router.post('/',requirePermission('purchasing_create'),async(req,res)=>{try{const b=req.body||{},supplierId=b.supplier_id?Number(b.supplier_id):null,text=String(b.extracted_text||'');let lines=Array.isArray(b.lines)?b.lines:parseText(text);if(!lines.length)return res.status(400).json({error:'No quote line items were supplied or recognized. Add extracted text or editable line items.'});const tx=await db.transaction('write');let committed=false;try{const ins=await tx.execute({sql:`INSERT INTO purchase_quote_imports(supplier_id,source_name,source_type,source_sha256,extracted_text,status,created_by_employee_id) VALUES(?,?,?,?,?,'staged',?)`,args:[supplierId,String(b.source_name||'Supplier quote'),String(b.source_type||'text'),sha(text||JSON.stringify(lines)),text,req.employee?.id||null]});const id=Number(ins.lastInsertRowid);let n=0;for(const raw of lines){n++;const line={supplier_part_number:String(raw.supplier_part_number||raw.part_number||'').trim()||null,description:String(raw.description||raw.item_description||'').trim(),entered_quantity:Number(raw.entered_quantity??raw.quantity??1),entered_uom:String(raw.entered_uom||raw.uom||'').trim()||null,entered_unit_price:money(raw.entered_unit_price??raw.unit_price??raw.price??0)};if(!line.description||!Number.isFinite(line.entered_quantity)||line.entered_quantity<=0||line.entered_unit_price<0)throw new Error(`Invalid quote line ${n}`);const m=await matchLine(line,supplierId);await tx.execute({sql:`INSERT INTO purchase_quote_import_lines(import_id,line_no,supplier_part_number,description,entered_quantity,entered_uom,entered_unit_price,product_id,match_status,match_confidence,match_basis) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[id,n,line.supplier_part_number,line.description,line.entered_quantity,line.entered_uom,line.entered_unit_price,m.product_id,m.match_status,m.match_confidence,m.match_basis]});}await tx.commit();committed=true;res.status(201).json(await hydrate(id))}catch(e){if(!committed)await tx.rollback();throw e}}catch(e){res.status(400).json({error:e.message})}});
router.patch('/:id/lines/:lineId',requirePermission('purchasing_create'),async(req,res)=>{try{const id=Number(req.params.id),lineId=Number(req.params.lineId),b=req.body||{};const {rows:[line]}=await db.execute({sql:'SELECT * FROM purchase_quote_import_lines WHERE id=? AND import_id=?',args:[lineId,id]});if(!line)return res.status(404).json({error:'Quote line not found'});const next={supplier_part_number:b.supplier_part_number!==undefined?String(b.supplier_part_number||'').trim()||null:line.supplier_part_number,description:b.description!==undefined?String(b.description||'').trim():line.description,entered_quantity:b.entered_quantity!==undefined?Number(b.entered_quantity):Number(line.entered_quantity),entered_uom:b.entered_uom!==undefined?String(b.entered_uom||'').trim()||null:line.entered_uom,entered_unit_price:b.entered_unit_price!==undefined?money(b.entered_unit_price):Number(line.entered_unit_price),product_id:b.product_id!==undefined?(b.product_id?Number(b.product_id):null):line.product_id};if(!next.description||!Number.isFinite(next.entered_quantity)||next.entered_quantity<=0||next.entered_unit_price<0)return res.status(400).json({error:'Description, positive quantity and non-negative unit price are required'});let status=next.product_id?'matched':'unmatched',basis=next.product_id?'manual':null,confidence=next.product_id?1:0;if(!next.product_id){const doc=await hydrate(id);const m=await matchLine(next,doc?.supplier_id||null);Object.assign(next,{product_id:m.product_id});status=m.match_status;basis=m.match_basis;confidence=m.match_confidence}await db.execute({sql:`UPDATE purchase_quote_import_lines SET supplier_part_number=?,description=?,entered_quantity=?,entered_uom=?,entered_unit_price=?,product_id=?,match_status=?,match_confidence=?,match_basis=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND import_id=?`,args:[next.supplier_part_number,next.description,next.entered_quantity,next.entered_uom,next.entered_unit_price,next.product_id,status,confidence,basis,lineId,id]});res.json(await hydrate(id))}catch(e){res.status(500).json({error:e.message})}});
router.post('/:id/lines/:lineId/confirm-match',requirePermission('purchasing_create'),async(req,res)=>{try{const id=Number(req.params.id),lineId=Number(req.params.lineId),productId=Number(req.body?.product_id);const doc=await hydrate(id),line=doc?.lines?.find(x=>Number(x.id)===lineId);if(!doc||!line)return res.status(404).json({error:'Quote line not found'});const {rows:[p]}=await db.execute({sql:'SELECT id FROM products WHERE id=? AND active=1',args:[productId]});if(!p)return res.status(404).json({error:'Inventory item not found'});await db.execute({sql:`UPDATE purchase_quote_import_lines SET product_id=?,match_status='matched',match_confidence=1,match_basis='manual',updated_at=CURRENT_TIMESTAMP WHERE id=?`,args:[productId,lineId]});if(doc.supplier_id&&line.supplier_part_number)await db.execute({sql:`INSERT INTO supplier_product_aliases(supplier_id,supplier_part_number,product_id,confirmed_by_employee_id) VALUES(?,?,?,?) ON CONFLICT(supplier_id,supplier_part_number) DO UPDATE SET product_id=excluded.product_id,confirmed_by_employee_id=excluded.confirmed_by_employee_id`,args:[doc.supplier_id,line.supplier_part_number,productId,req.employee?.id||null]});res.json(await hydrate(id))}catch(e){res.status(500).json({error:e.message})}});
router.post('/:id/lines',requirePermission('purchasing_create'),async(req,res)=>{try{const id=Number(req.params.id),b=req.body||{};const {rows:[r]}=await db.execute({sql:'SELECT COALESCE(MAX(line_no),0)+1 n FROM purchase_quote_import_lines WHERE import_id=?',args:[id]});await db.execute({sql:`INSERT INTO purchase_quote_import_lines(import_id,line_no,supplier_part_number,description,entered_quantity,entered_uom,entered_unit_price,match_status) VALUES(?,?,?,?,?,?,?,'unmatched')`,args:[id,Number(r.n),String(b.supplier_part_number||'').trim()||null,String(b.description||'New item').trim(),Number(b.entered_quantity||1),String(b.entered_uom||'').trim()||null,money(b.entered_unit_price||0)]});res.status(201).json(await hydrate(id))}catch(e){res.status(400).json({error:e.message})}});
router.delete('/:id/lines/:lineId',requirePermission('purchasing_create'),async(req,res)=>{try{await db.execute({sql:'DELETE FROM purchase_quote_import_lines WHERE id=? AND import_id=?',args:[Number(req.params.lineId),Number(req.params.id)]});res.json(await hydrate(Number(req.params.id)))}catch(e){res.status(500).json({error:e.message})}});
router.get('/:id/po-template',async(req,res)=>{try{const doc=await hydrate(Number(req.params.id));if(!doc)return res.status(404).json({error:'Quote import not found'});const unresolved=doc.lines.filter(x=>!x.product_id);if(unresolved.length)return res.status(409).json({error:`${unresolved.length} quote line(s) still need an inventory match or inventory item creation`});res.json({source_quote_import_id:doc.id,supplier_id:doc.supplier_id,items:doc.lines.map(x=>({product_id:x.product_id,quantity_ordered:Number(x.entered_quantity),unit_cost:Number(x.entered_unit_price),uom_code:x.entered_uom||undefined,supplier_part_number:x.supplier_part_number||undefined,source_description:x.description}))})}catch(e){res.status(500).json({error:e.message})}});
module.exports=router;
module.exports.ensureSchema=ensureSchema;
