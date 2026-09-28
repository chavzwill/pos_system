'use strict';
const express=require('express');
const router=express.Router();
const {requirePermission}=require('../lib/permissions');
const {previewReclassification,correctCategoryDetails,reclassifyProducts}=require('../lib/category-correction');
router.use(requirePermission('inventory'));
function safe(res,e){const status=Number(e?.status)||500,code=e?.code||'CATEGORY_CORRECTION_UNAVAILABLE';if(status>=500)console.error('category_correction_error',{code,message:e?.message||'unknown'});return res.status(status).json({error:status>=500?'Category correction is temporarily unavailable.':e.message,code});}
router.get('/reclassification-preview',async(req,res)=>{try{return res.json(await previewReclassification({sourceCategoryId:req.query.source_category_id,targetCategoryId:req.query.target_category_id,productIds:String(req.query.product_ids||'').split(',').filter(Boolean)}));}catch(e){return safe(res,e);}});
router.patch('/:id',async(req,res)=>{try{return res.json(await correctCategoryDetails({categoryId:req.params.id,name:req.body?.name,description:req.body?.description,reason:req.body?.reason,expectedName:req.body?.expected_name,actorEmployeeId:req.employee?.id||null,requestId:req.requestId||null,method:req.method||null,path:req.originalUrl||req.path||null}));}catch(e){return safe(res,e);}});
router.post('/reclassifications',async(req,res)=>{try{return res.json(await reclassifyProducts({sourceCategoryId:req.body?.source_category_id,targetCategoryId:req.body?.target_category_id,productIds:req.body?.product_ids||[],reason:req.body?.reason,expectedSourceProductCount:req.body?.expected_source_product_count,actorEmployeeId:req.employee?.id||null,requestId:req.requestId||null,method:req.method||null,path:req.originalUrl||req.path||null}));}catch(e){return safe(res,e);}});
module.exports=router;
