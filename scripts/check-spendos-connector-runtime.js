const fs = require('fs');
const http = require('http');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'spendos-runtime-test.db');
try { fs.rmSync(dbPath); } catch {}
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;

const { db, ensureReady } = require('../database');
const { enqueuePurchaseRequested } = require('../lib/spendos-outbox');

async function seedEvent() {
  await ensureReady();
  const tx = await db.transaction('write');
  const result = await tx.execute({
    sql: `INSERT INTO purchase_requests
      (pr_number,department,request_type,currency,spendos_version)
      VALUES (?,?,?,?,?)`,
    args: ['PR-SPENDOS-001', 'Operations', 'internal_use', 'JMD', 1],
  });
  const id = Number(result.lastInsertRowid);
  await enqueuePurchaseRequested(tx, {
    id,
    pr_number: 'PR-SPENDOS-001',
    department: 'Operations',
    request_type: 'internal_use',
    currency: 'JMD',
    sourceVersion: 1,
    items: [{ product_name: 'Shop towels', sku: 'TOWEL', quantity: 10, unit_cost: 500, total: 5000 }],
  });
  await tx.commit();
  return id;
}

async function main() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ key: req.headers['idempotency-key'], body: JSON.parse(body) });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.SPENDOS_INGEST_URL = `http://127.0.0.1:${address.port}/v1/events`;

  const prId = await seedEvent();
  const { claimRows, deliver } = require('./deliver-spendos-outbox');
  const claimed = await claimRows();
  if (claimed.length !== 1) throw new Error(`Expected 1 claimed event, got ${claimed.length}`);
  const outcome = await deliver(claimed[0]);
  if (outcome.status !== 'sent') throw new Error('Delivery did not reach sent state');

  const { rows: sentRows } = await db.execute({
    sql: 'SELECT * FROM spendos_outbox WHERE aggregate_id=? ORDER BY source_version',
    args: [String(prId)],
  });
  if (sentRows.length !== 1 || sentRows[0].status !== 'sent') throw new Error('Outbox row not marked sent');
  if (received.length !== 1) throw new Error('Receiver did not get exactly one event');
  if (received[0].key !== sentRows[0].event_id) throw new Error('Idempotency key mismatch');

  const tx = await db.transaction('write');
  await enqueuePurchaseRequested(tx, {
    id: prId,
    pr_number: 'PR-SPENDOS-001',
    department: 'Operations',
    request_type: 'internal_use',
    currency: 'JMD',
    sourceVersion: 1,
    items: [],
  });
  await tx.commit();
  const { rows: replayRows } = await db.execute({
    sql: 'SELECT id FROM spendos_outbox WHERE aggregate_id=? AND source_version=1',
    args: [String(prId)],
  });
  if (replayRows.length !== 1) throw new Error('Replay created a duplicate outbox event');

  server.close();
  try { fs.rmSync(dbPath); } catch {}
  console.log(JSON.stringify({
    ok: true,
    eventId: sentRows[0].event_id,
    delivered: received.length,
    replayRows: replayRows.length,
  }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
