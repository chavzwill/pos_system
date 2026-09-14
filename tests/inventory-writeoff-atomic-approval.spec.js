import { test, expect } from '@playwright/test';
import { createClient } from '@libsql/client';

const BASE='http://localhost:3001';
const db=createClient({url:'file:pos.db'});
const FINANCIAL_FAULT='trg_writeoff_financial_atomicity_fault';
const SERIAL_FAULT='trg_writeoff_serial_atomicity_fault';
const LOT_FAULT='trg_writeoff_lot_atomicity_fault';

async function login(username=process.env.POS_TEST_USER||'admin',password=process.env.POS_TEST_PASSWORD||'123456'){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  expect(r.status).toBe(200);
  return {cookie:(r.headers.get('set-cookie')||'').split(';')[0],body:await r.json()};
}

async function api(cookie,path,{method='GET',body,headers={}}={}){
  const h={Cookie:cookie,Accept:'application/json',...headers};
  if(body!==undefined)h['Content-Type']='application/json';
  const r=await fetch(`${BASE}${path}`,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json().catch(()=>null)};
}

async function clearFaults(){
  for(const name of [FINANCIAL_FAULT,SERIAL_FAULT,LOT_FAULT])await db.execute({sql:`DROP TRIGGER IF EXISTS ${name}`,args:[]}).catch(()=>{});
}

async function initializeWriteoffSchema(cookie){
  const r=await api(cookie,'/api/inventory-writeoffs');
  expect(r.status).toBe(200);
}
async function createProductWithStock(admin,{suffix,cost=10,quantity=1}){
  const branches=await api(admin.cookie,'/api/branches');
  expect(branches.status).toBe(200);
  const branch=branches.body.find(b=>Number(b.id)===Number(admin.body.default_branch_id))||branches.body.find(b=>b.active!==0)||branches.body[0];
  expect(branch).toBeTruthy();
  const created=await api(admin.cookie,'/api/products',{method:'POST',body:{sku:`AWO-${suffix}`,name:`Atomic Writeoff ${suffix}`,price:cost*1.5,cost,tax_rate:0,stock_qty:0,min_stock:0,active:1,branch_id:branch.id,taxable:0}});
  expect(created.status,JSON.stringify(created.body)).toBe(201);
  const stocked=await api(admin.cookie,`/api/products/${created.body.id}/stock`,{method:'PATCH',body:{branch_id:branch.id,adjustment:quantity,reason:'Atomic writeoff certification opening stock'}});
  expect(stocked.status,JSON.stringify(stocked.body)).toBe(200);
  return {branch,product:created.body};
}

async function createFinancialAuthorizer(admin,suffix){
  const group=await api(admin.cookie,'/api/security-groups',{method:'POST',body:{name:`Writeoff Finance ${suffix}`,reason:'Atomic writeoff certification fixture',permissions:{reports_financial:true}}});
  expect(group.status,JSON.stringify(group.body)).toBe(201);
  const pin=`8${String(Date.now()).slice(-5)}`;
  const username=`woff_fin_${suffix.replace(/[^a-z0-9]/gi,'').slice(-12)}`;
  const employee=await api(admin.cookie,'/api/employees',{method:'POST',body:{first_name:'Writeoff',last_name:'Authorizer',username,password:`Writeoff!${suffix}Aa9`,pin,security_group_id:group.body.id,default_branch_id:admin.body.default_branch_id,must_change_password:false}});
  expect(employee.status,JSON.stringify(employee.body)).toBe(201);
  return {group:group.body,employee:employee.body,pin};
}

