'use strict';

const crypto = require('crypto');
const { can } = require('./permissions');

const VERSION = 'v1';
const ISSUER = 'total-tools-pos';
const AUDIENCE = 'total-tools-ai';
const MAX_TTL_SECONDS = 120;
const DEFAULT_TTL_SECONDS = 60;

const TT_AI_CAPABILITIES = [
  'inventory',
  'rentals',
  'work_orders',
  'purchasing',
  'reports_financial',
  'quotations',
  'pos',
  'multi_branch_access',
];

function secretBytes(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('TT_AI_ASSERTION_SECRET_TOO_SHORT');
  }
  return Buffer.from(secret, 'utf8');
}

function effectiveCapabilities(permissions) {
  return TT_AI_CAPABILITIES.filter(key => can(permissions || {}, key));
}

function createTTAIStaffAssertion({
  employee,
  branchId,
  requestId,
  secret = process.env.TT_AI_SHARED_SECRET,
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
  const signature = crypto
    .createHmac('sha256', secretBytes(secret))
    .update(signingInput)
    .digest('base64url');

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
    maxTtlSeconds: MAX_TTL_SECONDS,
    defaultTtlSeconds: DEFAULT_TTL_SECONDS,
  },
};
