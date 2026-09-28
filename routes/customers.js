const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth, requirePermission } = require('../lib/permissions');
const { nextNumber } = require('../lib/nextNumber');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { cloudUpload, cloudDestroy } = require('../lib/cloudinary');
const { can } = require('../lib/permissions');
const { complianceMissing, grantException } = require('../lib/rental-compliance');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Check if a credit customer has exceeded their payment terms and block/unblock accordingly
async function runCreditCheck(customerId) {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [customerId] });
    if (!customer || customer.customer_type !== 'credit') return;

    if (customer.account_balance <= 0) {
      await db.execute({ sql: 'UPDATE customers SET account_blocked = 0 WHERE id = ?', args: [customerId] });
      return;
    }

    const { rows: [oldest] } = await db.execute({ sql: `SELECT MIN(created_at) as oldest_date FROM transactions WHERE customer_id = ? AND payment_method = 'credit' AND status = 'completed'`, args: [customerId] });

    if (!oldest || !oldest.oldest_date) return;

    const daysSince = Math.floor((Date.now() - new Date(oldest.oldest_date).getTime()) / 86400000);
    const exceeded = daysSince > (customer.credit_terms_days || 30);
    await db.execute({ sql: 'UPDATE customers SET account_blocked = ? WHERE id = ?', args: [exceeded ? 1 : 0, customerId] });
  } catch(e) {}
}

// Same logic as runCreditCheck above, but for a whole batch of customers in
// a bounded number of queries (1 SELECT + up to 2 UPDATEs) instead of one
// runCreditCheck() call per customer — GET / below runs this on every
// request (it's used broadly: POS customer picker, CRM, accounts, not just
// the Customers screen), so a per-customer loop here would get slower with
// every credit customer added. Only ever called with ids that already
// passed the `account_balance > 0` filter, so (unlike runCreditCheck) there's
// no "already at zero balance, unblock" branch to replicate.
async function runCreditCheckBatch(customerIds) {
  if (!customerIds.length) return;
  try {
    const placeholders = customerIds.map(() => '?').join(',');
    const { rows } = await db.execute({
      sql: `SELECT c.id, c.credit_terms_days,
              (SELECT MIN(created_at) FROM transactions WHERE customer_id = c.id AND payment_method = 'credit' AND status = 'completed') as oldest_date
            FROM customers c WHERE c.id IN (${placeholders})`,
      args: customerIds,
    });
    const exceededIds = [], okIds = [];
    for (const r of rows) {
      if (!r.oldest_date) continue;
      const daysSince = Math.floor((Date.now() - new Date(r.oldest_date).getTime()) / 86400000);
      (daysSince > (r.credit_terms_days || 30) ? exceededIds : okIds).push(r.id);
    }
    if (exceededIds.length) await db.execute({ sql: `UPDATE customers SET account_blocked = 1 WHERE id IN (${exceededIds.map(() => '?').join(',')})`, args: exceededIds });
    if (okIds.length) await db.execute({ sql: `UPDATE customers SET account_blocked = 0 WHERE id IN (${okIds.map(() => '?').join(',')})`, args: okIds });
  } catch(e) {}
}

