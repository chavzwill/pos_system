'use strict';

const { db, ensureReady } = require('../database');
const {
  SECRET_SETTING_KEYS,
  isEncryptedSettingValue,
  encryptionKey,
  protectSettingValue,
  revealSettingValue,
} = require('../lib/secureSettings');

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    console.log('Production settings-secret preflight skipped outside NODE_ENV=production.');
    return;
  }

  await ensureReady();
  const keys = [...SECRET_SETTING_KEYS];
  const marks = keys.map(() => '?').join(',');
  const { rows } = await db.execute({
    sql: `SELECT key,value FROM settings WHERE key IN (${marks})`,
    args: keys,
  });
  const configured = rows.filter(row => row.value != null && String(row.value) !== '');
  if (!configured.length) {
    console.log('Production settings-secret preflight passed; no stored integration secrets require encryption.');
    return;
  }

  encryptionKey({ required: true });
  const tx = await db.transaction('write');
  let migrated = 0;
  try {
    for (const row of configured) {
      if (isEncryptedSettingValue(row.value)) {
        revealSettingValue(row.key, row.value); // Authentication/tag check; fails closed on wrong key or corrupt ciphertext.
        continue;
      }
      const protectedValue = protectSettingValue(row.key, row.value);
      const result = await tx.execute({
        sql: 'UPDATE settings SET value=? WHERE key=? AND value=?',
        args: [protectedValue, row.key, row.value],
      });
      if (Number(result.rowsAffected || 0) !== 1) {
        throw new Error(`Setting ${row.key} changed concurrently during encryption migration.`);
      }
      migrated += 1;
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }

  console.log(`Production settings-secret preflight passed; migrated ${migrated} legacy plaintext secret setting(s) to authenticated encryption.`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(`SECURITY SETTINGS BLOCK: ${error.message || error}`);
  process.exit(1);
});
