'use strict';
const express=require('express');
const router=express.Router();
const {requireAuth}=require('../lib/permissions');
const {lookup,PredictiveLookupError}=require('../lib/predictive-lookup');

router.use(requireAuth);
router.get('/',async(req,res)=>{
  if(req.apiKey)return res.status(403).json({error:'API keys cannot use staff predictive lookup',code:'PREDICTIVE_LOOKUP_API_KEY_FORBIDDEN'});
  try{
    const result=await lookup({
      domain:req.query.domain,
      query:req.query.q,
      employee:req.employee,
      branch_id:req.query.branch_id,
      limit:req.query.limit,
      include_variations:req.query.include_variations
    });
    res.json(result);
  }catch(error){
    if(error instanceof PredictiveLookupError){
      return res.status(error.status||400).json({error:error.message,code:error.code});
    }
    console.error('Predictive lookup failed:',{
      request_id:req.requestId,
      domain:String(req.query.domain||'').slice(0,40),
      error:error&&(error.stack||error.message||error)
    });
    res.status(500).json({
      error:'Search is temporarily unavailable. Try again.',
      code:'PREDICTIVE_LOOKUP_UNAVAILABLE',
      request_id:req.requestId
    });
  }
});
module.exports=router;
