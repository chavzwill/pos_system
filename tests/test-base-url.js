export const TEST_BASE_URL = String(process.env.POS_TEST_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

export function testUrl(pathname = '') {
  const path = String(pathname || '');
  if (!path) return TEST_BASE_URL;
  return `${TEST_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export function assertSafeMutationTarget() {
  const url = new URL(TEST_BASE_URL);
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (localHosts.has(url.hostname)) return;
  if (process.env.POS_TEST_ALLOW_MUTATIONS === 'YES') return;
  throw new Error(`Refusing mutation-capable test against external POS target ${url.origin} without POS_TEST_ALLOW_MUTATIONS=YES`);
}
