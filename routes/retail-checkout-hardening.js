'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requirePermission, can } = require('../lib/permissions');
const { getAvailableQty } = require('../lib/inventory-stock-status');
const { getReservedQty } = require('../lib/inventory-reservations');
const { withLifecycleLocks } = require('../lib/lifecycleLock');

// Commercial loss prevention must run after virtual-bundle/UOM normalization
// (the parent traceability router already did that) but before general stock
// reservation, so a blocked below-floor sale does not unnecessarily hold stock.
router.use(require('./retail-margin-protection'));
router.use(require('./retail-inventory-reservation'));
// Preserve historical cost evidence around the authoritative checkout response.
// Accounting must never derive historical retail COGS from a later catalog cost.
router.use(require('./retail-cost-snapshot'));

const allowedPayments = new Set(['cash','card','credit','bank_transfer']);
const asMoney = v => Number.parseFloat(v || 0);
let promotionUsageReady = null;

function canOperateCrossBranch(employee) {
  if (!employee) return false;
  return can(employee.permissions, 'branches') || can(employee.permissions, 'security_manage');
}

async function ensurePromotionUsageIntegrity() {
  if (promotionUsageReady) return promotionUsageReady;
  promotionUsageReady = db.batch([
    { sql: `CREATE TRIGGER IF NOT EXISTS trg_transaction_promotion_usage
      AFTER INSERT ON transactions
      WHEN NEW.status='completed' AND NEW.promotion_code IS NOT NULL AND TRIM(NEW.promotion_code)<>''
      BEGIN
        UPDATE promotion_codes
        SET times_used=COALESCE(times_used,0)+1
        WHERE UPPER(code)=UPPER(NEW.promotion_code);
      END` },
  ], 'write').catch(error => { promotionUsageReady = null; throw error; });
  return promotionUsageReady;
}

async function promotionLockKeys(req) {
  const keys = [];
  if (req.body?.customer_id) keys.push(`customer-commerce:${Number(req.body.customer_id)}`);
  const code = String(req.body?.promotion_code || '').trim();
  if (code) {
    const { rows: [row] } = await db.execute({ sql: 'SELECT id FROM promotion_codes WHERE code=? COLLATE NOCASE', args: [code] });
    keys.push(`promotion-code:${row?.id || code.toUpperCase()}`);
  }
  return keys;
}

function promotionDiscount(promo, eligibleAmount) {
  const value = Number(promo.value);
  if (!Number.isFinite(value) || value < 0) throw new Error('Promotion value is invalid');
  if (promo.type === 'percentage') {
    if (value > 100) throw new Error('Promotion percentage cannot exceed 100%');
    return Number((eligibleAmount * value / 100).toFixed(2));
  }
  if (promo.type === 'fixed') return Number(Math.min(value, eligibleAmount).toFixed(2));
  throw new Error('Promotion type is invalid');
}

