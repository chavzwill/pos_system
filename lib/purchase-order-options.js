'use strict';
const fail=message=>Object.assign(new Error(message),{status:400});
function options(b={}){
 const request_type=b.request_type??'sale_items';if(!['sale_items','internal_use'].includes(request_type))throw fail('Choose resale or internal use');
 const department=String(b.department??'').trim();if(department.length>250)throw fail('Department must be at most 250 characters');
 const required_date=b.required_date||null;if(required_date&&(!/^\d{4}-\d{2}-\d{2}$/.test(required_date)||!Number.isFinite(Date.parse(required_date))||new Date(required_date).toISOString().slice(0,10)!==required_date))throw fail('Choose a valid required-by date');
 const online=b.is_online_purchase??false;if(![true,false,0,1].includes(online))throw fail('Online purchase must be a checkbox value');
 const items=(b.items||[]).map(i=>{const item_type=request_type==='internal_use'?'internal':(i.item_type||'sale');if(!['sale','internal'].includes(item_type))throw fail('Choose resale or internal item type');const product_url=String(i.product_url||'').trim();if(product_url){let u;try{u=new URL(product_url)}catch{throw fail('Enter a valid supplier product URL')}if(!['https:','http:'].includes(u.protocol)||u.username||u.password||product_url.length>2000)throw fail('Product links must be public HTTP or HTTPS URLs without credentials');}return {...i,item_type,product_url:product_url||null};});
 return {request_type,department:department||null,required_date,is_online_purchase:online?1:0,items};
}
async function persist(tx,poId,value){await tx.execute({sql:'UPDATE purchase_orders SET request_type=?,department=?,required_date=?,is_online_purchase=? WHERE id=?',args:[value.request_type,value.department,value.required_date,value.is_online_purchase,poId]});}
module.exports={options,persist};
