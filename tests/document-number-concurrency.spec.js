import { test, expect } from '@playwright/test';
import { createClient } from '@libsql/client';
import nextNumberModule from '../lib/nextNumber.js';

const { nextNumber } = nextNumberModule;

async function createProbeDb() {
  const db = createClient({ url: ':memory:' });
  await db.execute({
    sql: `CREATE TABLE probe_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_number TEXT UNIQUE NOT NULL
    )`,
    args: [],
  });
  return db;
}

test.describe('Document number allocation concurrency', () => {
  test('simultaneous allocations are unique and monotonic', async () => {
    const db = await createProbeDb();
    try {
      const allocations = await Promise.all(
        Array.from({ length: 40 }, () => nextNumber(db, 'probe_documents', 'document_number', 'DOC-', 6)),
      );

      expect(new Set(allocations).size).toBe(allocations.length);
      const numeric = allocations.map(value => Number(value.slice('DOC-'.length))).sort((a, b) => a - b);
      expect(numeric).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));

      await db.batch(
        allocations.map(documentNumber => ({
          sql: 'INSERT INTO probe_documents (document_number) VALUES (?)',
          args: [documentNumber],
        })),
        'write',
      );
    } finally {
      db.close();
    }
  });

  test('allocator reconciles forward when legacy or imported data is ahead', async () => {
    const db = await createProbeDb();
    try {
      expect(await nextNumber(db, 'probe_documents', 'document_number', 'DOC-', 6)).toBe('DOC-000001');
      await db.execute({ sql: 'INSERT INTO probe_documents (document_number) VALUES (?)', args: ['DOC-000125'] });
      expect(await nextNumber(db, 'probe_documents', 'document_number', 'DOC-', 6)).toBe('DOC-000126');
    } finally {
      db.close();
    }
  });

  test('rejects interpolated SQL identifiers instead of accepting untrusted names', async () => {
    const db = await createProbeDb();
    try {
      await expect(nextNumber(db, 'probe_documents; DROP TABLE probe_documents', 'document_number', 'DOC-', 6))
        .rejects.toThrow(/Invalid table identifier/);
    } finally {
      db.close();
    }
  });
});
