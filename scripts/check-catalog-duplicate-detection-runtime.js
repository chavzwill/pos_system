'use strict';
const assert=require('assert');
const {duplicateProductIssues,normalizeProductName,normalizeSku}=require('../lib/catalog-integrity');

assert.equal(normalizeProductName('  DeWALT   Drill  '),'dewalt drill');
assert.equal(normalizeSku(' DCD-999_X/1 '),'dcd999x1');

const rows=[
  {id:1,active:1,name:'DeWALT 20V Drill',sku:'DCD-999'},
  {id:2,active:1,name:' dewalt 20v drill ',sku:'DCD999'},
  {id:3,active:1,name:'Impact Driver',sku:'DCF-100'},
  {id:4,active:0,name:'DeWALT 20V Drill',sku:'DCD.999'},
  {id:5,active:1,name:'Different Product',sku:'OTHER-1'}
];
const issues=duplicateProductIssues(rows);
const byCode=Object.fromEntries(issues.map(x=>[x.code,x]));
assert.ok(byCode.duplicate_product_name);
assert.deepEqual(byCode.duplicate_product_name.record.product_ids,[1,2]);
assert.ok(byCode.probable_duplicate_sku);
assert.deepEqual(byCode.probable_duplicate_sku.record.product_ids,[1,2]);
assert.ok(!byCode.probable_duplicate_sku.record.product_ids.includes(4));
assert.ok(!issues.some(x=>x.record.product_ids.includes(5)));
assert.ok(issues.every(x=>x.what_to_do_next.includes('Review the products side by side')));
console.log('Catalog Duplicate runtime certification passed.');
