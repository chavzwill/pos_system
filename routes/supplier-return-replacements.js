'use strict';
const router=require('express').Router();
const replacement=require('../lib/supplier-return-replacements');
function problem(res,e){const conflict=/UNIQUE|SQLITE_CONSTRAINT/.test(String(e.message));const status=e.status||(conflict?409:500);if(status>=500)console.error('supplier_return_replacement_failed',e);return res.status(status).json({error:status>=500?'Replacement reconciliation failed. Please retry.':conflict?'Replacement evidence already exists.':e.message});}
router.get('/:id/replacements',async(req,res)=>{try{res.json(await replacement.replacementDocument(req));}catch(e){problem(res,e);}});
router.post('/:id/replacements',async(req,res)=>{try{const row=await replacement.linkReplacement(req);res.status(row.replayed?200:201).json(row);}catch(e){problem(res,e);}});
module.exports=router;
