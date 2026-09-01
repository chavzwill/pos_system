'use strict';
const bcrypt = require('bcryptjs');
const { db } = require('../database');

const PIN_COST = 12;

function isBcryptPin(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

function validPin(value) {
  return /^\d{6,10}$/.test(String(value || ''));
}

async function hashPin(pin) {
  if (!validPin(pin)) throw new Error('PIN must be 6 to 10 digits');
  return bcrypt.hash(String(pin), PIN_COST);
}

async function verifyPin(stored, supplied) {
  if (!stored || !validPin(supplied)) return false;
  if (isBcryptPin(stored)) return bcrypt.compare(String(supplied), stored);
  // Transitional compatibility only. Production startup migrates plaintext
  // employee PINs before the application comes online.
  return String(stored) === String(supplied);
}

async function upgradeLegacyPin(employeeId, stored, supplied) {
  if (!employeeId || isBcryptPin(stored)) return false;
  if (!await verifyPin(stored, supplied)) return false;
  const hashed = await hashPin(supplied);
  const result = await db.execute({
    sql: 'UPDATE employees SET pin=? WHERE id=? AND pin=?',
    args: [hashed, employeeId, stored],
  });
  return Number(result.rowsAffected || 0) > 0;
}

async function findEmployeeByPin(rows, supplied, predicate = () => true) {
  if (!validPin(supplied)) return null;
  for (const row of rows || []) {
    if (!predicate(row)) continue;
    if (await verifyPin(row.pin, supplied)) {
      await upgradeLegacyPin(row.id, row.pin, supplied).catch(() => {});
      return row;
    }
  }
  return null;
}

module.exports = {
  PIN_COST,
  isBcryptPin,
  validPin,
  hashPin,
  verifyPin,
  upgradeLegacyPin,
  findEmployeeByPin,
};
