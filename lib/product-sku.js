'use strict';

// The database owns allocation; browser clocks and product counts are unsafe
// when several branches create items at the same time. Gaps are intentional.
async function createWithSku(db, requested, automatic, insert) {
  const sku=String(requested??'').trim();
  if(!automatic){
    if(!sku){const error=new Error('Enter the product SKU / item number or choose automatic SKU generation.');error.status=400;throw error;}
    return insert(sku);
  }
  if(sku){const error=new Error('Choose automatic generation or enter a product number, not both.');error.status=400;throw error;}
  await db.execute({sql:'CREATE TABLE IF NOT EXISTS product_sku_sequence (id INTEGER PRIMARY KEY CHECK(id=1), last_value INTEGER NOT NULL)',args:[]});
  for(let attempt=0;attempt<1000;attempt++){
    const {rows:[row]}=await db.execute({sql:'INSERT INTO product_sku_sequence(id,last_value) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET last_value=last_value+1 RETURNING last_value',args:[]});
    const value=Number(row.last_value);
    if(!Number.isSafeInteger(value)||value<1)throw new Error('SKU sequence exhausted');
    const candidate='TT-'+String(value).padStart(6,'0');
    const {rows}=await db.execute({sql:'SELECT id FROM products WHERE lower(trim(sku))=lower(?) UNION ALL SELECT id FROM product_variations WHERE lower(trim(sku))=lower(?) LIMIT 1',args:[candidate,candidate]});
    if(rows.length)continue;
    try{return await insert(candidate);}
    catch(error){
      // A manual create can claim the same code after the check. Let the unique
      // constraint decide, then allocate another code only for this collision.
      if(!/UNIQUE constraint failed: products\.sku\b/.test(String(error.message)))throw error;
    }
  }
  const error=new Error('Unable to allocate a free SKU. Enter a product number or try again.');error.status=409;throw error;
}
module.exports={createWithSku};
