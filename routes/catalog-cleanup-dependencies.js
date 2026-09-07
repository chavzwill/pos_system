'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

const SAFE_TABLE = /^[a-zA-Z0-9_]+$/;

async function productReferenceTables() {
  const { rows } = await db.execute({
    sql: `SELECT m.name table_name
      FROM sqlite_master m
      WHERE m.type='table'
        AND m.name NOT LIKE 'sqlite_%'
        AND EXISTS (
          SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name='product_id'
        )
      ORDER BY m.name`,
    args: [],
  });
  return rows.map((row) => String(row.table_name || '')).filter((name) => SAFE_TABLE.test(name));
}

router.get('/:productId', requirePermission('inventory'), async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: 'Valid product id required' });
    }

    const { rows: [product] } = await db.execute({
      sql: 'SELECT id, sku, barcode, name, active, stock_qty FROM products WHERE id=? LIMIT 1',
      args: [productId],
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const tables = await productReferenceTables();
    const references = [];
    let totalReferences = 0;
    for (const table of tables) {
      const result = await db.execute({
        sql: `SELECT COUNT(*) reference_count FROM ${table} WHERE product_id=?`,
        args: [productId],
      });
      const count = Number(result.rows?.[0]?.reference_count || 0);
      if (!count) continue;
      references.push({ table, count });
      totalReferences += count;
    }

    const { rows: branchRows } = await db.execute({
      sql: 'SELECT branch_id, stock_qty, min_stock, updated_at FROM branch_inventory WHERE product_id=? ORDER BY branch_id',
      args: [productId],
    });
    const stockOnBranches = branchRows.reduce((sum, row) => sum + Math.max(0, Number(row.stock_qty || 0)), 0);

    res.json({
      product: {
        id: product.id,
        sku: product.sku || null,
        barcode: product.barcode || null,
        name: product.name,
        active: Boolean(product.active),
        global_stock_qty: Number(product.stock_qty || 0),
      },
      dependencies: {
        tables_with_references: references.length,
        total_references: totalReferences,
        references,
        branch_inventory: branchRows,
        stock_on_branches: stockOnBranches,
      },
      cleanup_constraints: {
        hard_delete_safe: totalReferences === 0 && stockOnBranches === 0 && Number(product.stock_qty || 0) === 0,
        archive_requires_zero_stock: stockOnBranches > 0 || Number(product.stock_qty || 0) > 0,
        historical_references_present: totalReferences > 0,
      },
      inspected_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('catalog_cleanup_dependency_error', { message: e?.message || 'unknown' });
    res.status(500).json({ error: 'Unable to inspect product cleanup dependencies' });
  }
});

module.exports = router;
