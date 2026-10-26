'use strict';

const crypto = require('crypto');
const { can } = require('./permissions');

const VERSION = 'v2';
const ISSUER = 'total-tools-pos';
const AUDIENCE = 'total-tools-ai';
const MAX_TTL_SECONDS = 120;
const DEFAULT_TTL_SECONDS = 60;

const TT_AI_CAPABILITIES = [
  'inventory','rentals','work_orders','purchasing','reports_financial',
  'quotations','pos','multi_branch_access','settings_integrations',
];

function normalizePrivateKey(value) {
  if (typeof value !== 'string' || !value.includes('BEGIN PRIVATE KEY')) {
    throw new Error('TT_AI_ASSERTION_PRIVATE_KEY_INVALID');
  }
  const key = crypto.createPrivateKey(value.replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('TT_AI_ASSERTION_PRIVATE_KEY_INVALID');
  return key;
}

function effectiveCapabilities(permissions) {
  return TT_AI_CAPABILITIES.filter(key => can(permissions || {}, key));
}

function createTTAIStaffAssertion({
  employee,
  branchId,
  requestId,
  privateKey = process.env.TT_AI_SIGNING_PRIVATE_KEY,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now(),
} = {}) {
  if (!employee?.id) throw new Error('TT_AI_EMPLOYEE_REQUIRED');
  const resolvedBranchId = branchId ?? employee.default_branch_id;
  if (resolvedBranchId === undefined || resolvedBranchId === null || resolvedBranchId === '') {
    throw new Error('TT_AI_BRANCH_REQUIRED');
  }
  if (!requestId) throw new Error('TT_AI_REQUEST_ID_REQUIRED');

  const ttl = Number(ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new Error('TT_AI_ASSERTION_TTL_INVALID');
  }

  const iat = Math.floor(now / 1000);
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: String(employee.id),
    branch_id: String(resolvedBranchId),
    permissions: effectiveCapabilities(employee.permissions),
    request_id: String(requestId),
    nonce: crypto.randomBytes(16).toString('base64url'),
    iat,
    exp: iat + ttl,
  };

  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signingInput = `${VERSION}.${payload}`;
  const signature = crypto.sign(
    null,
    Buffer.from(signingInput, 'utf8'),
    normalizePrivateKey(privateKey)
  ).toString('base64url');

  return {
    token: `${signingInput}.${signature}`,
    expires_at: new Date((iat + ttl) * 1000).toISOString(),
    capabilities: claims.permissions,
    branch_id: claims.branch_id,
  };
}

module.exports = {
  createTTAIStaffAssertion,
  effectiveCapabilities,
  TT_AI_CAPABILITIES,
  TT_AI_ASSERTION_CONTRACT: {
    version: VERSION,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'Ed25519',
    maxTtlSeconds: MAX_TTL_SECONDS,
    defaultTtlSeconds: DEFAULT_TTL_SECONDS,
  },
};
