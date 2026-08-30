const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../database');
const { hashKey } = require('../lib/apiKeyAuth');
const { requirePermission } = require('../lib/permissions');

// API keys are an integration credential, not a general Settings feature.
// Only integration-settings authority may create, rotate or revoke them.
router.use(requirePermission('settings_integrations'));

const VALID_SCOPES = [
  'products:read', 'products:write',
  'customers:read', 'customers:write',
  'orders:read', 'orders:write',
  'repairs:read', 'repairs:write',
];

function validScopes(scopes){
  return Array.isArray(scopes) && scopes.length > 0 && scopes.every(s => VALID_SCOPES.includes(s));
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.execute({
      sql: 'SELECT id, name, key_prefix, scopes, created_at, last_used_at, is_active FROM api_keys ORDER BY created_at DESC',
      args: [],
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { name, scopes = ['products:read'] } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!validScopes(scopes)) return res.status(400).json({ error: 'At least one valid explicit API scope is required' });

    const raw = 'pos_' + crypto.randomBytes(20).toString('hex');
    const prefix = raw.slice(0, 12);
    const hash = hashKey(raw);

    await db.execute({
      sql: 'INSERT INTO api_keys (name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?)',
      args: [name.trim(), prefix, hash, JSON.stringify(scopes)],
    });

    res.status(201).json({ key: raw, prefix, name: name.trim(), scopes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const { name, scopes, is_active } = req.body;
    const updates = [];
    const args = [];

    if (name !== undefined) {
      const trimmed=String(name||'').trim();
      if(!trimmed) return res.status(400).json({error:'Name cannot be empty'});
      updates.push('name = ?'); args.push(trimmed);
    }
    if (scopes !== undefined) {
      if (!validScopes(scopes)) return res.status(400).json({ error: 'At least one valid explicit API scope is required' });
      updates.push('scopes = ?'); args.push(JSON.stringify(scopes));
    }
    if (is_active !== undefined) { updates.push('is_active = ?'); args.push(is_active ? 1 : 0); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    args.push(req.params.id);
    await db.execute({ sql: `UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`, args });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE api_keys SET is_active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
