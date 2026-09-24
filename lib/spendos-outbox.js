const crypto = require('crypto');

function eventIdForPurchaseRequest(prId, sourceVersion) {
  return `total-tools:purchase-request:${prId}:${sourceVersion}`;
}

function buildPurchaseRequestedEvent(input) {
  const sourceVersion = Number(input.sourceVersion || 1);
  return {
    id: eventIdForPurchaseRequest(input.id, sourceVersion),
    type: 'purchase.requested',
    occurredAt: input.occurredAt || new Date().toISOString(),
    tenantId: input.tenantId || process.env.SPENDOS_TENANT_ID || 'total-tools',
    source: 'total-tools-pos',
    sourceRecordId: String(input.id),
    sourceVersion,
    actorId: input.employee_id ? String(input.employee_id) : null,
    locationId: input.branch_id ? String(input.branch_id) : null,
    departmentId: input.department || null,
    payload: {
      requestNumber: input.pr_number,
      requestType: input.request_type || 'sale_items',
      supplierId: input.supplier_id ? String(input.supplier_id) : null,
      currency: input.currency || null,
      status: input.status || 'draft',
      items: (input.items || []).map(item => ({
        productId: item.product_id ? String(item.product_id) : null,
        sku: item.sku || null,
        description: item.product_name,
        quantity: Number(item.quantity || 0),
        unitCost: Number(item.unit_cost || 0),
        lineTotal: Number(item.total || 0),
      })),
    },
  };
}

async function enqueueSpendEvent(tx, event) {
  await tx.execute({
    sql: `INSERT INTO spendos_outbox
      (event_id,event_type,aggregate_type,aggregate_id,source_version,payload,status,attempts)
      VALUES (?,?,?,?,?,?, 'pending',0)
      ON CONFLICT(event_id) DO NOTHING`,
    args: [
      event.id,
      event.type,
      'purchase_request',
      event.sourceRecordId,
      event.sourceVersion,
      JSON.stringify(event),
    ],
  });
  return event;
}

async function enqueuePurchaseRequested(tx, input) {
  return enqueueSpendEvent(tx, buildPurchaseRequestedEvent(input));
}

function deliveryBackoffSeconds(attempts) {
  return Math.min(3600, Math.max(5, 5 * (2 ** Math.min(Number(attempts || 0), 8))));
}

module.exports = {
  buildPurchaseRequestedEvent,
  enqueuePurchaseRequested,
  enqueueSpendEvent,
  deliveryBackoffSeconds,
  eventIdForPurchaseRequest,
};
