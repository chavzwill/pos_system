// Narrow, server-side projection for the SmartCommerce read-only catalog key.
// Never return raw POS product/branch records to a machine catalog consumer:
// they include cost, supplier, operational and staffing fields.
function isSmartCommerceRead(req) {
  return req.apiKey?.id === 'smartcommerce-read';
}

function isPublishedProduct(row) {
  return Number(row?.active) === 1 &&
    Number(row?.online_available) === 1 &&
    row?.consolidated_into_product_id == null;
}

function publicProduct(row, branchId) {
  const pick = (keys) => {
    const result = {};
    for (const key of keys) {
      if (row[key] !== undefined) result[key] = row[key];
    }
    return result;
  };
  const output = pick([
    'id', 'sku', 'barcode', 'name', 'description', 'category_id',
    'category_name', 'brand_name', 'model_number', 'manufacturer_part_number',
    'image_path', 'price', 'tax_rate', 'taxable', 'active',
    'online_available', 'is_service', 'is_rental', 'is_accessory',
    'is_non_inventory', 'unit', 'has_variations',
  ]);
  // The consumer needs only branch-specific inventory for a selected branch.
  // Never send global inventory in its place.
  if (branchId) {
    output.branch_id = String(branchId);
    // A missing branch projection is unknown, never global inventory.
    // Branch-aware SQL and direct-lookup handlers must populate explicit
    // branch_* columns before this public transformation is called.
    const quantity = row.branch_stock_qty;
    const minimum = row.branch_min_stock;
    if (quantity !== undefined) output.branch_stock_qty = quantity;
    if (minimum !== undefined) output.branch_min_stock = minimum;
  }
  return output;
}

function publicBranch(row) {
  const allowed = [
    'id', 'name', 'branch_code', 'address', 'city', 'state',
    'zip', 'phone', 'email', 'currency', 'active',
  ];
  return Object.fromEntries(allowed
    .filter((field) => row[field] !== undefined)
    .map((field) => [field, row[field]]));
}

module.exports = { isSmartCommerceRead, isPublishedProduct, publicProduct, publicBranch };
