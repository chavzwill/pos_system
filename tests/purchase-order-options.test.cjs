'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {options}=require('../lib/purchase-order-options');
test('defaults preserve resale orders and internal orders force internal line semantics',()=>{assert.equal(options({}).request_type,'sale_items');const p=options({request_type:'internal_use',department:'Workshop',required_date:'2026-12-01',is_online_purchase:true,items:[{item_type:'sale',product_url:'https://supplier.test/item'}]});assert.equal(p.items[0].item_type,'internal');assert.equal(p.department,'Workshop');assert.equal(p.items[0].product_url,'https://supplier.test/item');});
test('invalid types, dates and unsafe product links are rejected before persistence',()=>{for(const body of [{request_type:'other'},{required_date:'2026-02-30'},{is_online_purchase:'false'},{items:[{item_type:'bad'}]},{items:[{product_url:'javascript:alert(1)'}]}])assert.throws(()=>options(body));});
