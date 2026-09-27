async function ensureSmartCommerceSyncSchema(db) {
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS smartcommerce_sync_versions (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (entity_type, entity_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS smartcommerce_sync_outbox (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_http_status INTEGER,
      last_error_code TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sc_sync_outbox_pending
      ON smartcommerce_sync_outbox(status, next_attempt_at, created_at)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sc_sync_outbox_entity
      ON smartcommerce_sync_outbox(entity_type, entity_id, entity_version)` },
  ]);

  const triggers = [
    {
      name: 'sc_category_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_category_insert AFTER INSERT ON categories BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('category',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'category.upserted','category',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'name',NEW.name,'description',NEW.description)
          FROM smartcommerce_sync_versions WHERE entity_type='category' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_category_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_category_update AFTER UPDATE ON categories BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('category',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'category.upserted','category',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'name',NEW.name,'description',NEW.description)
          FROM smartcommerce_sync_versions WHERE entity_type='category' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_category_delete',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_category_delete AFTER DELETE ON categories BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('category',CAST(OLD.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'category.deleted','category',CAST(OLD.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',OLD.id,'deleted',1)
          FROM smartcommerce_sync_versions WHERE entity_type='category' AND entity_id=CAST(OLD.id AS TEXT);
      END` },
    {
      name: 'sc_product_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_product_insert AFTER INSERT ON products BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('product',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'product.upserted','product',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'sku',NEW.sku,'barcode',NEW.barcode,'name',NEW.name,'description',NEW.description,'categoryId',NEW.category_id,'active',NEW.active,'onlineAvailable',NEW.online_available)
          FROM smartcommerce_sync_versions WHERE entity_type='product' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_product_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_product_update AFTER UPDATE ON products BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('product',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'product.upserted','product',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'sku',NEW.sku,'barcode',NEW.barcode,'name',NEW.name,'description',NEW.description,'categoryId',NEW.category_id,'active',NEW.active,'onlineAvailable',NEW.online_available)
          FROM smartcommerce_sync_versions WHERE entity_type='product' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_price_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_price_insert AFTER INSERT ON products BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('price',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'price.upserted','price',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('productId',NEW.id,'amount',NEW.price,'taxRate',NEW.tax_rate)
          FROM smartcommerce_sync_versions WHERE entity_type='price' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_price_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_price_update AFTER UPDATE OF price,tax_rate ON products BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('price',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'price.upserted','price',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('productId',NEW.id,'amount',NEW.price,'taxRate',NEW.tax_rate)
          FROM smartcommerce_sync_versions WHERE entity_type='price' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_media_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_media_insert AFTER INSERT ON products WHEN NEW.image_path IS NOT NULL BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('media',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'media.upserted','media',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('productId',NEW.id,'imagePath',NEW.image_path)
          FROM smartcommerce_sync_versions WHERE entity_type='media' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_media_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_media_update AFTER UPDATE OF image_path ON products BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('media',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'media.upserted','media',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('productId',NEW.id,'imagePath',NEW.image_path)
          FROM smartcommerce_sync_versions WHERE entity_type='media' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_variation_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_variation_insert AFTER INSERT ON product_variations BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('product_variation',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'product_variation.upserted','product_variation',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'productId',NEW.product_id,'sku',NEW.sku,'name',NEW.name,'attributes',NEW.attributes,'price',NEW.price,'priceModifier',NEW.price_modifier,'active',NEW.active)
          FROM smartcommerce_sync_versions WHERE entity_type='product_variation' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_variation_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_variation_update AFTER UPDATE ON product_variations BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('product_variation',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'product_variation.upserted','product_variation',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'productId',NEW.product_id,'sku',NEW.sku,'name',NEW.name,'attributes',NEW.attributes,'price',NEW.price,'priceModifier',NEW.price_modifier,'active',NEW.active)
          FROM smartcommerce_sync_versions WHERE entity_type='product_variation' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_availability_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_availability_insert AFTER INSERT ON branch_inventory BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('availability',CAST(NEW.product_id AS TEXT)||':'||CAST(NEW.branch_id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'availability.upserted','availability',CAST(NEW.product_id AS TEXT)||':'||CAST(NEW.branch_id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('productId',NEW.product_id,'branchId',NEW.branch_id,'quantityOnHand',NEW.stock_qty,'quantityAvailable',NEW.stock_qty,'status',CASE WHEN NEW.stock_qty>0 THEN 'in_stock' ELSE 'out_of_stock' END)
          FROM smartcommerce_sync_versions WHERE entity_type='availability' AND entity_id=CAST(NEW.product_id AS TEXT)||':'||CAST(NEW.branch_id AS TEXT);
      END` },
    {
      name: 'sc_availability_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_availability_update AFTER UPDATE OF stock_qty ON branch_inventory BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('availability',CAST(NEW.product_id AS TEXT)||':'||CAST(NEW.branch_id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'availability.upserted','availability',CAST(NEW.product_id AS TEXT)||':'||CAST(NEW.branch_id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('productId',NEW.product_id,'branchId',NEW.branch_id,'quantityOnHand',NEW.stock_qty,'quantityAvailable',NEW.stock_qty,'status',CASE WHEN NEW.stock_qty>0 THEN 'in_stock' ELSE 'out_of_stock' END)
          FROM smartcommerce_sync_versions WHERE entity_type='availability' AND entity_id=CAST(NEW.product_id AS TEXT)||':'||CAST(NEW.branch_id AS TEXT);
      END` },
    {
      name: 'sc_customer_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_customer_insert AFTER INSERT ON customers BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('customer',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'customer.upserted','customer',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'customerNumber',NEW.customer_number,'firstName',NEW.first_name,'lastName',NEW.last_name,'email',NEW.email,'phone',NEW.phone,'active',NEW.active)
          FROM smartcommerce_sync_versions WHERE entity_type='customer' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_customer_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_customer_update AFTER UPDATE ON customers BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('customer',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'customer.upserted','customer',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'customerNumber',NEW.customer_number,'firstName',NEW.first_name,'lastName',NEW.last_name,'email',NEW.email,'phone',NEW.phone,'active',NEW.active)
          FROM smartcommerce_sync_versions WHERE entity_type='customer' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_promotion_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_promotion_insert AFTER INSERT ON promotions BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('promotion',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'promotion.upserted','promotion',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'name',NEW.name,'description',NEW.description,'type',NEW.type,'value',NEW.value,'minPurchase',NEW.min_purchase,'appliesTo',NEW.applies_to,'startDate',NEW.start_date,'endDate',NEW.end_date,'active',NEW.active)
          FROM smartcommerce_sync_versions WHERE entity_type='promotion' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_promotion_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_promotion_update AFTER UPDATE ON promotions BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('promotion',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'promotion.upserted','promotion',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'name',NEW.name,'description',NEW.description,'type',NEW.type,'value',NEW.value,'minPurchase',NEW.min_purchase,'appliesTo',NEW.applies_to,'startDate',NEW.start_date,'endDate',NEW.end_date,'active',NEW.active)
          FROM smartcommerce_sync_versions WHERE entity_type='promotion' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_rental_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_rental_insert AFTER INSERT ON rental_agreements BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('rental',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'rental.upserted','rental',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'agreementNumber',NEW.agreement_number,'customerId',NEW.customer_id,'branchId',NEW.branch_id,'status',NEW.status,'checkoutDate',NEW.checkout_date,'dueDate',NEW.due_date,'returnedAt',NEW.returned_at)
          FROM smartcommerce_sync_versions WHERE entity_type='rental' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_rental_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_rental_update AFTER UPDATE ON rental_agreements BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('rental',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'rental.upserted','rental',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'agreementNumber',NEW.agreement_number,'customerId',NEW.customer_id,'branchId',NEW.branch_id,'status',NEW.status,'checkoutDate',NEW.checkout_date,'dueDate',NEW.due_date,'returnedAt',NEW.returned_at)
          FROM smartcommerce_sync_versions WHERE entity_type='rental' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_repair_insert',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_repair_insert AFTER INSERT ON work_orders BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('repair',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'repair.upserted','repair',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'workOrderNumber',NEW.wo_number,'customerId',NEW.customer_id,'branchId',NEW.branch_id,'status',NEW.status,'description',NEW.description,'itemLabel',NEW.item_label,'pickupDueDate',NEW.pickup_due_date,'completedAt',NEW.completed_at)
          FROM smartcommerce_sync_versions WHERE entity_type='repair' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
    {
      name: 'sc_repair_update',
      sql: `CREATE TRIGGER IF NOT EXISTS sc_repair_update AFTER UPDATE ON work_orders BEGIN
        INSERT INTO smartcommerce_sync_versions(entity_type,entity_id,version) VALUES('repair',CAST(NEW.id AS TEXT),1)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET version=version+1;
        INSERT INTO smartcommerce_sync_outbox(event_id,event_type,entity_type,entity_id,entity_version,occurred_at,correlation_id,payload_json)
          SELECT lower(hex(randomblob(16))),'repair.upserted','repair',CAST(NEW.id AS TEXT),version,datetime('now'),lower(hex(randomblob(16))),
            json_object('id',NEW.id,'workOrderNumber',NEW.wo_number,'customerId',NEW.customer_id,'branchId',NEW.branch_id,'status',NEW.status,'description',NEW.description,'itemLabel',NEW.item_label,'pickupDueDate',NEW.pickup_due_date,'completedAt',NEW.completed_at)
          FROM smartcommerce_sync_versions WHERE entity_type='repair' AND entity_id=CAST(NEW.id AS TEXT);
      END` },
  ];

  for (const trigger of triggers) {
    await db.execute({ sql: trigger.sql, args: [] });
  }
}

module.exports = { ensureSmartCommerceSyncSchema };
