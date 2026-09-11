'use strict';

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value, label) {
  const text = String(value || '');
  if (!SAFE_IDENTIFIER.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

// Allocate document numbers with one authoritative database write.
//
// MAX(existing)+1 is gap-safe but race-prone: two concurrent callers can read
// the same MAX and both attempt the same document number. This allocator keeps
// an independent sequence row per table/column/prefix and advances it through
// a single UPSERT ... RETURNING statement. The observed table MAX is still
// folded into each allocation so imported/manual historical rows cannot leave
// the sequence behind authoritative issued documents.
//
// When called with a transaction executor the sequence increment participates
// in that transaction; when called with the database client directly it is
// still atomic at the sequence-row level.
async function nextNumber(executor, table, column, prefix, padLength = 6) {
  if (!executor || typeof executor.execute !== 'function') throw new Error('A database executor is required');
  const safeTable = assertIdentifier(table, 'table');
  const safeColumn = assertIdentifier(column, 'column');
  const safePrefix = String(prefix || '');
  const safePadLength = Number(padLength);
  if (!safePrefix || safePrefix.length > 64) throw new Error('Invalid prefix');
  if (!Number.isInteger(safePadLength) || safePadLength < 1 || safePadLength > 32) throw new Error('Invalid pad length');

  await executor.execute({
    sql: `CREATE TABLE IF NOT EXISTS document_number_sequences (
      sequence_key TEXT PRIMARY KEY,
      current_value INTEGER NOT NULL CHECK(current_value >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    args: [],
  });

  const sequenceKey = `${safeTable}.${safeColumn}.${safePrefix}`;
  const result = await executor.execute({
    sql: `INSERT INTO document_number_sequences (sequence_key,current_value,updated_at)
      SELECT ?, COALESCE(MAX(CAST(SUBSTR(${safeColumn}, ?) AS INTEGER)),0)+1, CURRENT_TIMESTAMP
      FROM ${safeTable}
      WHERE ${safeColumn} LIKE ?
      ON CONFLICT(sequence_key) DO UPDATE SET
        current_value = MAX(document_number_sequences.current_value + 1, excluded.current_value),
        updated_at = CURRENT_TIMESTAMP
      RETURNING current_value`,
    args: [sequenceKey, safePrefix.length + 1, `${safePrefix}%`],
  });

  const value = Number(result.rows?.[0]?.current_value);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Document number allocation failed');
  return `${safePrefix}${String(value).padStart(safePadLength, '0')}`;
}

module.exports = { nextNumber, assertIdentifier };