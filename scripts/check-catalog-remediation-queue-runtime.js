'use strict';
const assert=require('assert');
const {buildRemediationQueue,recordKey}=require('../lib/catalog-integrity');

const product={type:'product',id:7,sku:'ABC-7',name:'Hammer Drill'};
const category={type:'category',name:'Power Tools',ids:[3]};
const group={type:'product_group',product_ids:[11,10],products:[{id:10,sku:'D-10',name:'Drill'},{id:11,sku:'D_10',name:'Drill'}]};
const issues=[
  {code:'missing_barcode',severity:'low',title:'No barcode',why_it_matters:'Scanning is slower.',record:product,what_to_do_next:'Add a barcode.'},
  {code:'missing_supplier',severity:'medium',title:'No supplier',why_it_matters:'Purchasing is weaker.',record:product,what_to_do_next:'Assign supplier.'},
  {code:'stock_balance_mismatch',severity:'high',title:'Stock mismatch',why_it_matters:'Availability cannot be trusted.',record:{type:'product',id:2,sku:'STOCK-2',name:'Saw'},what_to_do_next:'Reconcile stock.'},
  {code:'duplicate_category_name',severity:'medium',title:'Duplicate category',why_it_matters:'Reporting splits.',record:category,what_to_do_next:'Review categories.'},
  {code:'probable_duplicate_sku',severity:'medium',title:'Possible duplicate SKUs',why_it_matters:'Records may be duplicated.',record:group,what_to_do_next:'Review side by side.'}
];
const before=JSON.stringify(issues);
const queue=buildRemediationQueue(issues);
assert.equal(queue.total_records,4);
assert.equal(queue.items[0].severity,'high');
const productItem=queue.items.find(x=>x.key==='product:7');
assert.ok(productItem);
assert.equal(productItem.issue_count,2);
assert.equal(productItem.severity,'medium');
assert.deepEqual(new Set(productItem.codes),new Set(['missing_barcode','missing_supplier']));
assert.equal(productItem.issues.length,2);
assert.equal(queue.by_severity.high,1);
assert.equal(queue.by_severity.medium,3);
assert.equal(queue.by_severity.low,0);
assert.equal(recordKey(group),'product_group:10,11');
assert.equal(JSON.stringify(issues),before,'queue construction must not mutate issue evidence');
const again=buildRemediationQueue([...issues].reverse());
assert.deepEqual(again.items.map(x=>x.key),queue.items.map(x=>x.key),'ordering must be deterministic regardless of input order');
console.log('Catalog remediation queue runtime certification passed.');
