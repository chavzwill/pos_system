'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { requireAuth } = require('../lib/permissions');

const DEFAULTS = Object.freeze({ display_mode: 'system', density: 'comfortable', accent: 'company' });
const ALLOWED = {
  display_mode: new Set(['system', 'light', 'dark']),
  density: new Set(['comfortable', 'compact']),
  accent: new Set(['company', 'blue', 'teal', 'violet'])
};
async function ensureTable() {
  await db.execute({ sql: `CREATE TABLE IF NOT EXISTS employee_ui_preferences (
    employee_id INTEGER PRIMARY KEY,
    display_mode TEXT NOT NULL DEFAULT 'system',
    density TEXT NOT NULL DEFAULT 'comfortable',
    accent TEXT NOT NULL DEFAULT 'company',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`, args: [] });
}
function protect(req, res) {
  if (req.apiKey || !Number.isSafeInteger(Number(req.employee?.id)) || Number(req.employee?.id) <= 0) {
    res.status(403).json({ error: 'A signed-in employee is required' });
    return false;
  }
  return true;
}
router.get('/', requireAuth, async (req, res) => {
  if (!protect(req, res)) return;
  try {
    await ensureTable();
    const { rows } = await db.execute({ sql: 'SELECT display_mode,density,accent FROM employee_ui_preferences WHERE employee_id=?', args: [req.employee.id] });
    res.set('Cache-Control', 'private, no-store');
    res.json({ ...DEFAULTS, ...(rows[0] || {}) });
  } catch (_) { res.status(500).json({ error: 'Unable to load appearance preferences' }); }
});
router.put('/', requireAuth, async (req, res) => {
  if (!protect(req, res)) return;
  const body = req.body || {};
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).some(key => !Object.prototype.hasOwnProperty.call(ALLOWED, key))) {
    return res.status(400).json({ error: 'Unsupported appearance preference' });
  }
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED[key].has(value)) return res.status(400).json({ error: 'Invalid value for ' + key });
  }
  try {
    await ensureTable();
    const { rows } = await db.execute({ sql: 'SELECT display_mode,density,accent FROM employee_ui_preferences WHERE employee_id=?', args: [req.employee.id] });
    const next = { ...DEFAULTS, ...(rows[0] || {}), ...body };
    await db.execute({
      sql: `INSERT INTO employee_ui_preferences (employee_id,display_mode,density,accent)
      VALUES (?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET display_mode=excluded.display_mode,
      density=excluded.density,accent=excluded.accent,updated_at=CURRENT_TIMESTAMP`,
      args: [req.employee.id, next.display_mode, next.density, next.accent]
    });
    res.json(next);
  } catch (_) { res.status(500).json({ error: 'Unable to save appearance preferences' }); }
});
module.exports = router;
