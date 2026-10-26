'use strict';
const fail=message=>Object.assign(new Error(message),{status:400});
function rate(v){const s=String(v??0);if(!/^\d+(\.\d{1,4})?$/.test(s)||Number(s)>100)throw fail('GCT rate must be between 0 and 100 with at most four decimals');return Number(s);}
function amount(subtotal,taxRate){const cents=Math.round(Number(subtotal)*100);if(!Number.isSafeInteger(cents)||cents<0)throw fail('Invalid purchase subtotal');const scaledRate=BigInt(Math.round(rate(taxRate)*10000)),tax=Number((BigInt(cents)*scaledRate+500000n)/1000000n);if(!Number.isSafeInteger(tax)||!Number.isSafeInteger(cents+tax))throw fail('Purchase total exceeds supported precision');return tax/100;}
async function configured(ex){const {rows}=await ex.execute({sql:"SELECT value FROM settings WHERE key='tax_rate'",args:[]});if(!rows.length)throw fail('Configure the POS tax rate before including GCT');return rate(rows[0].value);}
async function selection(ex,body,items,previous){let chosen;
 if(body.gct_enabled!=null){if(typeof body.gct_enabled!=='boolean')throw fail('Choose Include GCT or No GCT');chosen=body.gct_enabled?await configured(ex):0;if(body.gct_enabled&&body.tax_rate!=null&&rate(body.tax_rate)!==chosen)throw Object.assign(fail('The configured GCT rate changed. Refresh before saving.'),{status:409});}
 else chosen=rate(body.tax_rate??previous?.tax_rate??0);
 const subtotal=items.reduce((n,i)=>n+Math.round(Number(i.total)*100),0)/100;
 return {tax_rate:chosen,tax_amount:amount(subtotal,chosen)};
}
module.exports={rate,amount,configured,selection};
