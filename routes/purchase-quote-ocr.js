'use strict';
const express=require('express');
const multer=require('multer');
const path=require('path');
const crypto=require('crypto');
const {createWorker,OEM}=require('tesseract.js');
const {db}=require('../database');
const {requirePermission}=require('../lib/permissions');
const {validateMemoryUpload,imageMulterFilter}=require('../lib/uploadSecurity');
const router=express.Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:3,parts:4,fieldNameSize:100,fieldSize:64*1024,headerPairs:50},fileFilter:imageMulterFilter});
const langPath=path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));
let workerPromise=null;
async function worker(){if(!workerPromise)workerPromise=createWorker('eng',OEM.LSTM_ONLY,{langPath,gzip:true,cacheMethod:'none',logger:()=>{}}).catch(e=>{workerPromise=null;throw e});return workerPromise}
function compact(text){return String(text||'').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim()}
router.get('/:id/po-template',requirePermission('purchasing'),async(req,res,next)=>{
  try{
    const id=Number(req.params.id);if(!id)return next();
    const {rows:[doc]}=await db.execute({sql:'SELECT id,supplier_id,status,converted_po_id FROM purchase_quote_imports WHERE id=?',args:[id]});if(!doc)return next();
    if(doc.converted_po_id||doc.status==='converted')return res.status(409).json({error:'This supplier quote is already linked to a purchase order'});
    const {rows:lines}=await db.execute({sql:`SELECT l.*,p.name product_name,p.sku product_sku FROM purchase_quote_import_lines l LEFT JOIN products p ON p.id=l.product_id WHERE l.import_id=? ORDER BY l.line_no,l.id`,args:[id]});
    if(!lines.length)return res.status(409).json({error:'Add at least one reviewed quote line before creating a purchase order'});
    const unresolved=lines.filter(x=>!x.product_id||x.match_status!=='matched');if(unresolved.length)return res.status(409).json({error:`${unresolved.length} quote line(s) still need a confirmed inventory match`});
    res.json({source_quote_import_id:id,supplier_id:doc.supplier_id,items:lines.map(x=>({product_id:x.product_id,product_name:x.product_name,product_sku:x.product_sku,quantity_ordered:Number(x.entered_quantity),unit_cost:Number(x.entered_unit_price),uom_code:x.entered_uom||undefined,supplier_part_number:x.supplier_part_number||undefined,source_description:x.description}))});
  }catch(e){res.status(500).json({error:e.message})}
});
router.post('/:id/mark-converted',requirePermission('purchasing_create'),async(req,res,next)=>{
  try{
    const id=Number(req.params.id),poId=Number(req.body?.po_id);if(!id||!poId)return next();
    const {rows:[doc]}=await db.execute({sql:'SELECT id,supplier_id,converted_po_id FROM purchase_quote_imports WHERE id=?',args:[id]});if(!doc)return next();if(doc.converted_po_id)return res.status(409).json({error:'Supplier quote is already linked to a purchase order'});
    const {rows:[u]}=await db.execute({sql:`SELECT COUNT(*) unresolved FROM purchase_quote_import_lines WHERE import_id=? AND (product_id IS NULL OR match_status!='matched')`,args:[id]});if(Number(u.unresolved))return res.status(409).json({error:'Every quote line must have a confirmed inventory match'});
    const {rows:[po]}=await db.execute({sql:'SELECT id,supplier_id,po_number FROM purchase_orders WHERE id=?',args:[poId]});if(!po)return res.status(404).json({error:'Purchase order not found'});if(doc.supplier_id&&Number(po.supplier_id)!==Number(doc.supplier_id))return res.status(409).json({error:'Purchase order supplier does not match the staged quote'});
    await db.execute({sql:`UPDATE purchase_quote_imports SET status='converted',converted_po_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND converted_po_id IS NULL`,args:[po.id,id]});res.json({id,status:'converted',converted_po_id:po.id,converted_po_number:po.po_number});
  }catch(e){res.status(500).json({error:e.message})}
});
router.post('/scan',requirePermission('purchasing_create'),upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose a JPG, PNG or WebP supplier quote image to scan'});
  const valid=validateMemoryUpload(req.file,{kind:'image'});if(!valid.ok)return res.status(415).json({error:valid.error});
  try{const w=await worker(),result=await w.recognize(req.file.buffer),text=compact(result?.data?.text),confidence=Number(result?.data?.confidence||0);if(!text)return res.status(422).json({error:'No readable text was found. Retake the image with the quote flat, well lit and in focus.'});res.json({source_name:String(req.file.originalname||'supplier-quote').slice(0,255),source_type:valid.mime,source_sha256:crypto.createHash('sha256').update(req.file.buffer).digest('hex'),extracted_text:text,ocr:{engine:'tesseract.js',language:'eng',confidence:Number(confidence.toFixed(2)),local:true}})}catch(e){console.error('Supplier quote OCR failed',e);res.status(422).json({error:'The quote image could not be read. Retake it clearly or enter the quote text manually.'})}
});
module.exports=router;
