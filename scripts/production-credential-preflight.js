'use strict';

const bcrypt = require('bcryptjs');
const { db, ensureReady } = require('../database');

const USERNAME = String(process.env.POS_BOOTSTRAP_ADMIN_USER || 'admin').trim();
const BOOTSTRAP_PASSWORD = String(process.env.POS_BOOTSTRAP_ADMIN_PASSWORD || '');
const BOOTSTRAP_PIN = String(process.env.POS_BOOTSTRAP_ADMIN_PIN || '');
const COMMON_PASSWORDS = ['123456','12345678','password','password1','admin','admin123','letmein','qwerty','welcome','totaltools'];
const COMMON_PINS = new Set(['000000','111111','123456','654321','121212','112233','999999']);

function strongPassword(value) {
  const v = String(value || '');
  return v.length >= 12 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v) && !COMMON_PASSWORDS.includes(v.toLowerCase());
}
function strongPin(value) {
  const v = String(value || '');
  if (!/^\d{6,10}$/.test(v)) return false;
  if (COMMON_PINS.has(v)) return false;
  if (/^(\d)\1+$/.test(v)) return false;
  if ('01234567890'.includes(v) || '09876543210'.includes(v)) return false;
  return true;
}
function isBcrypt(value) { return typeof value === 'string' && /^\$2[aby]\$/.test(value); }

async function passwordIsKnownWeak(stored) {
  if (!stored) return true;
  if (!isBcrypt(stored)) return COMMON_PASSWORDS.includes(String(stored).toLowerCase()) || String(stored).length < 12;
  for (const weak of COMMON_PASSWORDS) {
    if (await bcrypt.compare(weak, stored)) return true;
  }
  return false;
}
async function pinIsKnownWeak(stored) {
  if (!stored) return true;
  if (!isBcrypt(stored)) return !strongPin(stored);
  for (const weak of COMMON_PINS) {
    if (await bcrypt.compare(weak, stored)) return true;
  }
  return false;
}

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    console.log('Production credential preflight skipped outside NODE_ENV=production.');
    return;
  }

  await ensureReady();
  const { rows: [admin] } = await db.execute({
    sql: 'SELECT id, username, password, pin, active FROM employees WHERE username = ?',
    args: [USERNAME],
  });
  if (!admin || admin.active === 0) {
    throw new Error(`Production admin account "${USERNAME}" is missing or inactive.`);
  }

  const weakPassword = await passwordIsKnownWeak(admin.password);
  const weakPin = await pinIsKnownWeak(admin.pin);
  const plaintextStrongPin = Boolean(admin.pin) && !isBcrypt(admin.pin) && !weakPin;
  if (!weakPassword && !weakPin && !plaintextStrongPin) {
    console.log(`Production credential preflight passed for ${USERNAME}.`);
    return;
  }

  if (weakPassword && !strongPassword(BOOTSTRAP_PASSWORD)) {
    throw new Error('Production admin password is missing/weak. Set POS_BOOTSTRAP_ADMIN_PASSWORD to a 12+ character mixed-case, numeric and symbol password for the first secured startup.');
  }
  if (weakPin && !strongPin(BOOTSTRAP_PIN)) {
    throw new Error('Production admin PIN is missing/weak. Set POS_BOOTSTRAP_ADMIN_PIN to a non-obvious 6-10 digit PIN for the first secured startup.');
  }

  const assignments = [];
  const args = [];
  if (weakPassword) {
    assignments.push('password = ?', 'must_change_password = 1');
    args.push(await bcrypt.hash(BOOTSTRAP_PASSWORD, 12));
  }
  if (weakPin) {
    assignments.push('pin = ?');
    args.push(await bcrypt.hash(BOOTSTRAP_PIN, 12));
  } else if (plaintextStrongPin) {
    assignments.push('pin = ?');
    args.push(await bcrypt.hash(admin.pin, 12));
  }
  args.push(admin.id);
  await db.execute({ sql: `UPDATE employees SET ${assignments.join(', ')} WHERE id = ?`, args });
  await db.execute({ sql: "UPDATE sessions SET revoked_at = datetime('now') WHERE employee_id = ? AND revoked_at IS NULL", args: [admin.id] }).catch(() => {});

  console.log(`Production bootstrap credentials hardened for ${USERNAME}. Remove POS_BOOTSTRAP_ADMIN_PASSWORD and POS_BOOTSTRAP_ADMIN_PIN from the environment after successful first startup, then change the password through the POS.`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(`SECURITY STARTUP BLOCK: ${err.message || err}`);
  process.exit(1);
});
