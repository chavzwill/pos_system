'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission } = require('../lib/permissions');
const { getAvailableQty } = require('../lib/inventory-stock-status');

const allowedPayments = new Set(['cash','card','credit','bank_transfer']);
const asMoney = v => Number.parseFloat(v || 0);

router.post('/', requirePermission('pos'), async (req,res,next) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({error:'No items in transaction'});
    if (!req.apiKey && !body.branch_id) return res.status(400).json({error:'A selling branch is required for a POS transaction'});

    if (!req.apiKey && req.employee) {
      body.employee_id = req.employee.id;
      const {rows: drawers} = await db.execute({sql:'SELECT id FROM cash_drawers WHERE branch_id=? AND active=1',args:[body.branch_id]});
      if (drawers.length) {
        let activeSession = null;
        if (body.drawer_session_id) {
          const {rows:[s]} = await db.execute({sql:"SELECT * FROM drawer_sessions WHERE id=? AND status='open'",args:[body.drawer_session_id]});
          if (!s) return res.status(409).json({error:'The selected cash drawer session is not open'});
          if (String(s.employee_id)!==String(req.employee.id)) return res.status(403).json({error:'This cash drawer session belongs to another employee'});
          if (String(s.branch_id)!==String(body.branch_id)) return res.status(409).json({error:'Cash drawer session does not belong to the selling branch'});
          activeSession=s;
        } else {
          const {rows:[s]} = await db.execute({sql:"SELECT * FROM drawer_sessions WHERE employee_id=? AND branch_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1",args:[req.employee.id,body.branch_id]});
          activeSession=s||null;
        }
        if (!activeSession) return res.status(409).json({error:'Open your cash drawer before completing an in-store sale'});
        body.drawer_session_id=activeSession.id;
      }
    }

    const discount = asMoney(body.discount_amount);
    const storeCredit = asMoney(body.store_credit_applied);
    if (!Number.isFinite(discount) || discount < 0) return res.status(400).json({error:'Discount amount cannot be negative'});
    if (!Number.isFinite(storeCredit) || storeCredit < 0) return res.status(400).json({error:'Store credit amount cannot be negative'});

    let authoritativeSubtotal = 0;
    let authoritativeTax = 0;
    for (const line of items) {
      const qty = Number(line.quantity);
      if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({error:'Sale quantities must be positive whole numbers'});
      const {rows:[product]} = await db.execute({sql:'SELECT * FROM products WHERE id=?',args:[line.product_id]});
      if (!product || !product.active) return res.status(400).json({error:`Product ${line.product_id} is unavailable`});
      if (product.is_service || product.is_rental) return res.status(400).json({error:`${product.name} cannot be sold through standard retail checkout`});

      if (body.branch_id) {
        const state = await getAvailableQty(db, line.product_id, body.branch_id);
        if (state.available < qty) return res.status(409).json({error:`Not enough available ${product.name} at the selected branch (${state.available} sellable; ${state.restricted} restricted)`});
      }

      let unitPrice = Number(product.price || 0);
      if (line.variation_id) {
        const {rows:[variation]} = await db.execute({sql:'SELECT * FROM product_variations WHERE id=? AND product_id=?',args:[line.variation_id,line.product_id]});
        if (!variation) return res.status(400).json({error:`Variation ${line.variation_id} is unavailable`});
        const available = Number(variation.stock_qty || 0);
        if (available < qty) return res.status(409).json({error:`Not enough stock for ${product.name} (${available} variation units available)`});
        unitPrice = variation.price != null ? Number(variation.price) : Number(product.price || 0) + Number(variation.price_modifier || 0);
      } else if (!body.branch_id) {
        const available = Number(product.stock_qty || 0);
        if (available < qty) return res.status(409).json({error:`Not enough stock for ${product.name} (${available} available)`});
      }

      const lineTotal = Number((unitPrice * qty).toFixed(2));
      const lineTax = body.tax_exempt ? 0 : Number((lineTotal * Number(product.tax_rate || 0) / 100).toFixed(2));
      authoritativeSubtotal += lineTotal;
      authoritativeTax += lineTax;
    }
    authoritativeSubtotal = Number(authoritativeSubtotal.toFixed(2));
    authoritativeTax = Number(authoritativeTax.toFixed(2));
    if (discount > authoritativeSubtotal + authoritativeTax) return res.status(400).json({error:'Discount cannot exceed the sale value'});

    let customer = null;
    if (body.customer_id) {
      const {rows:[row]} = await db.execute({sql:'SELECT * FROM customers WHERE id=? AND active=1',args:[body.customer_id]});
      if (!row) return res.status(400).json({error:'Selected customer is unavailable'});
      customer = row;
    }
    if (storeCredit > 0) {
      if (!customer) return res.status(400).json({error:'Store credit requires a customer'});
      const availableCredit = Math.max(0, -Number(customer.account_balance || 0));
      if (storeCredit - availableCredit > 0.01) return res.status(400).json({error:`Store credit exceeds the customer’s available balance (${availableCredit.toFixed(2)})`});
    }

    const tenders = Array.isArray(body.tenders) && body.tenders.length ? body.tenders : null;
    if (tenders) {
      for (const leg of tenders) {
        if (!allowedPayments.has(leg.method) || leg.method === 'credit') return res.status(400).json({error:'Invalid split-payment method'});
        const amount = asMoney(leg.amount);
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({error:'Split-payment amounts must be greater than zero'});
        if ((leg.method === 'card' || leg.method === 'bank_transfer') && !String(leg.approval_code || '').trim()) return res.status(400).json({error:`${leg.method === 'card' ? 'Card' : 'Bank transfer'} payment requires an approval/reference code`});
      }
    } else {
      const method = body.payment_method || 'cash';
      if (!allowedPayments.has(method)) return res.status(400).json({error:'Invalid payment method'});
      if (method === 'credit') {
        if (!customer) return res.status(400).json({error:'Charge Account requires a customer'});
        if (customer.customer_type !== 'credit') return res.status(400).json({error:'Customer does not have a credit account'});
        if (customer.account_blocked) return res.status(400).json({error:'Customer credit account is blocked'});
        const projected = Number(customer.account_balance || 0) + authoritativeSubtotal + authoritativeTax - discount - storeCredit;
        if (Number(customer.credit_limit || 0) > 0 && projected - Number(customer.credit_limit) > 0.01) return res.status(400).json({error:'Sale would exceed the customer credit limit'});
      }
      if ((method === 'card' || method === 'bank_transfer') && !String(body.approval_code || '').trim()) return res.status(400).json({error:`${method === 'card' ? 'Card' : 'Bank transfer'} payment requires an approval/reference code`});
      const totalBeforeCashback = authoritativeSubtotal + authoritativeTax - discount - storeCredit;
      if (method === 'cash' && Number(body.amount_tendered || totalBeforeCashback) + 0.001 < totalBeforeCashback) return res.status(400).json({error:'Cash tendered cannot be less than the sale total'});
    }

    req.retailCheckoutEvidence = {authoritativeSubtotal,authoritativeTax,validatedAt:new Date().toISOString()};
    next();
  } catch (e) {
    res.status(500).json({error:e.message});
  }
});

module.exports = router;
