const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('operational initialization does not seed demo business records', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spendos-empty-cert-'));
 process.env.TURSO_DATABASE_URL='file:'+path.join(dir,'pos.db');
 process.env.POS_SKIP_DEMO_SEED='1';
 const {db,ensureReady}=require('../database');
 try {
  await ensureReady();
  for(const table of ['branches','suppliers','products','customers','employees','transactions','crm_leads','purchase_requests','purchase_orders','spendos_outbox']) {
   const {rows:[row]}=await db.execute(`SELECT COUNT(*) n FROM ${table}`);
   assert.equal(Number(row.n),0,table+' must remain empty');
  }
 } finally { db.close(); }
});
