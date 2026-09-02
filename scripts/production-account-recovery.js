'use strict';

const bcrypt = require('bcryptjs');
const { db, ensureReady } = require('../database');
const { can } = require('../lib/permissions');
const { ensureSecurityAuditTable, recordSecurityAudit } = require('../lib/securityAudit');
const { strongPassword, passwordPolicyError } = require('../lib/passwordPolicy');
const { destroyEmployeeSessions } = require('../lib/sessionAuth');

const USERNAME = String(process.env.POS_RECOVERY_USERNAME || 'admin').trim();
const TEMPORARY_PASSWORD = String(process.env.POS_RECOVERY_PASSWORD || '');
const REASON = String(process.env.POS_RECOVERY_REASON || '').trim();
const CONFIRM = String(process.env.POS_RECOVERY_CONFIRM || '');

function parsePermissions(value) {
  try { return value && typeof value === 'object' ? value : JSON.parse(value || '{}'); }
  catch (_) { return {}; }
}

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('Production account recovery only runs with NODE_ENV=production.');
  }
  if (CONFIRM !== 'RESET') {
    throw new Error('Set POS_RECOVERY_CONFIRM=RESET to acknowledge this privileged recovery operation.');
  }
  if (!USERNAME) throw new Error('POS_RECOVERY_USERNAME is required.');
  if (!strongPassword(TEMPORARY_PASSWORD)) throw new Error(passwordPolicyError(TEMPORARY_PASSWORD));
  if (REASON.length < 8) throw new Error('POS_RECOVERY_REASON must explain why privileged account recovery is required.');

  await ensureReady();
  const { rows: [target] } = await db.execute({
    sql: `SELECT e.id,e.username,e.active,e.must_change_password,sg.permissions
      FROM employees e LEFT JOIN security_groups sg ON sg.id=e.security_group_id
      WHERE e.username=?`,
    args: [USERNAME],
  });
  if (!target || Number(target.active) === 0) throw new Error(`Recovery target "${USERNAME}" is missing or inactive.`);
  if (!can(parsePermissions(target.permissions), 'security_manage')) {
    throw new Error('Production account recovery is restricted to an active Security Management administrator.');
  }

  await ensureSecurityAuditTable();
  const hash = await bcrypt.hash(TEMPORARY_PASSWORD, 12);
  const tx = await db.transaction('write');
  try {
    await tx.execute({ sql: 'UPDATE employees SET password=?,must_change_password=1 WHERE id=?', args: [hash, target.id] });
    await destroyEmployeeSessions(target.id, tx);
    await recordSecurityAudit({
      action: 'operator_password_recovery',
      targetType: 'employee',
      targetId: target.id,
      oldValue: { must_change_password: Number(target.must_change_password || 0) },
      newValue: { must_change_password: 1, sessions_revoked: true },
      reason: REASON,
      control: 'production_account_recovery',
      executor: tx,
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }

  console.log(`Production recovery completed for ${USERNAME}. All sessions were revoked and the temporary password must be changed at next login.`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(`SECURITY RECOVERY BLOCK: ${error.message || error}`);
  process.exit(1);
});
