'use strict';
const {db}=require('../database');
let readyPromise=null;
async function ensureProcurementFx(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS procurement_currency_settings(
        id INTEGER PRIMARY KEY CHECK(id=1),
        base_currency TEXT NOT NULL DEFAULT 'JMD',
        updated_by_employee_id INTEGER REFERENCES employees(id),
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS procurement_fx_rates(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        currency_code TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        rate_to_base REAL NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        source_reference TEXT NOT NULL,
        recorded_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:'INSERT OR IGNORE INTO procurement_currency_settings(id,base_currency) VALUES(1,\'JMD\')'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_procurement_fx_current ON procurement_fx_rates(currency_code,base_currency,valid_from,valid_until,created_at)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}
async function getBaseCurrency(executor=db){await ensureProcurementFx();const {rows:[r]}=await executor.execute({sql:'SELECT base_currency FROM procurement_currency_settings WHERE id=1',args:[]});return String(r?.base_currency||'JMD').toUpperCase();}
async function getRate(executor,currency,asOf=null){await ensureProcurementFx();const base=await getBaseCurrency(executor),code=String(currency||base).toUpperCase();if(code===base)return {currency_code:code,base_currency:base,rate_to_base:1,source_reference:'base_currency',implicit:true};const date=asOf||new Date().toISOString().slice(0,10);const {rows:[r]}=await executor.execute({sql:`SELECT * FROM procurement_fx_rates WHERE upper(currency_code)=upper(?) AND upper(base_currency)=upper(?) AND (valid_from IS NULL OR date(valid_from)<=date(?)) AND (valid_until IS NULL OR date(valid_until)>=date(?)) ORDER BY datetime(created_at) DESC,id DESC LIMIT 1`,args:[code,base,date,date]});if(!r){const e=new Error(`No valid FX rate from ${code} to ${base} for ${date}`);e.status=409;throw e;}const rate=Number(r.rate_to_base);if(!(rate>0)){const e=new Error(`Invalid FX rate configured for ${code} to ${base}`);e.status=409;throw e;}return {...r,currency_code:code,base_currency:base,rate_to_base:rate};}
async function convertToBase(executor,amount,currency,asOf=null){const rate=await getRate(executor,currency,asOf);const source=Number(amount);if(!Number.isFinite(source))throw new Error('Currency conversion amount must be numeric');return {source_amount:source,source_currency:rate.currency_code,base_currency:rate.base_currency,fx_rate_to_base:Number(rate.rate_to_base),base_amount:Number((source*Number(rate.rate_to_base)).toFixed(4)),fx_source_reference:rate.source_reference||null};}
module.exports={ensureProcurementFx,getBaseCurrency,getRate,convertToBase};
