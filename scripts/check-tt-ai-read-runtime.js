'use strict';
const assert=require('node:assert/strict');
const Module=require('node:module');

const calls=[];
const product={
  id:501,sku:'GEN-55',barcode:null,name:'Generator',description:'Generator',
  brand_name:'HONDA',category_name:'Equipment',unit:'EA',price:2000,cost:1450,
  stock_qty:null,global_stock_qty:86,min_stock:1,active:1,is_rental:0,
  is_accessory:0,is_service:0,replacement_value:2500,rental_rate_type:null,rental_rate:null,
};
const asset={
  id:88,asset_number:'RA-501-88',product_id:501,product_name:'Generator',
  sku:'GEN-55',branch_id:1,branch_name:'Kingston',serial_id:111,
  serial_number:'GX1-00088',status:'active',acquisition_date:'2025-01-01',
  acquisition_evidence_grade:'verified',created_at:'2025-01-01',updated_at:'2025-01-01',
  acquisition_cost:500000,acquisition_evidence_ref:'private://invoice',
};
const db={execute:async({sql,args})=>{
  calls.push({sql,args});
  if(sql.includes('sqlite_master')) return {rows:[{name:args[0]}]};
  if(sql.includes('FROM products p')) return {rows:[product]};
  if(sql.includes('FROM rental_assets a')) return {rows:[asset]};
  if(sql.includes('FROM rental_asset_allocations aa')) return {rows:[]};
  if(sql.includes('FROM rental_asset_maintenance')) return {rows:[{
    id:1,maintenance_type:'service',started_at:'2026-01-01',
    ended_at:'2026-01-02',direct_cost:12400,notes:'Serviced',
  }]};
  throw new Error('UNEXPECTED_QUERY:'+sql.slice(0,120));
}};
const load=Module._load;
Module._load=function(request,parent,isMain){
  if(String(parent?.filename||'').replace(/\\/g,'/').endsWith('/lib/tt-ai-read-tools.js')){
    if(request==='../database') return {db};
    if(request==='./permissions') return {can:(permissions,key)=>permissions?.[key]===true};
  }
  return load.call(this,request,parent,isMain);
};
let reader;
try {reader=require('../lib/tt-ai-read-tools');} finally {Module._load=load;}

const staff=(permissions,branch=1)=>({id:42,default_branch_id:branch,permissions});
const checks=[];
function record(name){checks.push(name);}
async function run(){
  const inventory=staff({inventory:true});
  const purchasing=staff({inventory:true,purchasing:true});
  assert.equal(reader.resolveBranch(inventory,null),'1');
  record('default branch is staff branch');
  assert.throws(()=>reader.resolveBranch(inventory,2),e=>e.code==='TT_AI_BRANCH_FORBIDDEN');
  record('cross-branch access denied');
  assert.throws(()=>reader.resolveBranch(staff({inventory:true},null),2),e=>e.code==='TT_AI_BRANCH_FORBIDDEN');
  record('unassigned staff cannot pick arbitrary branch');
  assert.equal(reader.resolveBranch(staff({inventory:true,multi_branch_access:true}),2),'2');
  record('explicit multi-branch authority respected');

  const result=await reader.searchProducts({employee:inventory,query:'GEN'});
  assert.equal(result.branch_id,'1');
  assert.equal(result.items[0].stock_qty,null);
  assert.equal(Object.hasOwn(result.items[0],'global_stock_qty'),false);
  assert.equal(Object.hasOwn(result.items[0],'cost'),false);
  const query=calls.find(c=>c.sql.includes('FROM products p'));
  assert.deepEqual(query.args.slice(0,2),['1','1']);
  assert.match(query.sql,/bi\.stock_qty AS stock_qty/);
  assert.doesNotMatch(query.sql,/p\.stock_qty AS global_stock_qty|COALESCE\(bi\.stock_qty,0\) AS stock_qty/);
  record('no cross-branch totals or fabricated zero-stock');

  const buyer=await reader.searchProducts({employee:purchasing,query:'GEN'});
  assert.equal(buyer.items[0].cost,1450);
  record('product cost remains purchasing-gated');
  await assert.rejects(reader.searchProducts({employee:staff({}),query:'GEN'}),e=>e.code==='TT_AI_PERMISSION_DENIED');
  record('product lookup is permission gated');

  const rental=staff({rentals:true});
  const rentals=await reader.searchRentalAssets({employee:rental,query:'GX1'});
  assert.equal(rentals.items[0].serial_number,'GX1-00088');
  assert.equal(Object.hasOwn(rentals.items[0],'acquisition_cost'),false);
  assert.equal(Object.hasOwn(rentals.items[0],'acquisition_evidence_ref'),false);
  record('rental asset financial identity stays private');
  const detail=await reader.readRentalAsset({employee:rental,identifier:'RA-501-88'});
  assert.equal(Object.hasOwn(detail.maintenance[0],'direct_cost'),false);
  record('maintenance direct costs hidden');
  const buyerDetail=await reader.readRentalAsset({employee:purchasing,identifier:'RA-501-88'});
  assert.equal(buyerDetail.maintenance[0].direct_cost,12400);
  record('authorized maintenance costs readable');
  assert.throws(()=>reader.resolveBranch(staff({rentals:true},null),'1'),e=>e.code==='TT_AI_BRANCH_FORBIDDEN');
  record('rental staff without assignment cannot select a branch');
  console.log('TT AI POS read runtime: '+checks.length+'/'+checks.length+' passed');
}
run().catch(e=>{console.error('TT AI POS read runtime FAILED:',e);process.exitCode=1;});
