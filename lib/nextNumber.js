// Concurrency-safe sequential document number allocator.
//
// The legacy MAX(existing)+1 allocator was gap-safe but racy: two concurrent
// requests could observe the same maximum and both return the same number.
// This allocator serializes each logical sequence through one SQLite/Turso
// UPSERT statement and also reconciles against existing rows so imported or
// legacy higher numbers cannot move the sequence backwards.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value, label) {
  if (!IDENTIFIER.test(String(value || ''))) {
    throw new Error(`Invalid ${label} identifier`);
  }
}

async function ensureSequenceTable(executor) {
  await executor.execute({
    sql: `CREATE TABLE IF NOT EXISTS document_number_sequences (
      sequence_key TEXT PRIMARY KEY,
      current_value INTEGER NOT NULL CHECK (current_value >= 0),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    args: [],
  });
}

async function nextNumber(executor, table, column, prefix, padLength = 6) {
  assertIdentifier(table, 'table');
  assertIdentifier(column, 'column');
  if (!executor || typeof executor.execute !== 'function') {
    throw new Error('A database executor is required');
  }
  if (typeof prefix !== 'string' || !prefix.length) {
    throw new Error('A non-empty document prefix is required');
  }
  if (!Number.isInteger(padLength) || padLength < 1 || padLength > 18) {
    throw new Error('padLength must be an integer between 1 and 18');
  }

  await ensureSequenceTable(executor);

  const sequenceKey = `${table}:${column}:${prefix}`;
  const sql = `
    INSERT INTO document_number_sequences (sequence_key, current_value, updated_at)
    VALUES (
      ?,
      (SELECT COALESCE(MAX(CAST(SUBSTR(${column}, ?) AS INTEGER)), 0) + 1
         FROM ${table}
        WHERE ${column} LIKE ?),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(sequence_key) DO UPDATE SET
      current_value = MAX(
        document_number_sequences.current_value + 1,
        (SELECT COALESCE(MAX(CAST(SUBSTR(${column}, ?) AS INTEGER)), 0) + 1
           FROM ${table}
          WHERE ${column} LIKE ?)
      ),
      updated_at = CURRENT_TIMESTAMP
    RETURNING current_value
  `;

  const { rows } = await executor.execute({
    sql,
    args: [
      sequenceKey,
      prefix.length + 1,
      `${prefix}%`,
      prefix.length + 1,
      `${prefix}%`,
    ],
  });

  const allocated = Number(rows?.[0]?.current_value);
  if (!Number.isSafeInteger(allocated) || allocated < 1) {
    throw new Error(`Unable to allocate document number for ${sequenceKey}`);
  }

  return `${prefix}${String(allocated).padStart(padLength, '0')}`;
}

module.exports = { nextNumber };
