'use strict';

const crypto = require('crypto');
const { createTTAIStaffAssertion } = require('./tt-ai-assertion');
const { executeTTAIReadTool } = require('./tt-ai-read-tools');

const MAX_PLAN_STEPS = 3;
const REQUEST_TIMEOUT_MS = 5000;

function configuration() {
  const raw = String(process.env.TT_AI_SERVICE_URL || '').trim();
  if (!raw) throw Object.assign(new Error('TT AI service is not configured'), { code: 'TT_AI_SERVICE_NOT_CONFIGURED', status: 503 });
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('TT AI service URL is invalid'), { code: 'TT_AI_SERVICE_URL_INVALID', status: 503 }); }
  // Configuration is an origin, never a credential-bearing URL or a URL
  // with attacker-controlled path/query/fragment content. Keep v1 routes
  // pinned to the gateway's own known endpoints.
  if (url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    throw Object.assign(new Error('TT AI service URL must be a clean origin'), {
      code: 'TT_AI_SERVICE_URL_INVALID', status: 503,
    });
  }
  const localhost = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw Object.assign(new Error('TT AI service URL protocol is invalid'), { code: 'TT_AI_SERVICE_URL_INVALID', status: 503 });
  }
  if (url.protocol !== 'https:' && !(localhost && process.env.NODE_ENV !== 'production')) {
    throw Object.assign(new Error('TT AI service must use HTTPS outside local development'), { code: 'TT_AI_SERVICE_HTTPS_REQUIRED', status: 503 });
  }
  return url.origin;
}

async function postJson(serviceUrl, path, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${serviceUrl}${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'total-tools-pos/tt-ai-gateway',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `TT AI service returned ${response.status}`);
      error.status = response.status >= 500 ? 502 : response.status;
      error.code = data.error || 'TT_AI_UPSTREAM_ERROR';
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('TT AI service timed out'), { code: 'TT_AI_SERVICE_TIMEOUT', status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const ALLOWED_READ_TOOLS = new Set([
  'pos.products.search', 'pos.rental-machines.search',
  'pos.rental-assets.search', 'pos.rental-asset.read',
]);

function gatewayError(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function validatePlan(plan, branchId = null) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw gatewayError('TT_AI_PLAN_INVALID', 'TT AI returned an empty or invalid evidence plan');
  }
  if (plan.length > MAX_PLAN_STEPS) {
    throw gatewayError('TT_AI_PLAN_TOO_LARGE', 'TT AI requested too many evidence reads');
  }
  for (const step of plan) {
    if (!step || step.source !== 'pos' || !ALLOWED_READ_TOOLS.has(step.tool)) {
      throw gatewayError('TT_AI_SOURCE_NOT_ALLOWED', 'TT AI requested an unsupported read tool', 403);
    }
    const input = step.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw gatewayError('TT_AI_PLAN_INVALID', 'TT AI evidence input is invalid');
    }
    const parameter = step.tool === 'pos.rental-asset.read' ? input.identifier : input.query;
    if (typeof parameter !== 'string' || parameter.trim().length < 2 || parameter.length > 256) {
      throw gatewayError('TT_AI_PLAN_INVALID', 'TT AI evidence lookup identifier is invalid');
    }
    if (branchId != null && String(input.branchId) !== String(branchId)) {
      throw gatewayError('TT_AI_PLAN_BRANCH_MISMATCH', 'TT AI evidence plan requested another branch', 403);
    }
  }
  return plan;
}

function assertReply(reply, requestId, phase) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
      || reply.request_id !== String(requestId)
      || (phase && reply.phase !== phase)) {
    throw gatewayError('TT_AI_REPLY_INVALID', 'TT AI returned an inconsistent query reply');
  }
  return reply;
}

async function postQuery(serviceUrl, token, body) {
  return postJson(serviceUrl, '/v1/query', token, body);
}

async function queryTTAI({ employee, message, requestId = crypto.randomUUID() }) {
  const serviceUrl = configuration();
  const staffToken = () => createTTAIStaffAssertion({
    employee,
    requestId,
    privateKey: process.env.TT_AI_SIGNING_PRIVATE_KEY,
    ttlSeconds: 60,
  }).token;

  const first = assertReply(await postQuery(serviceUrl, staffToken(), { message }), requestId);
  if (first.phase === 'complete') return first;
  if (first.phase !== 'needs_evidence') {
    throw Object.assign(new Error('TT AI returned an unsupported query phase'), { code: 'TT_AI_PHASE_INVALID', status: 502 });
  }

  const evidence = [];
  for (const step of validatePlan(first.plan, employee.default_branch_id)) {
    const data = await executeTTAIReadTool(step.tool, step.input, employee);
    evidence.push({
      tool: step.tool,
      source: 'pos',
      observedAt: new Date().toISOString(),
      data,
    });
  }

  return assertReply(await postQuery(serviceUrl, staffToken(), { message, evidence }), requestId, 'complete');
}


async function getTTAIReadiness() {
  const serviceUrl = configuration();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${serviceUrl}/ready`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'total-tools-pos/tt-ai-gateway',
      },
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 503 && data?.status === 'not_ready') return data;
    if (!response.ok) {
      throw Object.assign(new Error(data.error || `TT AI readiness returned ${response.status}`), {
        code: data.error || 'TT_AI_READINESS_UPSTREAM_ERROR',
        status: 502,
      });
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('TT AI readiness check timed out'), { code: 'TT_AI_SERVICE_TIMEOUT', status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestTTAIAdmin({ employee, path, body = {}, requestId = crypto.randomUUID() }) {
  const serviceUrl = configuration();
  const safePath = String(path || '');
  // Require an unambiguous route on the fixed TT AI origin. URL parsing
  // normalizes dot-segments, so reject any path altered by normalization.
  let parsed;
  try { parsed = new URL(safePath, 'https://tt-ai.internal'); } catch (_) {}
  if (!/^\/v1\/admin\/knowledge\/(?:catalog-links|technical-proposals)(?:\/|$)/.test(safePath)
      || !parsed || parsed.pathname !== safePath || parsed.search || parsed.hash) {
    throw Object.assign(new Error('TT AI admin path is not allowed'), { code: 'TT_AI_ADMIN_PATH_NOT_ALLOWED', status: 400 });
  }
  const token = createTTAIStaffAssertion({
    employee,
    requestId,
    privateKey: process.env.TT_AI_SIGNING_PRIVATE_KEY,
    ttlSeconds: 60,
  }).token;
  return postJson(serviceUrl, safePath, token, body);
}

module.exports = { queryTTAI, requestTTAIAdmin, getTTAIReadiness, configuration, postQuery, postJson, validatePlan };
