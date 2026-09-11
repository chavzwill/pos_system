const { test, expect } = require('@playwright/test');
const { db, ensureReady } = require('../database');
const { nextNumber } = require('../lib/nextNumber');

test.describe('Document number allocation concurrency', () => {
  test('simultaneous allocators never return the same number', async () => {
    await ensureReady();
    const prefix = `RACE-${Date.now()}-`;
    const allocations = await Promise.all(
      Array.from({ length: 24 }, () => nextNumber(db, 'employees', 'employee_number', prefix, 4)),
    );

    expect(new Set(allocations).size).toBe(allocations.length);
    const numeric = allocations.map(value => Number(value.slice(prefix.length))).sort((a, b) => a - b);
    expect(numeric).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
  });

  test('invalid dynamic SQL identifiers fail closed', async () => {
    await ensureReady();
    await expect(nextNumber(db, 'employees; DROP TABLE employees', 'employee_number', 'X-', 4)).rejects.toThrow(/Invalid table/);
    await expect(nextNumber(db, 'employees', 'employee_number;--', 'X-', 4)).rejects.toThrow(/Invalid column/);
  });
});