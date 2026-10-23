'use strict';
// Shared money rules: discounts are applied after tax, as on historical POS sales.
// All allocation works in integer cents. Stable largest remainders break ties by line.
function cents(value, label='amount') {
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>1000000000)throw new Error(`Invalid ${label}`);
  return Math.round((n+Number.EPSILON)*100);
}
function allocateCents(weights, amount) {
  if(!Array.isArray(weights)||weights.some(w=>!Number.isSafeInteger(w)||w<0)||!Number.isSafeInteger(amount)||amount<0)throw new Error('Invalid cent allocation');
  const total=weights.reduce((s,w)=>s+w,0);
  if(!Number.isSafeInteger(total)||amount>total)throw new Error('Discount cannot exceed merchandise value');
  if(!total)return weights.map(()=>0);
  const denominator=BigInt(total), numerator=BigInt(amount);
  const parts=weights.map((w,i)=>{const v=BigInt(w)*numerator;return {i,c:Number(v/denominator),r:v%denominator};});
  let remainder=amount-parts.reduce((s,p)=>s+p.c,0);
  const ranked=[...parts].sort((a,b)=>a.r===b.r?a.i-b.i:a.r>b.r?-1:1);
  for(const p of ranked){if(!remainder)break;if(p.c<weights[p.i]){p.c++;remainder--;}}
  if(remainder)throw new Error('Allocation failed');
  return parts.map(p=>p.c);
}
function percent(value){const n=Number(value||0);if(!Number.isFinite(n)||n<0||n>100)throw new Error('Discount percentage must be between 0 and 100');return n;}
function priceTicket(items,intent={},eligibleIndices=null) {
  const gross=items.map(x=>cents(Number(x.quantity)*Number(x.uom_base_unit_price??x.unit_price),'line value'));
  const line=items.map((x,i)=>Math.min(gross[i],Math.round(gross[i]*percent(x.line_discount_percent)/100)));
  const weights=gross.map((x,i)=>eligibleIndices&&!eligibleIndices.includes(i)?0:x-line[i]);
  const mode=intent.mode||'amount';if(!['amount','percentage'].includes(mode))throw new Error('Unknown discount mode');
  const value=mode==='percentage'?percent(intent.value):cents(intent.value||0)/100;
  const ticket=mode==='percentage'?Math.round(weights.reduce((a,b)=>a+b,0)*value/100):cents(value);
  const shares=allocateCents(weights,ticket);
  const allocations=shares.map((x,i)=>x+line[i]);
  return {mode,value,gross_cents:gross,discount_amount:allocations.reduce((s,x)=>s+x,0)/100,allocations,line_discounts:line,ticket_shares:shares};
}
function normalizeExtras(items,deliveryTaxRate){
  if(!Array.isArray(items)||items.length>500)throw new Error('A ticket requires at most 500 lines');
  const products=[],extras=[];
  items.forEach((line,index)=>{
    const type=line.line_type||'product';
    if(type==='product'){if(!Number.isSafeInteger(Number(line.product_id))||Number(line.product_id)<=0)throw new Error('Every product line requires a product');products.push({...line,line_type:'product',display_order:index});return;}
    if(!['delivery','comment'].includes(type))throw new Error('Unknown ticket line type');
    if(line.product_id||line.variation_id||line.serials?.length||line.lot_allocations?.length)throw new Error('Non-stock lines cannot reference a product, variation, serial or lot');
    const name=String(line.product_name??line.name??line.description??'').trim();
    if(!name||name.length>500||/[\u0000-\u0008\u000b-\u001f]/.test(name))throw new Error('Enter a description of 1–500 characters');
    const amount=type==='comment'?0:cents(line.unit_price??line.price,'delivery amount')/100;
    extras.push({line_type:type,product_id:null,product_name:name,sku:'',quantity:1,unit_price:amount,tax_rate:type==='comment'?0:Number(deliveryTaxRate),display_order:index});
  });
  return {products,extras};
}
function extraTotals(extras,taxExempt){let subtotal=0,tax=0;for(const e of extras||[]){const v=cents(e.unit_price);subtotal+=v;tax+=taxExempt?0:Math.round(v*Number(e.tax_rate||0)/100);}return {subtotal:subtotal/100,tax:tax/100};}
module.exports={cents,allocateCents,priceTicket,normalizeExtras,extraTotals};
