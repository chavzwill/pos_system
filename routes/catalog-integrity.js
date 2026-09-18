'use strict';
const express=require('express');
const router=express.Router();
const {requirePermission}=require('../lib/permissions');
const {catalogHealth,inspectProductCleanup}=require('../lib/catalog-integrity');

router.use(requirePermission('inventory'));
function safe(res,error){
  const status=Number(error?.status)||500;
  const code=error?.code||'CATALOG_INTEGRITY_UNAVAILABLE';
  if(status>=500)console.error('catalog_integrity_error',{code,message:error?.message||'unknown'});
  return res.status(status).json({error:status>=500?'Catalog health is temporarily unavailable.':error.message,code});
}
router.get('/health',async(req,res)=>{
  try{return res.json(await catalogHealth({limit:req.query.limit}));}catch(e){return safe(res,e);}
});
router.get('/products/:id/cleanup',async(req,res)=>{
  try{
    const data=await inspectProductCleanup(req.params.id);
    return res.json({product:data.product,can_archive:data.can_archive,stock:data.stock,
      historical_references_present:data.historical.reference_count>0,
      historical_reference_count:data.historical.reference_count});
  }catch(e){return safe(res,e);}
});
module.exports=router;
