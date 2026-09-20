'use strict';
const path=require('path');
function sanitizeSkuForFilename(sku){return String(sku||'').trim().replace(/[^A-Za-z0-9_.-]/g,'_');}
function productIndex(products=[]){
  const map=new Map();
  for(const product of products){
    const slug=sanitizeSkuForFilename(product?.sku).toLowerCase();
    if(!slug)continue;
    if(!map.has(slug))map.set(slug,[]);
    map.get(slug).push(product);
  }
  return map;
}
function planBulkImages(products=[],files=[],{replaceExisting=false}={}){
  const bySlug=productIndex(products),plan=[];
  for(const file of files){
    const name=String(file?.originalname||file?.name||'');
    const base=path.parse(name).name.toLowerCase();
    const matches=bySlug.get(base)||[];
    if(!matches.length){plan.push({status:'unmatched',file:name,product:null});continue;}
    if(matches.length>1){plan.push({status:'ambiguous',file:name,products:matches,product:null});continue;}
    const product=matches[0];
    if(product.consolidated_into_product_id){plan.push({status:'consolidated',file:name,product});continue;}
    if(product.image_path&&!replaceExisting){plan.push({status:'existing_image_preserved',file:name,product});continue;}
    plan.push({status:product.image_path?'replace':'add',file:name,product});
  }
  return plan;
}
module.exports={sanitizeSkuForFilename,productIndex,planBulkImages};
