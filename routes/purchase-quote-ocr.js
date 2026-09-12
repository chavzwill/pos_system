'use strict';
const express=require('express');
const multer=require('multer');
const path=require('path');
const crypto=require('crypto');
const {createWorker,OEM}=require('tesseract.js');
const {requirePermission}=require('../lib/permissions');
const {validateMemoryUpload,imageMulterFilter}=require('../lib/uploadSecurity');
const router=express.Router();

const upload=multer({
  storage:multer.memoryStorage(),
  limits:{fileSize:10*1024*1024,files:1,fields:3,parts:4,fieldNameSize:100,fieldSize:64*1024,headerPairs:50},
  fileFilter:imageMulterFilter,
});
const langPath=path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));
let workerPromise=null;
async function worker(){
  if(!workerPromise)workerPromise=createWorker('eng',OEM.LSTM_ONLY,{langPath,gzip:true,cacheMethod:'none',logger:()=>{}}).catch(e=>{workerPromise=null;throw e});
  return workerPromise;
}
function compact(text){return String(text||'').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim()}
router.post('/scan',requirePermission('purchasing_create'),upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose a JPG, PNG or WebP supplier quote image to scan'});
  const valid=validateMemoryUpload(req.file,{kind:'image'});if(!valid.ok)return res.status(415).json({error:valid.error});
  try{
    const w=await worker();const result=await w.recognize(req.file.buffer);const text=compact(result?.data?.text);const confidence=Number(result?.data?.confidence||0);
    if(!text)return res.status(422).json({error:'No readable text was found. Retake the image with the quote flat, well lit and in focus.'});
    res.json({source_name:String(req.file.originalname||'supplier-quote').slice(0,255),source_type:valid.mime,source_sha256:crypto.createHash('sha256').update(req.file.buffer).digest('hex'),extracted_text:text,ocr:{engine:'tesseract.js',language:'eng',confidence:Number(confidence.toFixed(2)),local:true}});
  }catch(e){console.error('Supplier quote OCR failed',e);res.status(422).json({error:'The quote image could not be read. Retake it clearly or enter the quote text manually.'});}
});
module.exports=router;
