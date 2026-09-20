'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const dbPath=path.join(os.tmpdir(),`pos-rental-compliance-${process.pid}.db`);for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}
process.env.TURSO_DATABASE_URL=`file:${dbPath.replace(/\\/g,'/')}`;
const {db,ensureReady}=require('../database');const {complianceMissing,eligibility,grantException,revokeException}=require('../lib/rental-compliance');
async function run(){await ensureReady();
  let r=await db.execute({sql:"INSERT INTO employees(first_name,last_name,username,password,pin,active) VALUES('Runtime','Approver','runtime_approver','x','123456',1)",args:[]});const employeeId=Number(r.lastInsertRowid);
  r=await db.execute({sql:"INSERT INTO customers(customer_number,first_name,last_name,is_rental_customer) VALUES('RC-1','Runtime','Rental',1)",args:[]});const customerId=Number(r.lastInsertRowid);
  let {rows:[customer]}=await db.execute({sql:'SELECT * FROM customers WHERE id=?',args:[customerId]});
  const missing=complianceMissing(customer);assert(missing.includes('photo ID type and number'));assert(missing.includes('proof of address'));
  let status=await eligibility(db,customer);assert.equal(status.eligible,false);assert.equal(status.via_exception,false);
  const expiry=new Date(Date.now()+86400000).toISOString();const ex=await grantException(db,{customerId,approvedBy:employeeId,reason:'Customer documents are being verified by management.',expiresAt:expiry});
  assert.equal(ex.customer_id,customerId);assert(ex.missing_requirements.includes('proof of address'));
  status=await eligibility(db,customer);assert.equal(status.eligible,true);assert.equal(status.via_exception,true);assert.equal(Number(status.exception.id),Number(ex.id));
  let second=null;try{await grantException(db,{customerId,approvedBy:employeeId,reason:'Second active exception should be rejected.',expiresAt:expiry})}catch(e){second=e}assert.equal(second?.code,'RENTAL_COMPLIANCE_EXCEPTION_ACTIVE');
  await revokeException(db,{exceptionId:ex.id,revokedBy:employeeId,reason:'Required evidence was not supplied.'});
  status=await eligibility(db,customer);assert.equal(status.eligible,false);assert.equal(status.via_exception,false);
  let mutation=null;try{await db.execute({sql:'UPDATE rental_compliance_exceptions SET reason=? WHERE id=?',args:['tamper',ex.id]})}catch(e){mutation=e}assert(mutation,'append-only trigger should reject updates');
  await db.execute({sql:"UPDATE customers SET rental_id_type='National ID',rental_id_number='ABC',rental_id_scan_path='scan.png',rental_address_proof_type='Utility Bill',rental_reference_name='Ref',rental_reference_phone='8765550000' WHERE id=?",args:[customerId]});
  ({rows:[customer]}=await db.execute({sql:'SELECT * FROM customers WHERE id=?',args:[customerId]}));status=await eligibility(db,customer);assert.equal(status.eligible,true);assert.equal(status.via_exception,false);assert.equal(status.missing.length,0);
  let unnecessary=null;try{await grantException(db,{customerId,approvedBy:employeeId,reason:'No exception should be needed anymore.',expiresAt:expiry})}catch(e){unnecessary=e}assert.equal(unnecessary?.code,'RENTAL_COMPLIANCE_ALREADY_COMPLETE');
  console.log('Rental Compliance Exception runtime certification passed.');
}
run().then(async()=>{try{await db.close?.()}catch(_){}for(const s of ['','-shm','-wal'])try{fs.rmSync(dbPath+s,{force:true})}catch(_){}process.exit(0)}).catch(async e=>{console.error(e.stack||e);try{await db.close?.()}catch(_){}process.exit(1)});