// requireAuth only — used broadly (POS customer picker, CRM, accounts),
// not just the Customers management screen itself.
router.get('/', requireAuth, async (req, res) => {
  try {
    // Auto-block any overdue credit customers before returning list
    const { rows: overdue } = await db.execute({ sql: "SELECT id FROM customers WHERE customer_type = 'credit' AND active = 1 AND account_balance > 0", args: [] });
    await runCreditCheckBatch(overdue.map(c => c.id));

    const { search, active } = req.query;
    let sql = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    if (search) {
      sql += ` AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR customer_number LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (active !== undefined) { sql += ' AND active = ?'; params.push(active); }
    sql += ' ORDER BY last_name, first_name';
    const { rows } = await db.execute({ sql, args: params });
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Discount card fields (name/percent/active) come from a LEFT JOIN so the
// POS can decide whether to auto-apply it (discount_card_type_active must
// also be true — deactivating a type retires it for every customer holding
// it without editing each customer record).
// Cash-back fields (points_threshold/reward_amount/redemption gates) join in
// the same way, so POS can compute eligibility client-side without a second
// round trip — see availableCashBack() in public/index.html.
const CUSTOMER_WITH_CARD_SELECT = `SELECT c.*, dct.name as discount_card_type_name, dct.discount_percent as discount_card_percent, dct.active as discount_card_type_active,
  cbct.name as cash_back_card_type_name, cbct.points_threshold as cash_back_points_threshold, cbct.reward_amount as cash_back_reward_amount,
  cbct.min_redeem_amount as cash_back_min_redeem_amount, cbct.min_redeem_days as cash_back_min_redeem_days, cbct.active as cash_back_card_type_active
  FROM customers c LEFT JOIN discount_card_types dct ON c.discount_card_type_id = dct.id
  LEFT JOIN cash_back_card_types cbct ON c.cash_back_card_type_id = cbct.id WHERE c.id = ?`;

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    await runCreditCheck(req.params.id);
    const { rows: [updated] } = await db.execute({ sql: CUSTOMER_WITH_CARD_SELECT, args: [req.params.id] });
    const { rows: transactions } = await db.execute({ sql: 'SELECT * FROM transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', args: [req.params.id] });
    res.json({ ...updated, recent_transactions: transactions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/transactions', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    let sql = 'SELECT * FROM transactions WHERE customer_id = ?';
    const args = [req.params.id];
    if (start) { sql += ' AND date(created_at) >= ?'; args.push(start); }
    if (end) { sql += ' AND date(created_at) <= ?'; args.push(end); }
    sql += ' ORDER BY created_at DESC';
    const { rows: transactions } = await db.execute({ sql, args });
    res.json(transactions);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Validates a customer's discount card fields before insert/update: the card
// type (if given) must exist, and the card number (if given) can't already
// belong to another customer — one active card per customer, enforced here
// since SQLite's ALTER TABLE ADD COLUMN can't add a UNIQUE constraint after
// the fact. Returns an error string, or null if everything checks out.
async function validateDiscountCard(discount_card_type_id, discount_card_number, excludeCustomerId) {
  if (!discount_card_type_id) return null;
  const { rows: [type] } = await db.execute({ sql: 'SELECT id FROM discount_card_types WHERE id = ?', args: [discount_card_type_id] });
  if (!type) return 'Selected discount card type does not exist';
  if (discount_card_number) {
    const { rows: [dupe] } = await db.execute({
      sql: `SELECT id FROM customers WHERE discount_card_number = ? ${excludeCustomerId ? 'AND id != ?' : ''}`,
      args: excludeCustomerId ? [discount_card_number, excludeCustomerId] : [discount_card_number],
    });
    if (dupe) return `Card number ${discount_card_number} is already assigned to another customer`;
  }
  return null;
}

// Same shape/reasoning as validateDiscountCard() above.
async function validateCashBackCard(cash_back_card_type_id, cash_back_card_number, excludeCustomerId) {
  if (!cash_back_card_type_id) return null;
  const { rows: [type] } = await db.execute({ sql: 'SELECT id FROM cash_back_card_types WHERE id = ?', args: [cash_back_card_type_id] });
  if (!type) return 'Selected cash back card type does not exist';
  if (cash_back_card_number) {
    const { rows: [dupe] } = await db.execute({
      sql: `SELECT id FROM customers WHERE cash_back_card_number = ? ${excludeCustomerId ? 'AND id != ?' : ''}`,
      args: excludeCustomerId ? [cash_back_card_number, excludeCustomerId] : [cash_back_card_number],
    });
    if (dupe) return `Card number ${cash_back_card_number} is already assigned to another customer`;
  }
  return null;
}


function importBool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1','true','yes','y','active'].includes(v)) return true;
  if (['0','false','no','n','inactive'].includes(v)) return false;
  return fallback;
}
function importNum(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/,/g,'').trim());
  return Number.isFinite(n) ? n : fallback;
}
function importText(value) {
  const v = String(value ?? '').trim();
  return v || null;
}

router.get('/import/template', requirePermission('customers'), (req, res) => {
  const headers = [
    'customer_number','first_name','last_name','email','phone','address','city','state','zip','notes',
    'customer_type','credit_terms_days','credit_limit','tax_exempt','tax_exemption_number',
    'is_rental_customer','rental_id_type','rental_id_number','rental_address_proof_type','rental_address_proof_details',
    'rental_reference_name','rental_reference_phone','rental_reference_relationship',
    'temporary_rental_exception','exception_days','exception_reason'
  ];
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="customer-import-template.csv"');
  res.send(headers.join(',')+'\n');
});

router.post('/import', requirePermission('customers'), async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No customer rows supplied' });
  if (rows.length > 250) return res.status(400).json({ error: 'Customer import is limited to 250 rows per batch' });

  const wantsTemporaryException = rows.some(r => importBool(r.temporary_rental_exception, false));
  if (wantsTemporaryException) {
    if (req.apiKey) return res.status(403).json({ error: 'API keys cannot grant temporary rental compliance exceptions' });
    if (!req.employee || !can(req.employee.permissions, 'rentals_compliance_exception')) {
      return res.status(403).json({ error: 'Temporary rental exceptions require explicit rental compliance authority' });
    }
  }

  let created = 0, updated = 0, exceptions_created = 0;
  const errors = [], warnings = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] || {};
    const first = importText(row.first_name), last = importText(row.last_name);
    if (!first || !last) { errors.push(`Row ${index + 2}: first and last name are required`); continue; }

    const customerNumber = importText(row.customer_number);
    const tx = await db.transaction('write');
    let rowCreated = false, rowUpdated = false;
    try {
      let existing = null;
      if (customerNumber) {
        const { rows: [found] } = await tx.execute({ sql: 'SELECT * FROM customers WHERE customer_number = ?', args: [customerNumber] });
        existing = found || null;
      }

      const type = String(row.customer_type || existing?.customer_type || 'cash').trim().toLowerCase() === 'credit' ? 'credit' : 'cash';
      const isRental = importBool(row.is_rental_customer, !!existing?.is_rental_customer);
      const values = {
        first_name:first,last_name:last,email:importText(row.email) ?? existing?.email ?? null,phone:importText(row.phone) ?? existing?.phone ?? null,address:importText(row.address) ?? existing?.address ?? null,
        city:importText(row.city) ?? existing?.city ?? null,state:importText(row.state) ?? existing?.state ?? null,zip:importText(row.zip) ?? existing?.zip ?? null,notes:importText(row.notes) ?? existing?.notes ?? null,
        customer_type:type,credit_terms_days:Math.max(1,Math.round(importNum(row.credit_terms_days, existing?.credit_terms_days || 30))),
        credit_limit:Math.max(0,importNum(row.credit_limit, existing?.credit_limit || 0)),tax_exempt:importBool(row.tax_exempt, !!existing?.tax_exempt)?1:0,
        tax_exemption_number:importText(row.tax_exemption_number) ?? existing?.tax_exemption_number ?? null,is_rental_customer:isRental?1:0,
        rental_id_type:isRental?(importText(row.rental_id_type) ?? existing?.rental_id_type ?? null):null,rental_id_number:isRental?(importText(row.rental_id_number) ?? existing?.rental_id_number ?? null):null,
        rental_address_proof_type:isRental?(importText(row.rental_address_proof_type) ?? existing?.rental_address_proof_type ?? null):null,
        rental_address_proof_details:isRental?(importText(row.rental_address_proof_details) ?? existing?.rental_address_proof_details ?? null):null,
        rental_reference_name:isRental?(importText(row.rental_reference_name) ?? existing?.rental_reference_name ?? null):null,
        rental_reference_phone:isRental?(importText(row.rental_reference_phone) ?? existing?.rental_reference_phone ?? null):null,
        rental_reference_relationship:isRental?(importText(row.rental_reference_relationship) ?? existing?.rental_reference_relationship ?? null):null,
      };

      let customerId;
      if (existing) {
        await tx.execute({ sql:`UPDATE customers SET first_name=?,last_name=?,email=?,phone=?,address=?,city=?,state=?,zip=?,notes=?,
          customer_type=?,credit_terms_days=?,credit_limit=?,credit_enabled=?,tax_exempt=?,tax_exemption_number=?,
          is_rental_customer=?,rental_id_type=?,rental_id_number=?,rental_address_proof_type=?,rental_address_proof_details=?,
          rental_reference_name=?,rental_reference_phone=?,rental_reference_relationship=? WHERE id=?`,
          args:[values.first_name,values.last_name,values.email,values.phone,values.address,values.city,values.state,values.zip,values.notes,
            values.customer_type,values.credit_terms_days,values.credit_limit,type==='credit'?1:0,values.tax_exempt,values.tax_exemption_number,
            values.is_rental_customer,values.rental_id_type,values.rental_id_number,values.rental_address_proof_type,values.rental_address_proof_details,
            values.rental_reference_name,values.rental_reference_phone,values.rental_reference_relationship,existing.id] });
        customerId = existing.id; rowUpdated = true;
      } else {
        const number = customerNumber || await nextNumber(tx, 'customers', 'customer_number', 'CUST-', 4);
        const result = await tx.execute({ sql:`INSERT INTO customers
          (customer_number,first_name,last_name,email,phone,address,city,state,zip,notes,customer_type,credit_terms_days,credit_limit,credit_enabled,
           tax_exempt,tax_exemption_number,is_rental_customer,rental_id_type,rental_id_number,rental_address_proof_type,rental_address_proof_details,
           rental_reference_name,rental_reference_phone,rental_reference_relationship)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args:[number,values.first_name,values.last_name,values.email,values.phone,values.address,values.city,values.state,values.zip,values.notes,
            values.customer_type,values.credit_terms_days,values.credit_limit,type==='credit'?1:0,values.tax_exempt,values.tax_exemption_number,
            values.is_rental_customer,values.rental_id_type,values.rental_id_number,values.rental_address_proof_type,values.rental_address_proof_details,
            values.rental_reference_name,values.rental_reference_phone,values.rental_reference_relationship] });
        customerId = Number(result.lastInsertRowid); rowCreated = true;
      }

      const { rows: [customer] } = await tx.execute({ sql: 'SELECT * FROM customers WHERE id=?', args: [customerId] });
      const missing = complianceMissing(customer);
      if (isRental && missing.length) warnings.push(`Row ${index + 2}: ${first} ${last} still needs ${missing.join(', ')}`);

      if (isRental && importBool(row.temporary_rental_exception, false) && missing.length) {
        const days = Math.min(30, Math.max(1, Math.round(importNum(row.exception_days, 14))));
        const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        const reason = importText(row.exception_reason) || `Legacy customer migration: temporary continuity while missing rental compliance information is collected.`;
        await grantException(tx,{customerId,approvedBy:req.employee.id,reason,expiresAt});
        exceptions_created++;
      }
      await tx.commit();
      if (rowCreated) created++;
      if (rowUpdated) updated++;
    } catch (e) {
      try { await tx.rollback(); } catch {}
      errors.push(`Row ${index + 2}: ${e?.message || 'Import failed'}`);
    }
  }
  res.json({ created, updated, exceptions_created, errors, warnings });
});

