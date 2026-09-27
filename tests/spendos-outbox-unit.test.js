const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateTypeForEvent,
  buildPurchaseRequestedEvent,
  enqueuePurchaseRequested,
  deliveryBackoffSeconds,
} = require('../lib/spendos-outbox');

test('purchase.requested event has stable identity and source version', () => {
  const event = buildPurchaseRequestedEvent({
    id: 42,
    pr_number: 'PR-000042',
    branch_id: 2,
    employee_id: 7,
    department: 'Operations',
    supplier_id: 5,
    currency: 'JMD',
    sourceVersion: 3,
    items: [{ product_id: 9, sku: 'ABC', product_name: 'Drill', quantity: 4, unit_cost: 12000, total: 48000 }],
  });
  assert.equal(event.id, 'total-tools:purchase-request:42:3');
  assert.equal(event.type, 'purchase.requested');
  assert.equal(event.sourceRecordId, '42');
  assert.equal(event.sourceVersion, 3);
  assert.equal(event.payload.items[0].lineTotal, 48000);
});

test('generic SpendOS events preserve real aggregate identity', () => {
  assert.equal(aggregateTypeForEvent({ type: 'purchase.requested' }), 'purchase_request');
  assert.equal(aggregateTypeForEvent({ type: 'purchase.received' }), 'purchase_receipt');
  assert.equal(aggregateTypeForEvent({ type: 'consumable.issued' }), 'internal_consumption');
  assert.equal(aggregateTypeForEvent({ type: 'operating.commitment.status_changed' }), 'operating_commitment');
  assert.equal(aggregateTypeForEvent({ type: 'custom.family.changed' }), 'custom');
  assert.equal(aggregateTypeForEvent({ type: 'anything', aggregateType: 'explicit_aggregate' }), 'explicit_aggregate');
});

test('enqueue is idempotency-shaped at the database boundary', async () => {
  const calls = [];
  const tx = { execute: async statement => { calls.push(statement); return { rowsAffected: 1 }; } };
  const event = await enqueuePurchaseRequested(tx, {
    id: 11,
    pr_number: 'PR-000011',
    sourceVersion: 1,
    items: [],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT\(event_id\) DO NOTHING/);
  assert.equal(calls[0].args[0], event.id);
  assert.equal(calls[0].args[2], 'purchase_request');
  assert.equal(calls[0].args[4], 1);
});

test('retry backoff is bounded and increasing', () => {
  const first = deliveryBackoffSeconds(1);
  const later = deliveryBackoffSeconds(5);
  const capped = deliveryBackoffSeconds(100);
  assert.ok(later > first);
  assert.equal(capped, 1280);
  assert.ok(capped <= 3600);
});