async function createWriteoff(admin,{product,branch,quantity=1,reason_code='damage',reason_detail='Atomic approval failure fixture',extra={}}){
  const created=await api(admin.cookie,'/api/inventory-writeoffs',{method:'POST',body:{product_id:product.id,branch_id:branch.id,quantity,reason_code,reason_detail,...extra}});
  expect(created.status,JSON.stringify(created.body)).toBe(201);
  await db.execute({sql:'UPDATE inventory_writeoffs SET created_by_employee_id=NULL WHERE id=?',args:[created.body.id]});
  return created.body;
}
async function snapshot({writeoffId,productId,branchId,serialId=null,lotId=null}){
  const {rows:[writeoff]}=await db.execute({sql:'SELECT status,stock_movement_id,tracked_quantity,tracked_value,legacy_quantity,untracked_quantity,valuation_status,journal_entry_id FROM inventory_writeoffs WHERE id=?',args:[writeoffId]});
  const {rows:[branch]}=await db.execute({sql:'SELECT stock_qty FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]});
  const {rows:[product]}=await db.execute({sql:'SELECT stock_qty FROM products WHERE id=?',args:[productId]});
  const {rows:movements}=await db.execute({sql:"SELECT id,quantity_change,type,reference FROM stock_movements WHERE type='writeoff' AND reference=(SELECT writeoff_number FROM inventory_writeoffs WHERE id=?) ORDER BY id",args:[writeoffId]});
  const {rows:financial}=await db.execute({sql:'SELECT id,financial_authorizer_employee_id FROM inventory_writeoff_financial_approvals WHERE writeoff_id=?',args:[writeoffId]});
  const {rows:journals}=await db.execute({sql:"SELECT id,status FROM journal_entries WHERE source_type='inventory_writeoff' AND source_id=? ORDER BY id",args:[String(writeoffId)]});
  const {rows:events}=await db.execute({sql:"SELECT event_type,details FROM inventory_writeoff_events WHERE writeoff_id=? AND event_type='approved' ORDER BY id",args:[writeoffId]});
  let identity=null;
  if(serialId){const {rows:[serial]}=await db.execute({sql:'SELECT status,branch_id FROM inventory_serials WHERE id=?',args:[serialId]});identity={kind:'serial',...serial};}
  if(lotId){const {rows:[lot]}=await db.execute({sql:'SELECT status,available_quantity,branch_id FROM inventory_lots WHERE id=?',args:[lotId]});identity={kind:'lot',...lot};}
  return {writeoff,branch,product,movements,financial,journals,events,identity};
}

async function installFinancialFault(){
  await db.execute({sql:`CREATE TRIGGER ${FINANCIAL_FAULT} BEFORE INSERT ON inventory_writeoff_financial_approvals BEGIN SELECT RAISE(ABORT,'forced-writeoff-financial-failure'); END`,args:[]});
}
async function installSerialFault(){
  await db.execute({sql:`CREATE TRIGGER ${SERIAL_FAULT} BEFORE UPDATE ON inventory_serials WHEN NEW.status='written_off' BEGIN SELECT RAISE(ABORT,'forced-writeoff-serial-failure'); END`,args:[]});
}
async function installLotFault(){
  await db.execute({sql:`CREATE TRIGGER ${LOT_FAULT} BEFORE UPDATE ON inventory_lots WHEN NEW.available_quantity<OLD.available_quantity BEGIN SELECT RAISE(ABORT,'forced-writeoff-lot-failure'); END`,args:[]});
}
test.describe('Atomic inventory write-off approval',()=>{
  test.afterEach(async()=>{await clearFaults();});

  test('financial evidence failure rolls back the entire write-off approval',async()=>{
    const admin=await login();await initializeWriteoffSchema(admin.cookie);
    const suffix=`${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const {branch,product}=await createProductWithStock(admin,{suffix,cost:150000,quantity:1});
    const authorizer=await createFinancialAuthorizer(admin,suffix);
    const writeoff=await createWriteoff(admin,{product,branch});
    const before=await snapshot({writeoffId:writeoff.id,productId:product.id,branchId:branch.id});
    await installFinancialFault();

    const attempted=await api(admin.cookie,`/api/inventory-writeoffs/${writeoff.id}/approve`,{method:'POST',body:{writeoff_financial_pin:authorizer.pin,writeoff_financial_reason:'Independent financial approval for atomicity certification',writeoff_evidence_reference:`INC-${suffix}`}});
    expect(attempted.status).toBe(500);

    const after=await snapshot({writeoffId:writeoff.id,productId:product.id,branchId:branch.id});
    expect(after).toEqual(before);
  });

  test('serial finalization failure rolls back aggregate stock and approval state',async()=>{
    const admin=await login();await initializeWriteoffSchema(admin.cookie);
    const suffix=`${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const {branch,product}=await createProductWithStock(admin,{suffix,cost:10,quantity:1});
    const profile=await api(admin.cookie,`/api/inventory-traceability/profiles/${product.id}`,{method:'PUT',body:{tracking_mode:'serial'}});
    expect(profile.status,JSON.stringify(profile.body)).toBe(200);
    const serialNo=`SER-${suffix}`;
    const inserted=await db.execute({sql:`INSERT INTO inventory_serials(product_id,branch_id,serial_number,unit_cost,status) VALUES(?,?,?,?, 'available')`,args:[product.id,branch.id,serialNo,10]});
    const serialId=Number(inserted.lastInsertRowid);
    const writeoff=await createWriteoff(admin,{product,branch,extra:{serial_numbers:[serialNo]}});
    const before=await snapshot({writeoffId:writeoff.id,productId:product.id,branchId:branch.id,serialId});
    await installSerialFault();

    const attempted=await api(admin.cookie,`/api/inventory-writeoffs/${writeoff.id}/approve`,{method:'POST',body:{}});
    expect(attempted.status).toBe(500);

    const after=await snapshot({writeoffId:writeoff.id,productId:product.id,branchId:branch.id,serialId});
    expect(after).toEqual(before);
  });

  test('lot finalization failure rolls back aggregate stock and approval state',async()=>{
    const admin=await login();await initializeWriteoffSchema(admin.cookie);
    const suffix=`${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const {branch,product}=await createProductWithStock(admin,{suffix,cost:10,quantity:2});
    const profile=await api(admin.cookie,`/api/inventory-traceability/profiles/${product.id}`,{method:'PUT',body:{tracking_mode:'lot'}});
    expect(profile.status,JSON.stringify(profile.body)).toBe(200);
    const lotNo=`LOT-${suffix}`;
    const inserted=await db.execute({sql:`INSERT INTO inventory_lots(product_id,branch_id,lot_number,received_quantity,available_quantity,unit_cost,status) VALUES(?,?,?,?,?,?, 'available')`,args:[product.id,branch.id,lotNo,2,2,10]});
    const lotId=Number(inserted.lastInsertRowid);
    const writeoff=await createWriteoff(admin,{product,branch,quantity:2,extra:{lots:[{lot_number:lotNo,quantity:2}]}});
    const before=await snapshot({writeoffId:writeoff.id,productId:product.id,branchId:branch.id,lotId});
    await installLotFault();

    const attempted=await api(admin.cookie,`/api/inventory-writeoffs/${writeoff.id}/approve`,{method:'POST',body:{}});
    expect(attempted.status).toBe(500);

    const after=await snapshot({writeoffId:writeoff.id,productId:product.id,branchId:branch.id,lotId});
    expect(after).toEqual(before);
  });
});