async function validatePromotionAtCheckout(body, authoritativeSubtotal, authoritativeLines) {
  const code = String(body.promotion_code || '').trim();
  if (!code) {
    if (String(body.promotion_name || '').trim()) return { error: 'Promotion name cannot be supplied without a promotion code' };
    return { discount: asMoney(body.discount_amount), evidence: null };
  }

  const { rows: [promo] } = await db.execute({ sql: `
    SELECT pc.id AS code_id, pc.code, pc.active AS code_active, pc.usage_limit, pc.times_used,
           p.id AS promotion_id, p.name, p.type, p.value, p.min_purchase, p.applies_to,
           p.start_date, p.end_date, p.active AS promotion_active
    FROM promotion_codes pc
    JOIN promotions p ON p.id=pc.promotion_id
    WHERE pc.code=? COLLATE NOCASE`, args: [code] });
  if (!promo) return { error: 'Promotion code is invalid or no longer exists' };
  if (!promo.code_active || !promo.promotion_active) return { error: 'Promotion code is inactive' };

  const today = new Date().toISOString().slice(0,10);
  if (promo.start_date && today < promo.start_date) return { error: 'Promotion has not started yet' };
  if (promo.end_date && today > promo.end_date) return { error: 'Promotion has expired' };
  if (promo.usage_limit != null && Number(promo.times_used || 0) >= Number(promo.usage_limit)) return { error: 'Promotion code has reached its usage limit' };
  if (Number(promo.min_purchase || 0) > authoritativeSubtotal + 0.001) return { error: `Promotion requires a minimum merchandise subtotal of ${Number(promo.min_purchase).toFixed(2)}` };

  let eligibleAmount = authoritativeSubtotal;
  if (['specific','categories','items'].includes(String(promo.applies_to || ''))) {
    const { rows: assignments } = await db.execute({ sql: 'SELECT item_type,item_id FROM promotion_items WHERE promotion_id=?', args: [promo.promotion_id] });
    const productIds = new Set(assignments.filter(x => x.item_type === 'product').map(x => Number(x.item_id)));
    const categoryIds = new Set(assignments.filter(x => x.item_type === 'category').map(x => Number(x.item_id)));
    eligibleAmount = authoritativeLines.reduce((sum, line) => {
      const productMatch = promo.applies_to !== 'categories' && productIds.has(Number(line.product_id));
      const categoryMatch = promo.applies_to !== 'items' && categoryIds.has(Number(line.category_id));
      return sum + (productMatch || categoryMatch ? Number(line.lineTotal) : 0);
    }, 0);
    eligibleAmount = Number(eligibleAmount.toFixed(2));
    if (eligibleAmount <= 0) return { error: 'No item in the current cart qualifies for this promotion' };
  }

  let authoritativeDiscount;
  try { authoritativeDiscount = promotionDiscount(promo, eligibleAmount); }
  catch (error) { return { error: error.message }; }
  const requested = asMoney(body.discount_amount);
  if (!Number.isFinite(requested) || Math.abs(requested - authoritativeDiscount) > 0.01) {
    return { error: `Promotion pricing changed. Expected discount ${authoritativeDiscount.toFixed(2)}; refresh the promotion before completing the sale.` };
  }

  body.promotion_code = String(promo.code).trim().toUpperCase();
  body.promotion_name = promo.name;
  body.discount_amount = authoritativeDiscount;
  return {
    discount: authoritativeDiscount,
    evidence: {
      code_id: Number(promo.code_id),
      promotion_id: Number(promo.promotion_id),
      code: body.promotion_code,
      name: promo.name,
      eligible_amount: eligibleAmount,
      discount_amount: authoritativeDiscount,
      usage_before: Number(promo.times_used || 0),
      usage_limit: promo.usage_limit == null ? null : Number(promo.usage_limit),
      validated_at: new Date().toISOString(),
    },
  };
}