router.post('/', requirePermission('customers'), async (req, res) => {
  const {
    first_name, last_name, email, phone, address, city, state, zip, notes, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number,
    is_rental_customer, rental_id_type, rental_id_number, rental_address_proof_type, rental_address_proof_details,
    rental_reference_name, rental_reference_phone, rental_reference_relationship,
    discount_card_type_id, discount_card_number,
    cash_back_card_type_id, cash_back_card_number,
  } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' });
  try {
    const cardError = await validateDiscountCard(discount_card_type_id, discount_card_number, null);
    if (cardError) return res.status(400).json({ error: cardError });
    const cashBackCardError = await validateCashBackCard(cash_back_card_type_id, cash_back_card_number, null);
    if (cashBackCardError) return res.status(400).json({ error: cashBackCardError });
    const customer_number = await nextNumber(db, 'customers', 'customer_number', 'CUST-', 4);
    const type = customer_type || 'cash';
    const creditEnabled = type === 'credit' ? 1 : 0;
    const terms = parseInt(credit_terms_days) || 30;
    const limit = parseFloat(credit_limit) || 0;
    const taxExempt = tax_exempt ? 1 : 0;
    const isRentalCust = is_rental_customer ? 1 : 0;
    const result = await db.execute({ sql: `INSERT INTO customers
      (customer_number,first_name,last_name,email,phone,address,city,state,zip,notes,customer_type,credit_terms_days,credit_limit,credit_enabled,tax_exempt,tax_exemption_number,
       is_rental_customer,rental_id_type,rental_id_number,rental_address_proof_type,rental_address_proof_details,rental_reference_name,rental_reference_phone,rental_reference_relationship,
       discount_card_type_id,discount_card_number,cash_back_card_type_id,cash_back_card_number)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [customer_number, first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, notes||null, type, terms, limit, creditEnabled, taxExempt, tax_exemption_number||null,
        isRentalCust, isRentalCust ? (rental_id_type||null) : null, isRentalCust ? (rental_id_number||null) : null, isRentalCust ? (rental_address_proof_type||null) : null, isRentalCust ? (rental_address_proof_details||null) : null,
        isRentalCust ? (rental_reference_name||null) : null, isRentalCust ? (rental_reference_phone||null) : null, isRentalCust ? (rental_reference_relationship||null) : null,
        discount_card_type_id || null, discount_card_type_id ? (discount_card_number || null) : null,
        cash_back_card_type_id || null, cash_back_card_type_id ? (cash_back_card_number || null) : null] });
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [Number(result.lastInsertRowid)] });
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requirePermission('customers'), async (req, res) => {
  const {
    first_name, last_name, email, phone, address, city, state, zip, notes, active, customer_type, credit_terms_days, credit_limit, tax_exempt, tax_exemption_number,
    is_rental_customer, rental_id_type, rental_id_number, rental_address_proof_type, rental_address_proof_details,
    rental_reference_name, rental_reference_phone, rental_reference_relationship,
    discount_card_type_id, discount_card_number,
    cash_back_card_type_id, cash_back_card_number,
  } = req.body;
  try {
    const cardError = await validateDiscountCard(discount_card_type_id, discount_card_number, req.params.id);
    if (cardError) return res.status(400).json({ error: cardError });
    const cashBackCardError = await validateCashBackCard(cash_back_card_type_id, cash_back_card_number, req.params.id);
    if (cashBackCardError) return res.status(400).json({ error: cashBackCardError });
    const type = customer_type || 'cash';
    const creditEnabled = type === 'credit' ? 1 : 0;
    const terms = parseInt(credit_terms_days) || 30;
    const limit = parseFloat(credit_limit) || 0;
    const taxExempt = tax_exempt ? 1 : 0;
    const isRentalCust = is_rental_customer ? 1 : 0;
    await db.execute({ sql: `UPDATE customers SET first_name=?,last_name=?,email=?,phone=?,address=?,city=?,state=?,zip=?,notes=?,active=?,customer_type=?,credit_terms_days=?,credit_limit=?,credit_enabled=?,tax_exempt=?,tax_exemption_number=?,
      is_rental_customer=?,rental_id_type=?,rental_id_number=?,rental_address_proof_type=?,rental_address_proof_details=?,rental_reference_name=?,rental_reference_phone=?,rental_reference_relationship=?,
      discount_card_type_id=?,discount_card_number=?,cash_back_card_type_id=?,cash_back_card_number=? WHERE id=?`,
      args: [first_name, last_name, email||null, phone||null, address||null, city||null, state||null, zip||null, notes||null, active??1, type, terms, limit, creditEnabled, taxExempt, tax_exemption_number||null,
        isRentalCust, isRentalCust ? (rental_id_type||null) : null, isRentalCust ? (rental_id_number||null) : null, isRentalCust ? (rental_address_proof_type||null) : null, isRentalCust ? (rental_address_proof_details||null) : null,
        isRentalCust ? (rental_reference_name||null) : null, isRentalCust ? (rental_reference_phone||null) : null, isRentalCust ? (rental_reference_relationship||null) : null,
        discount_card_type_id || null, discount_card_type_id ? (discount_card_number || null) : null,
        cash_back_card_type_id || null, cash_back_card_type_id ? (cash_back_card_number || null) : null, req.params.id] });
    if (type === 'cash') {
      await db.execute({ sql: 'UPDATE customers SET account_blocked = 0 WHERE id = ?', args: [req.params.id] });
    } else {
      await runCreditCheck(req.params.id);
    }
    const { rows: [row] } = await db.execute({ sql: 'SELECT * FROM customers WHERE id = ?', args: [req.params.id] });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requirePermission('customers'), async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE customers SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload rental customer's ID scan — same Cloudinary-or-local fallback
// pattern as product images (see routes/products.js POST /:id/image).
router.post('/:id/id-scan', requirePermission('customers'), upload.single('id_scan'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { rows: [existing] } = await db.execute({ sql: 'SELECT rental_id_scan_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (existing?.rental_id_scan_path) {
      if (existing.rental_id_scan_path.startsWith('https://')) {
        await cloudDestroy(existing.rental_id_scan_path);
      } else {
        const old = path.join(__dirname, '..', existing.rental_id_scan_path);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }

    const result = await cloudUpload(req.file.buffer, {
      folder: 'pos-system/customer-ids',
      public_id: `customer-${req.params.id}`,
      overwrite: true,
      resource_type: 'image',
    });

    let scanPath;
    if (result) {
      scanPath = result.secure_url;
    } else {
      // Cloudinary not configured — save locally
      const dir = path.join(__dirname, '../uploads/customer-ids');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `customer-${req.params.id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(dir, filename), req.file.buffer);
      scanPath = `/uploads/customer-ids/${filename}`;
    }

    await db.execute({ sql: 'UPDATE customers SET rental_id_scan_path = ? WHERE id = ?', args: [scanPath, req.params.id] });
    res.json({ rental_id_scan_path: scanPath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE rental customer's ID scan
router.delete('/:id/id-scan', requirePermission('customers'), async (req, res) => {
  try {
    const { rows: [customer] } = await db.execute({ sql: 'SELECT rental_id_scan_path FROM customers WHERE id = ?', args: [req.params.id] });
    if (customer?.rental_id_scan_path) {
      if (customer.rental_id_scan_path.startsWith('https://')) {
        await cloudDestroy(customer.rental_id_scan_path);
      } else {
        const filePath = path.join(__dirname, '..', customer.rental_id_scan_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
      await db.execute({ sql: 'UPDATE customers SET rental_id_scan_path = NULL WHERE id = ?', args: [req.params.id] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.runCreditCheck = runCreditCheck;
