const {test}=require('node:test');const assert=require('node:assert/strict');
const {convertUnitCost,validateCurrency,validateRate}=require('../lib/purchase-order-currency');
test('converts source unit cost once, retaining six decimals for UOM',()=>{assert.equal(convertUnitCost('12.3456','155.75'),1922.8272);assert.equal(convertUnitCost('0','155.75'),0);assert.equal(convertUnitCost('0.0001','1.23456789'),0.000123);});
test('rejects invalid currencies, unsafe or unbounded costs and rates',()=>{assert.equal(validateCurrency('usd'),'USD');for(const x of ['US','<x>','USDD'])assert.throws(()=>validateCurrency(x));for(const x of [0,-1,Infinity,NaN,'1e10'])assert.throws(()=>validateRate(x));for(const x of [-1,Infinity,'1e3','12.1234567'])assert.throws(()=>convertUnitCost(x,1));});
