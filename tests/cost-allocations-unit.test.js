const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeAllocations}=require('../lib/cost-allocations');
const {buildPurchaseRequestedEvent}=require('../lib/spendos-outbox');

test('allocations must account for the full internal-use line',()=>{
  assert.throws(()=>normalizeAllocations([
    {target_type:'rental_asset',target_id:'7',allocation_amount:60}
  ],100),/full line amount/);
});

test('split allocations preserve cost targets and total',()=>{
  const rows=normalizeAllocations([
    {target_type:'rental_asset',target_id:'7',allocation_percent:60,expense_category:'parts'},
    {target_type:'department',target_id:'workshop',allocation_percent:40,expense_category:'parts'}
  ],1000);
  assert.equal(rows.reduce((s,x)=>s+x.allocation_amount,0),1000);
  assert.equal(rows[0].allocation_amount,600);
  assert.equal(rows[1].allocation_amount,400);
});

test('purchase event carries allocation evidence to SpendOS',()=>{
  const event=buildPurchaseRequestedEvent({
    id:5,pr_number:'PR-000005',sourceVersion:1,request_type:'internal_use',
    items:[{product_name:'Bearing',sku:'BRG',quantity:2,unit_cost:500,total:1000,
      allocations:[{target_type:'rental_asset',target_id:'9',target_label:'RA-9',
        allocation_amount:1000,allocation_quantity:2,allocation_percent:100,
        purpose:'repair',expense_category:'parts',valuation_status:'declared'}]}]
  });
  const a=event.payload.items[0].allocations[0];
  assert.equal(a.targetType,'rental_asset');
  assert.equal(a.targetId,'9');
  assert.equal(a.amount,1000);
  assert.equal(a.expenseCategory,'parts');
});

test('partial receipt copies proportional allocation',async()=>{
  const inserted=[];
  const executor={
    execute:async({sql,args})=>{
      if(sql.startsWith('SELECT * FROM cost_allocations'))return {rows:[{
        target_type:'rental_asset',target_id:'7',target_label:'RA-7',
        allocation_amount:1000,allocation_quantity:10,allocation_percent:100,
        purpose:'repair',expense_category:'parts',valuation_status:'committed'
      }]};
      if(sql.startsWith('INSERT INTO cost_allocations')){inserted.push(args);return {lastInsertRowid:1};}
      return {rows:[]};
    }
  };
  const {copyAllocations}=require('../lib/cost-allocations');
  const rows=await copyAllocations(executor,{
    fromSourceType:'purchase_order',fromSourceId:1,fromSourceLineId:2,
    toSourceType:'purchase_receipt',toSourceId:3,toSourceLineId:4,
    ratio:0.4,createdBy:9,valuationStatus:'actual'
  });
  assert.equal(rows[0].allocation_amount,400);
  assert.equal(rows[0].allocation_quantity,4);
  assert.equal(rows[0].valuation_status,'actual');
  assert.equal(inserted.length,1);
});
