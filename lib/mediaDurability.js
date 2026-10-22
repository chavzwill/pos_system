'use strict';

// Ephemeral serverless disks are not a durable place to store business records.
// A persistent self-hosted filesystem may be used only by an explicitly
// governed on-premises/VM deployment. Production Cloudinary credentials do
// not authorize bearer-public storage for private evidence.
function durableProviderRequired(env=process.env){
 return Boolean(String(env?.VERCEL||'').trim()) ||
   String(env?.POS_REQUIRE_DURABLE_MEDIA||'').trim()==='1';
}
function durableMediaError(kind='media'){
 const error=new Error('Durable upload storage is not configured. Existing records were not replaced.');
 error.status=503;
 error.code=kind==='private'?'PRIVATE_STORAGE_UNAVAILABLE':'DURABLE_MEDIA_STORAGE_UNAVAILABLE';
 return error;
}
function requireDurableProvider(cloudResult,{kind='media',env=process.env}={}){
 if(!cloudResult&&durableProviderRequired(env))throw durableMediaError(kind);
 return cloudResult;
}
function sendDurableMediaFailure(res,kind='media'){
 const err=durableMediaError(kind);
 return res.status(err.status).json({error:err.message,code:err.code});
}
module.exports={durableProviderRequired,durableMediaError,requireDurableProvider,sendDurableMediaFailure};
