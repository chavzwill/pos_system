export function registerSourceTools(registry, { pos, spendos, smartcommerce }) {
  registry.register({
    name: "pos.product.read",
    description: "Read authoritative POS product information.",
    permission: "inventory",
    mode: "read",
    source: "pos",
    execute: ({ productId }) => pos.get(`/api/products/${encodeURIComponent(productId)}`),
  });

  registry.register({
    name: "pos.inventory.read",
    description: "Read authoritative branch inventory for a product.",
    permission: "inventory",
    mode: "read",
    source: "pos",
    execute: ({ productId, branchId }) =>
      pos.get(`/api/products/${encodeURIComponent(productId)}?branch_id=${encodeURIComponent(branchId)}`),
  });

  registry.register({
    name: "spendos.costs.target.read",
    description: "Read SpendOS analytical cost evidence for an approved target.",
    permission: "reports_financial",
    mode: "read",
    source: "spendos",
    execute: ({ tenantId, targetType, targetId }) =>
      spendos.get(`/v1/costs/target?tenantId=${encodeURIComponent(tenantId)}&targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`),
  });

  registry.register({
    name: "smartcommerce.catalog.read",
    description: "Read customer-facing catalog projection for reconciliation only.",
    permission: "inventory",
    mode: "read",
    source: "smartcommerce",
    execute: ({ productId }) =>
      smartcommerce.get(`/api/platform/products/${encodeURIComponent(productId)}`),
  });
}
