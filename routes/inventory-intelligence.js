const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

function num(v) { return Number(v || 0); }

router.get('/overview', requirePermission('inventory'), async (req, res) => {
  try {
    const branchId = req.query.branch_id || null;
    const args = [];
    let branchFilter = '';
    if (branchId) { branchFilter = ' AND bi.branch_id = ?'; args.push(branchId); }

    const { rows: stockRows } = await db.execute({
      sql: `SELECT p.id as product_id, p.sku, p.barcode, p.name, p.cost, p.price, p.min_stock as product_min_stock,
        p.category_id, p.supplier_id, bi.branch_id, b.name as branch_name,
        COALESCE(bi.stock_qty,0) as stock_qty, COALESCE(bi.min_stock,p.min_stock,0) as min_stock,
        (SELECT MAX(sm.created_at) FROM stock_movements sm WHERE sm.product_id = p.id AND sm.branch_id = bi.branch_id) as last_movement_at
        FROM branch_inventory bi
        JOIN products p ON p.id = bi.product_id
        LEFT JOIN branches b ON b.id = bi.branch_id
        WHERE p.active = 1 AND COALESCE(p.is_service,0) = 0 AND COALESCE(p.is_non_inventory,0) = 0${branchFilter}
        ORDER BY p.name, b.name`, args
    });

    const today = Date.now();
    const enriched = stockRows.map(r => {
      const stock = num(r.stock_qty);
      const min = Math.max(num(r.min_stock), 0);
      const cost = Math.max(num(r.cost), 0);
      const daysSinceMovement = r.last_movement_at ? Math.floor((today - new Date(r.last_movement_at).getTime()) / 86400000) : null;
      return { ...r, stock_qty: stock, min_stock: min, inventory_value: Math.round(stock * cost * 100) / 100, days_since_movement: daysSinceMovement };
    });

    const low = enriched.filter(r => r.stock_qty > 0 && r.stock_qty <= r.min_stock);
    const out = enriched.filter(r => r.stock_qty <= 0);
    const negative = enriched.filter(r => r.stock_qty < 0);
    const overstock = enriched.filter(r => r.min_stock > 0 && r.stock_qty >= Math.max(r.min_stock * 3, r.min_stock + 5));
    const stale = enriched.filter(r => r.stock_qty > 0 && (r.days_since_movement === null || r.days_since_movement >= 90));
    const masterData = enriched.filter(r => !r.sku || !r.category_id || !r.supplier_id);

    const byProduct = new Map();
    for (const row of enriched) {
      if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
      byProduct.get(row.product_id).push(row);
    }
    const imbalances = [];
    for (const rows of byProduct.values()) {
      if (rows.length < 2) continue;
      const shortage = rows.filter(r => r.stock_qty <= r.min_stock).sort((a,b) => a.stock_qty - b.stock_qty)[0];
      const surplus = rows.filter(r => r.stock_qty > Math.max(r.min_stock * 2, r.min_stock + 3)).sort((a,b) => b.stock_qty - a.stock_qty)[0];
      if (!shortage || !surplus || shortage.branch_id === surplus.branch_id) continue;
      const reserve = Math.max(surplus.min_stock, 0);
      const transferable = Math.max(0, Math.floor(surplus.stock_qty - reserve));
      const needed = Math.max(0, Math.ceil(Math.max(shortage.min_stock, 1) - shortage.stock_qty));
      const suggested = Math.min(transferable, needed || transferable);
      if (suggested <= 0) continue;
      imbalances.push({
        product_id: shortage.product_id,
        sku: shortage.sku,
        product_name: shortage.name,
        from_branch_id: surplus.branch_id,
        from_branch_name: surplus.branch_name,
        to_branch_id: shortage.branch_id,
        to_branch_name: shortage.branch_name,
        source_stock: surplus.stock_qty,
        source_min_stock: surplus.min_stock,
        destination_stock: shortage.stock_qty,
        destination_min_stock: shortage.min_stock,
        suggested_quantity: suggested,
        evidence: 'Destination is at/below minimum stock while another branch is above twice its minimum stock. Recommendation never mutates inventory directly.'
      });
    }

    const totalValue = enriched.reduce((s,r) => s + r.inventory_value, 0);
    const atRiskValue = stale.reduce((s,r) => s + r.inventory_value, 0);
    const recommendations = [
      ...out.slice(0,25).map(r => ({ type:'stockout', severity:'critical', product_id:r.product_id, branch_id:r.branch_id, title:`${r.name} is out of stock`, evidence:`${r.branch_name || 'Branch'} has ${r.stock_qty} on hand; minimum is ${r.min_stock}.`, action:'Review replenishment, transfer, open PO, and reservations before creating stock.' })),
      ...low.slice(0,25).map(r => ({ type:'low_stock', severity:'high', product_id:r.product_id, branch_id:r.branch_id, title:`${r.name} is at minimum stock`, evidence:`${r.branch_name || 'Branch'} has ${r.stock_qty}; minimum is ${r.min_stock}.`, action:'Review demand and incoming stock, then transfer or purchase through the controlled workflow.' })),
      ...stale.slice(0,20).map(r => ({ type:'stale_stock', severity:'medium', product_id:r.product_id, branch_id:r.branch_id, title:`${r.name} may be stale stock`, evidence:r.days_since_movement === null ? 'No stock movement history was found for this branch item.' : `No recorded stock movement for ${r.days_since_movement} days.`, action:'Review sales/repair demand, catalog status and possible transfer/markdown/return options.' })),
    ];

    res.json({
      generated_at: new Date().toISOString(),
      branch_id: branchId,
      evidence_policy: 'All metrics are derived from current branch inventory, configured minimum stock, cost and recorded stock movements. Forecast demand is not invented.',
      summary: {
        branch_item_records: enriched.length,
        total_inventory_value: Math.round(totalValue * 100) / 100,
        stockouts: out.length,
        low_stock: low.length,
        negative_stock: negative.length,
        overstock_signals: overstock.length,
        stale_stock_signals: stale.length,
        stale_inventory_value: Math.round(atRiskValue * 100) / 100,
        master_data_exceptions: masterData.length,
        branch_imbalance_recommendations: imbalances.length,
      },
      branch_imbalances: imbalances.slice(0,50),
      recommendations: recommendations.slice(0,75),
      exceptions: {
        negative_stock: negative.slice(0,50),
        master_data: masterData.slice(0,50),
        overstock: overstock.slice(0,50),
        stale: stale.slice(0,50),
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