router.post('/',
  withLifecycleLocks(promotionLockKeys, {ttlSeconds:120,label:'customer checkout or promotion redemption'}),
  requirePermission('pos'), async (req,res,next) => {
  try {
    await ensurePromotionUsageIntegrity();
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({error:'No items in transaction'});
    if (!req.apiKey && !body.branch_id) return res.status(400).json({error:'A selling branch is required for a POS transaction'});

    if (!req.apiKey && req.employee) {
      body.employee_id = req.employee.id;
      if (req.employee.default_branch_id && String(body.branch_id) !== String(req.employee.default_branch_id) && !canOperateCrossBranch(req.employee)) {
        return res.status(403).json({error:'You cannot complete a sale for another branch. Switch to your assigned branch or ask an authorized cross-branch administrator.'});
      }
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

    const storeCredit = asMoney(body.store_credit_applied);
    const requestedCashBack = asMoney(body.cash_back_applied);
    if (!Number.isFinite(storeCredit) || storeCredit < 0) return res.status(400).json({error:'Store credit amount cannot be negative'});
    if (!Number.isFinite(requestedCashBack) || requestedCashBack < 0) return res.status(400).json({error:'Cash-back amount cannot be negative'});

    let authoritativeSubtotal = 0;
    let authoritativeTax = 0;
    const authoritativeLines = [];
    for (const line of items) {
      const qty = Number(line.quantity);
      if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({error:'Sale quantities must be positive whole numbers after UOM conversion'});
      const {rows:[product]} = await db.execute({sql:'SELECT * FROM products WHERE id=?',args:[line.product_id]});
      if (!product || !product.active) return res.status(400).json({error:`Product ${line.product_id} is unavailable`});
      if (product.is_service || product.is_rental) return res.status(400).json({error:`${product.name} cannot be sold through standard retail checkout`});

      if (body.branch_id && !line.variation_id) {
        const state = await getAvailableQty(db, line.product_id, body.branch_id, {excludeReservationKey:req.inventoryReservationKey||null});
        if (state.available < qty) return res.status(409).json({error:`Not enough available ${product.name} at the selected branch (${state.available} sellable; ${state.restricted} restricted; ${state.reserved||0} reserved)`});
      }

      let unitPrice = line.uom_base_unit_price != null ? Number(line.uom_base_unit_price) : Number(product.price || 0);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) return res.status(409).json({error:`Authoritative selling price is invalid for ${product.name}`});
      if (line.variation_id) {
        const {rows:[variation]} = await db.execute({sql:'SELECT * FROM product_variations WHERE id=? AND product_id=?',args:[line.variation_id,line.product_id]});
        if (!variation) return res.status(400).json({error:`Variation ${line.variation_id} is unavailable`});
        const otherReserved=body.branch_id?await getReservedQty(db,line.product_id,body.branch_id,{variationId:Number(line.variation_id),excludeReservationKey:req.inventoryReservationKey||null}):0;
        const available = Math.max(0,Number(variation.stock_qty || 0)-otherReserved);
        if (available < qty) return res.status(409).json({error:`Not enough stock for ${product.name} (${available} variation units available after reservations)`});
        unitPrice = variation.price != null ? Number(variation.price) : Number(product.price || 0) + Number(variation.price_modifier || 0);
      } else if (!body.branch_id) {
        const available = Number(product.stock_qty || 0);
        if (available < qty) return res.status(409).json({error:`Not enough stock for ${product.name} (${available} available)`});
      }

      const lineTotal = Number((unitPrice * qty).toFixed(2));
      const lineTax = body.tax_exempt ? 0 : Number((lineTotal * Number(product.tax_rate || 0) / 100).toFixed(2));
      authoritativeSubtotal += lineTotal;
      authoritativeTax += lineTax;
      authoritativeLines.push({ product_id: product.id, category_id: product.category_id, quantity: qty, unit_price: unitPrice, lineTotal });
    }
    authoritativeSubtotal = Number(authoritativeSubtotal.toFixed(2));
    authoritativeTax = Number(authoritativeTax.toFixed(2));

    const promotionValidation = await validatePromotionAtCheckout(body, authoritativeSubtotal, authoritativeLines);
    if (promotionValidation.error) return res.status(409).json({error:promotionValidation.error,control:'promotion_revalidation'});
    const discount = Number(promotionValidation.discount || 0);
    if (!Number.isFinite(discount) || discount < 0) return res.status(400).json({error:'Discount amount cannot be negative'});
    if (discount > authoritativeSubtotal + authoritativeTax) return res.status(400).json({error:'Discount cannot exceed the sale value'});

    let customer = null;
    let authoritativeCashBack = 0;
    if (body.customer_id) {
      const {rows:[row]} = await db.execute({sql:`SELECT c.*, cbct.points_threshold, cbct.reward_amount, cbct.min_redeem_amount, cbct.min_redeem_days, cbct.active AS cash_back_type_active
        FROM customers c LEFT JOIN cash_back_card_types cbct ON c.cash_back_card_type_id=cbct.id
        WHERE c.id=? AND c.active=1`,args:[body.customer_id]});
      if (!row) return res.status(400).json({error:'Selected customer is unavailable'});
      customer = row;
      if (requestedCashBack > 0) {
        const rewardConfig={...row,active:row.cash_back_type_active};
        const accrued = (!rewardConfig.active || !rewardConfig.points_threshold || !rewardConfig.reward_amount) ? 0 : Math.floor(Number(row.loyalty_points||0)/Number(rewardConfig.points_threshold))*Number(rewardConfig.reward_amount);
        let availableCashBack=accrued;
        if (availableCashBack>0 && Number(rewardConfig.min_redeem_amount||0)>0 && availableCashBack<Number(rewardConfig.min_redeem_amount)) availableCashBack=0;
        if (availableCashBack>0 && Number(rewardConfig.min_redeem_days||0)>0 && row.cash_back_last_redeemed_at) {
          const days=(Date.now()-new Date(row.cash_back_last_redeemed_at).getTime())/86400000;
          if (days<Number(rewardConfig.min_redeem_days)) availableCashBack=0;
        }
        if (requestedCashBack-availableCashBack>0.01) return res.status(400).json({error:`Cash-back redemption exceeds the customer's available reward (${Number(availableCashBack||0).toFixed(2)})`});
        authoritativeCashBack=Number(requestedCashBack.toFixed(2));
      }
    } else if (requestedCashBack>0) return res.status(400).json({error:'Cash-back redemption requires a customer'});

    if (storeCredit > 0) {
      if (!customer) return res.status(400).json({error:'Store credit requires a customer'});
      const availableCredit = Math.max(0, -Number(customer.account_balance || 0));
      if (storeCredit - availableCredit > 0.01) return res.status(400).json({error:`Store credit exceeds the customer’s available balance (${availableCredit.toFixed(2)})`});
    }

    const netTotal=Number((authoritativeSubtotal+authoritativeTax-discount-storeCredit-authoritativeCashBack).toFixed(2));
    if(netTotal<0)return res.status(400).json({error:'Credits and rewards cannot exceed the sale total'});
    body.discount_amount=discount;
    body.cash_back_applied=authoritativeCashBack;

    const tenders = Array.isArray(body.tenders) && body.tenders.length ? body.tenders : null;
    if (tenders) {
      let tenderSum=0;
      for (const leg of tenders) {
        if (!allowedPayments.has(leg.method) || leg.method === 'credit') return res.status(400).json({error:'Invalid split-payment method'});
        const amount = asMoney(leg.amount);
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({error:'Split-payment amounts must be greater than zero'});
        if ((leg.method === 'card' || leg.method === 'bank_transfer') && !String(leg.approval_code || '').trim()) return res.status(400).json({error:`${leg.method === 'card' ? 'Card' : 'Bank transfer'} payment requires an approval/reference code`});
        tenderSum+=amount;
      }
      if(Math.abs(Number(tenderSum.toFixed(2))-netTotal)>0.01)return res.status(400).json({error:`Split tender amounts (${tenderSum.toFixed(2)}) do not match the authoritative sale total (${netTotal.toFixed(2)})`});
    } else {
      const method = body.payment_method || 'cash';
      if (!allowedPayments.has(method)) return res.status(400).json({error:'Invalid payment method'});
      if (method === 'credit') {
        if (!customer) return res.status(400).json({error:'Charge Account requires a customer'});
        if (customer.customer_type !== 'credit') return res.status(400).json({error:'Customer does not have a credit account'});
        if (customer.account_blocked) return res.status(400).json({error:'Customer credit account is blocked'});
        const projected = Number(customer.account_balance || 0) + netTotal;
        if (Number(customer.credit_limit || 0) > 0 && projected - Number(customer.credit_limit) > 0.01) return res.status(400).json({error:'Sale would exceed the customer credit limit'});
      }
      if ((method === 'card' || method === 'bank_transfer') && !String(body.approval_code || '').trim()) return res.status(400).json({error:`${method === 'card' ? 'Card' : 'Bank transfer'} payment requires an approval/reference code`});
      if (method === 'cash' && Number(body.amount_tendered ?? netTotal) + 0.001 < netTotal) return res.status(400).json({error:'Cash tendered cannot be less than the sale total'});
    }

    req.retailPromotionEvidence=promotionValidation.evidence;
    req.retailCheckoutEvidence = {authoritativeSubtotal,authoritativeTax,authoritativeCashBack,netTotal,promotion:promotionValidation.evidence,validatedAt:new Date().toISOString(),inventoryReservationKey:req.inventoryReservationKey||null};
    next();
  } catch (e) {
    res.status(500).json({error:e.message});
  }
});

module.exports = router;
module.exports.ensurePromotionUsageIntegrity=ensurePromotionUsageIntegrity;
module.exports.validatePromotionAtCheckout=validatePromotionAtCheckout;
