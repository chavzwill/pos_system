import { test, expect } from '@playwright/test';
import { toBaseQuantity } from '../lib/unit-of-measure.js';

test('historical purchase UOM factor remains authoritative for receipt conversion', async () => {
  const frozen = { factor_to_base: 12, profile: { base_uom: 'each', base_precision: 0 } };
  const changedCatalog = { factor_to_base: 10, profile: { base_uom: 'each', base_precision: 0 } };
  expect(toBaseQuantity(4, frozen)).toBe(48);
  expect(toBaseQuantity(4, changedCatalog)).toBe(40);
  expect(toBaseQuantity(4, frozen)).not.toBe(toBaseQuantity(4, changedCatalog));
});
