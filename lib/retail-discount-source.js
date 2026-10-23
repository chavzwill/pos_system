'use strict';
const {db}=require('../database');
const {cents}=require('./retail-ticket-pricing');
async function resolveSource(body){
  const source=body.discount_source||'manual';
  if(['manual','none'].includes(source))return null;
  if(body.items.some(x=>Number(x.line_discount_percent||0)>0))throw new Error('Automatic discounts cannot be combined with line discounts');
  if(source==='customer_discount_card'){
    const {rows:[card]}=await db.execute({sql:`SELECT d.id,d.discount_percent,d.active FROM customers c JOIN discount_card_types d ON d.id=c.discount_card_type_id WHERE c.id=? AND c.active=1`,args:[Number(body.customer_id)||0]});
    if(!card||!card.active)throw new Error('Customer discount card is unavailable');
    return {source,referenceId:Number(card.id),intent:{mode:'percentage',value:Number(card.discount_percent)}};
  }
  if(source!=='automatic_promotion')throw new Error('Unknown discount source');
  const today=new Date().toISOString().slice(0,10);
  const {rows:[p]}=await db.execute({sql:`SELECT * FROM promotions WHERE id=? AND active=1 AND (start_date IS NULL OR start_date<=?) AND (end_date IS NULL OR end_date>=?) AND NOT EXISTS(SELECT 1 FROM promotion_codes WHERE promotion_id=promotions.id)`,args:[Number(body.discount_reference_id)||0,today,today]});
  if(!p)throw new Error('Automatic promotion is no longer available');
  const gross=body.items.map(i=>cents(Number(i.quantity)*Number(i.uom_base_unit_price??i.unit_price)));
  if(gross.reduce((s,x)=>s+x,0)<cents(p.min_purchase||0))throw new Error('Automatic promotion minimum purchase is not met');
  let eligibleIndices=body.items.map((_,i)=>i);
  if(['specific','categories','items'].includes(p.applies_to)){
    const {rows:scope}=await db.execute({sql:'SELECT item_type,item_id FROM promotion_items WHERE promotion_id=?',args:[p.id]});
    const ids=new Set(scope.filter(x=>x.item_type==='product'&&p.applies_to!=='categories').map(x=>Number(x.item_id))),cats=new Set(scope.filter(x=>x.item_type==='category'&&p.applies_to!=='items').map(x=>Number(x.item_id)));
    const {rows:products}=await db.execute({sql:`SELECT id,category_id FROM products WHERE id IN (${body.items.map(()=>'?').join(',')})`,args:body.items.map(i=>Number(i.product_id))});
    const categories=new Map(products.map(x=>[Number(x.id),Number(x.category_id)]));eligibleIndices=body.items.map((x,i)=>ids.has(Number(x.product_id))||cats.has(categories.get(Number(x.product_id)))?i:null).filter(i=>i!==null);
  }
  const eligible=eligibleIndices.reduce((s,i)=>s+gross[i],0);if(!eligible)throw new Error('No merchandise qualifies for this automatic promotion');
  const amount=p.type==='percentage'?Math.round(eligible*Number(p.value)/100):Math.min(cents(p.value),eligible);
  return {source,referenceId:Number(p.id),eligibleIndices,intent:{mode:'amount',value:amount/100}};
}
module.exports={resolveSource};
