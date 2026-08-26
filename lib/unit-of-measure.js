'use strict';
const {db}=require('../database');

let readyPromise=null;
const STANDARD_UNITS={
  count:{each:1,dozen:12},
  length:{mm:0.001,cm:0.01,m:1,in:0.0254,ft:0.3048,yd:0.9144},
  mass:{mg:0.000001,g:0.001,kg:1,oz:0.028349523125,lb:0.45359237},
  volume:{ml:0.001,l:1,'fl_oz_us':0.0295735295625,pt_us:0.473176473,qt_us:0.946352946,gal_us:3.785411784}
};
const ALIASES={
  ea:'each',unit:'each',units:'each',pcs:'each',pc:'each',piece:'each',pieces:'each',
  meter:'m',meters:'m',metre:'m',metres:'m',centimeter:'cm',centimeters:'cm',centimetre:'cm',centimetres:'cm',millimeter:'mm',millimeters:'mm',millimetre:'mm',millimetres:'mm',
  inch:'in',inches:'in',foot:'ft',feet:'ft',yard:'yd',yards:'yd',
  gram:'g',grams:'g',kilogram:'kg',kilograms:'kg',pound:'lb',pounds:'lb',ounce:'oz',ounces:'oz',
  liter:'l',liters:'l',litre:'l',litres:'l',milliliter:'ml',milliliters:'ml',millilitre:'ml',millilitres:'ml',gallon:'gal_us',gallons:'gal_us',quart:'qt_us',quarts:'qt_us',pint:'pt_us',pints:'pt_us'
};
function code(v){const x=String(v||'').trim().toLowerCase().replace(/\s+/g,'_');return ALIASES[x]||x;}
function round(n,p=6){const m=10**p;return Math.round((Number(n)+Number.EPSILON)*m)/m;}
function standardDimension(unit){unit=code(unit);for(const [dimension,units] of Object.entries(STANDARD_UNITS))if(Object.prototype.hasOwnProperty.call(units,unit))return dimension;return null;}
function convertStandard(value,from,to,precision=6){from=code(from);to=code(to);const fd=standardDimension(from),td=standardDimension(to);if(!fd||fd!==td)throw new Error(`Cannot convert ${from||'unknown'} to ${to||'unknown'}; units must share the same dimension`);const n=Number(value);if(!Number.isFinite(n))throw new Error('Conversion value must be numeric');return {value:n,from,to,dimension:fd,result:round(n*STANDARD_UNITS[fd][from]/STANDARD_UNITS[td][to],precision)};}
async function ensureColumn(table,column,definition){
  const {rows}=await db.execute({sql:`PRAGMA table_info(${table})`,args:[]});
  if(!rows.some(x=>String(x.name)===column))await db.execute({sql:`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,args:[]});
}
async function ensureUomSchema(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS product_uom_profiles(
        product_id INTEGER PRIMARY KEY REFERENCES products(id),
        base_uom TEXT NOT NULL DEFAULT 'each',
        dimension TEXT NOT NULL DEFAULT 'count',
        base_precision INTEGER NOT NULL DEFAULT 0,
        updated_by_employee_id INTEGER REFERENCES employees(id),
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS product_uom_conversions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        uom_code TEXT NOT NULL,
        uom_name TEXT NOT NULL,
        factor_to_base REAL NOT NULL,
        sell_allowed INTEGER NOT NULL DEFAULT 1,
        purchase_allowed INTEGER NOT NULL DEFAULT 1,
        barcode TEXT,
        sell_price REAL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_by_employee_id INTEGER REFERENCES employees(id),
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(product_id,uom_code)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS uom_usage_snapshots(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_line_id TEXT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        entered_quantity REAL NOT NULL,
        entered_uom TEXT NOT NULL,
        factor_to_base REAL NOT NULL,
        base_quantity REAL NOT NULL,
        base_uom TEXT NOT NULL,
        entered_unit_price REAL,
        base_unit_price REAL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_product_uom_product ON product_uom_conversions(product_id,active)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_uom_snapshot_source ON uom_usage_snapshots(source_type,source_id,source_line_id)'}
    ],'write');
    await ensureColumn('product_uom_conversions','sell_price','REAL');
    await ensureColumn('uom_usage_snapshots','entered_unit_price','REAL');
    await ensureColumn('uom_usage_snapshots','base_unit_price','REAL');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function getProfile(executor,productId){
  await ensureUomSchema();
  const {rows:[p]}=await executor.execute({sql:'SELECT * FROM product_uom_profiles WHERE product_id=?',args:[productId]});
  if(p)return p;
  const {rows:[product]}=await executor.execute({sql:'SELECT unit FROM products WHERE id=?',args:[productId]});
  return {product_id:Number(productId),base_uom:code(product?.unit||'each')||'each',dimension:standardDimension(product?.unit||'each')||'count',base_precision:0};
}
async function resolveProductUom(executor,productId,uomCode,mode='sell'){
  const profile=await getProfile(executor,productId);const requested=code(uomCode||profile.base_uom);
  if(requested===code(profile.base_uom))return {uom_code:requested,uom_name:requested,factor_to_base:1,sell_price:null,profile,is_base:true};
  let sql='SELECT * FROM product_uom_conversions WHERE product_id=? AND uom_code=? AND active=1';
  if(mode==='purchase')sql+=' AND purchase_allowed=1';
  else if(mode==='sell')sql+=' AND sell_allowed=1';
  else if(mode!=='movement')throw new Error(`Unknown UOM resolution mode: ${mode}`);
  const {rows:[row]}=await executor.execute({sql,args:[productId,requested]});
  if(!row)throw new Error(`${requested} is not configured as an allowed ${mode} unit for this product`);
  return {...row,profile,is_base:false};
}
function resolveSellEconomics(baseProductPrice,resolved){
  const basePrice=Number(baseProductPrice);if(!Number.isFinite(basePrice)||basePrice<0)throw new Error('Product base selling price is invalid');
  const factor=Number(resolved?.factor_to_base||1);if(!Number.isFinite(factor)||factor<=0)throw new Error('UOM conversion factor is invalid');
  const explicit=resolved?.sell_price==null||resolved.sell_price===''?null:Number(resolved.sell_price);
  if(explicit!=null&&(!Number.isFinite(explicit)||explicit<0))throw new Error('Configured UOM selling price is invalid');
  const enteredUnitPrice=round(explicit==null?basePrice*factor:explicit,2);
  const baseUnitPrice=round(enteredUnitPrice/factor,6);
  return {entered_unit_price:enteredUnitPrice,base_unit_price:baseUnitPrice,pricing_mode:explicit==null?'derived':'explicit'};
}
function toBaseQuantity(enteredQuantity,resolved){
  const q=Number(enteredQuantity);if(!Number.isFinite(q)||q<=0)throw new Error('Quantity must be greater than zero');
  const base=round(q*Number(resolved.factor_to_base),Math.max(6,Number(resolved.profile?.base_precision||0)));
  const precision=Number(resolved.profile?.base_precision||0);
  if(precision===0&&!Number.isInteger(base))throw new Error(`This unit conversion produces ${base} ${resolved.profile?.base_uom||'base units'}; inventory for this product requires whole base units`);
  if(base<=0)throw new Error('Converted base quantity must be greater than zero');
  return base;
}
async function snapshot(executor,{sourceType,sourceId,sourceLineId,productId,enteredQuantity,resolved,baseQuantity,enteredUnitPrice=null,baseUnitPrice=null}){
  await executor.execute({sql:`INSERT INTO uom_usage_snapshots(source_type,source_id,source_line_id,product_id,entered_quantity,entered_uom,factor_to_base,base_quantity,base_uom,entered_unit_price,base_unit_price) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,args:[sourceType,String(sourceId),sourceLineId==null?null:String(sourceLineId),productId,enteredQuantity,resolved.uom_code,resolved.factor_to_base,baseQuantity,resolved.profile.base_uom,enteredUnitPrice,baseUnitPrice]});
}
module.exports={STANDARD_UNITS,code,standardDimension,convertStandard,ensureUomSchema,getProfile,resolveProductUom,resolveSellEconomics,toBaseQuantity,snapshot};
