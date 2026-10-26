'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const {amount,rate}=require('../lib/purchase-request-tax');
test('GCT adds once and removal always produces zero tax',()=>{a.equal(amount(100,15),15);a.equal(amount(100,0),0);a.equal(amount(.1,15),.02);a.equal(amount(123.45,8.5),10.49)});
test('invalid rates and unsupported values fail closed',()=>{for(const n of [-1,101,'bad',Infinity])a.throws(()=>rate(n));a.throws(()=>amount(-1,15));});
test('server calculates configured GCT, ignores supplied amounts and rejects stale rates',async()=>{const {selection}=require('../lib/purchase-request-tax'),ex={execute:async()=>({rows:[{value:'15'}]})},items=[{total:100}];a.deepEqual(await selection(ex,{gct_enabled:true,tax_rate:15,tax_amount:999},items),{tax_rate:15,tax_amount:15});a.deepEqual(await selection(ex,{gct_enabled:false,tax_rate:15,tax_amount:999},items),{tax_rate:0,tax_amount:0});await a.rejects(selection(ex,{gct_enabled:true,tax_rate:8.5},items),e=>e.status===409);await a.rejects(selection(ex,{gct_enabled:'false'},items));a.deepEqual(await selection(ex,{},items,{tax_rate:8.5}),{tax_rate:8.5,tax_amount:8.5});});
