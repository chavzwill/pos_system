const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');

function clampInt(value, min = 0) { const n = Math.floor(Number(value) || 0); return Math.max(min, n); }

router.get('/recommendations', requirePermission('transfers'), async (req, res) => {
  try {
    const lookbackDays = Math.min(180, Math.max(14, parseInt(req.query.lookback_days || '30', 10)));
    const targetDays = Math.min(90, Math.max(7, parseInt(req.query.target_days || '21', 10)));
    const sourceReserveDays = Math.min(180, Math.max(targetDays, parseInt(req.query.source_reserve_days || '45', 10)));
    const minSalesEvidence = Math.min(50, Math.max(1, parseInt(req.query.min_sales_evidence || '2', 10)));

    const { rows: inventory } = await db.execute({
      sql: `SELECT bi.product_id, bi.branch_id, bi.stock_qty, bi.min_stock,
              p.sku, p.name AS product_name, p.active,
              b.name AS branch_name
            FROM branch_inventory bi
            JOIN products p ON p.id = bi.product_id
            JOIN branches b ON b.id = bi.branch_id
            WHERE p.active = 1 AND b.active = 1`, args: []
    });

    const { rows: sales } = await db.execute({
      sql: `SELECT ti.product_id, t.branch_id,
              SUM(CASE WHEN ti.quantity > 0 THEN ti.quantity ELSE 0 END) AS units_sold,
              COUNT(DISTINCT t.id) AS transaction_count,
              MAX(t.created_at) AS last_sale_at
            FROM transaction_items ti
            JOIN transactions t ON t.id = ti.transaction_id
            WHERE ti.product_id IS NOT NULL
              AND t.branch_id IS NOT NULL
              AND t.status = 'completed'
              AND date(t.created_at) >= date('now', ?)
            GROUP BY ti.product_id, t.branch_id`,
      args: [`-${lookbackDays} days`]
    });

    const saleMap = new Map(sales.map(s => [`${s.product_id}:${s.branch_id}`, s]));
    const byProduct = new Map();
    for (const inv of inventory) {
      const sale = saleMap.get(`${inv.product_id}:${inv.branch_id}`) || {};
      const units = Number(sale.units_sold) || 0;
      const daily = units / lookbackDays;
      const stock = Number(inv.stock_qty) || 0;
      const minStock = Number(inv.min_stock) || 0;
      const targetStock = Math.max(minStock, Math.ceil(daily * targetDays));
      const sourceReserve = Math.max(minStock, Math.ceil(daily * sourceReserveDays));
      const daysCover = daily > 0 ? stock / daily : (stock > 0 ? null : 0);
      const row = { ...inv, stock_qty: stock, min_stock: minStock, units_sold: units,
        transaction_count: Number(sale.transaction_count) || 0, last_sale_at: sale.last_sale_at || null,
        daily_velocity: Number(daily.toFixed(3)), target_stock: targetStock, source_reserve: sourceReserve,
        days_cover: daysCover == null ? null : Number(daysCover.toFixed(1)) };
      if (!byProduct.has(inv.product_id)) byProduct.set(inv.product_id, []);
      byProduct.get(inv.product_id).push(row);
    }

    const recommendations = [];
    for (const locations of byProduct.values()) {
      const destinations = locations.filter(x => {
        const shortage = x.target_stock - x.stock_qty;
        return shortage > 0 && (x.units_sold >= minSalesEvidence || x.stock_qty <= x.min_stock);
      }).sort((a,b) => (b.daily_velocity-a.daily_velocity) || (a.stock_qty-b.stock_qty));
      const sources = locations.filter(x => x.stock_qty > x.source_reserve)
        .sort((a,b) => ((b.stock_qty-b.source_reserve)-(a.stock_qty-a.source_reserve)) || (a.daily_velocity-b.daily_velocity));

      for (const dest of destinations) {
        let needed = clampInt(dest.target_stock - dest.stock_qty);
        for (const source of sources) {
          if (needed <= 0 || source.branch_id === dest.branch_id) continue;
          // Do not drain a source branch below its evidence-based reserve.
          const surplus = clampInt(source.stock_qty - source.source_reserve);
          if (surplus <= 0) continue;
          // Prefer stock that is genuinely slower at source than destination.
          if (source.daily_velocity > dest.daily_velocity && source.units_sold >= minSalesEvidence) continue;
          const qty = Math.min(needed, surplus);
          if (qty <= 0) continue;
          const evidence = dest.units_sold >= 10 ? 'strong' : dest.units_sold >= minSalesEvidence ? 'moderate' : 'low';
          const priority = dest.stock_qty <= 0 && dest.daily_velocity > 0 ? 'critical' : dest.stock_qty <= dest.min_stock ? 'high' : 'medium';
          recommendations.push({
            product_id: dest.product_id, sku: dest.sku, product_name: dest.product_name,
            from_branch_id: source.branch_id, from_branch_name: source.branch_name,
            to_branch_id: dest.branch_id, to_branch_name: dest.branch_name,
            suggested_quantity: qty, priority, evidence,
            destination: { stock_qty: dest.stock_qty, min_stock: dest.min_stock, units_sold: dest.units_sold, daily_velocity: dest.daily_velocity, days_cover: dest.days_cover, target_stock: dest.target_stock },
            source: { stock_qty: source.stock_qty, min_stock: source.min_stock, units_sold: source.units_sold, daily_velocity: source.daily_velocity, days_cover: source.days_cover, reserve_after_transfer: source.stock_qty - qty },
            reason: `${dest.branch_name} is below its ${targetDays}-day demand/minimum target while ${source.branch_name} has stock above its ${sourceReserveDays}-day/minimum reserve.`
          });
          source.stock_qty -= qty;
          needed -= qty;
        }
      }
    }

    const rank = { critical: 0, high: 1, medium: 2 };
    recommendations.sort((a,b) => (rank[a.priority]-rank[b.priority]) || (b.destination.daily_velocity-a.destination.daily_velocity));
    res.json({
      generated_at: new Date().toISOString(), lookback_days: lookbackDays, target_days: targetDays,
      source_reserve_days: sourceReserveDays, min_sales_evidence: minSalesEvidence,
      recommendations,
      methodology: 'Read-only recommendation. Uses completed POS sales velocity and branch inventory. Source stock is never recommended below its minimum/evidence-based reserve; creating a transfer remains a separate authorized action.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
