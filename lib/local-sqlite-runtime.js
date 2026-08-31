'use strict';

// Production can point TURSO_DATABASE_URL at a local persisted SQLite file
// (for example file:/app/data/pos.db). database.js historically treated any
// configured TURSO_DATABASE_URL as remote Turso and therefore skipped its
// local WAL / busy-timeout tuning. This preload keeps remote Turso untouched
// while ensuring configured file: URLs tune the same shared application
// client before schema initialization begins.
const database = require('../database');

const configuredUrl = String(process.env.TURSO_DATABASE_URL || '').trim();

if (configuredUrl.startsWith('file:')) {
  const originalEnsureReady = database.ensureReady;
  let tuningPromise = null;

  async function ensureConfiguredLocalSqliteTuning() {
    if (!tuningPromise) {
      tuningPromise = (async () => {
        await database.db.execute({ sql: 'PRAGMA journal_mode=WAL', args: [] });
        await database.db.execute({ sql: 'PRAGMA busy_timeout=5000', args: [] });
      })().catch((error) => {
        tuningPromise = null;
        throw error;
      });
    }
    return tuningPromise;
  }

  database.ensureReady = async function ensureReadyWithConfiguredLocalSqliteTuning() {
    await ensureConfiguredLocalSqliteTuning();
    return originalEnsureReady();
  };
}
