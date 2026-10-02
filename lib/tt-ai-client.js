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
  const localhost = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:' && !localhost) {
    throw Object.assign(new Error('TT AI service must use HTTPS in production'), { code: 'TT_AI_SERVICE_HTTPS_REQUIRED', status: 503 });
  }
  return url.toString().replace(/\/$/, '');
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

function validatePlan(plan) {
  if (!Array.isArray(plan)) throw Object.assign(new Error('TT AI returned an invalid evidence plan'), { code: 'TT_AI_PLAN_INVALID', status: 502 });
  if (plan.length > MAX_PLAN_STEPS) throw Object.assign(new Error('TT AI requested too many evidence reads'), { code: 'TT_AI_PLAN_TOO_LARGE', status: 502 });
  return plan;
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

  const first = await postQuery(serviceUrl, staffToken(), { message });
  if (first.phase === 'complete') return first;
  if (first.phase !== 'needs_evidence') {
    throw Object.assign(new Error('TT AI returned an unsupported query phase'), { code: 'TT_AI_PHASE_INVALID', status: 502 });
  }

  const evidence = [];
  for (const step of validatePlan(first.plan)) {
    if (!step?.tool || step.source !== 'pos') {
      throw Object.assign(new Error('TT AI requested an unsupported evidence source'), { code: 'TT_AI_SOURCE_NOT_ALLOWED', status: 403 });
    }
    const data = await executeTTAIReadTool(step.tool, step.input || {}, employee);
    evidence.push({
      tool: step.tool,
      source: 'pos',
      observedAt: new Date().toISOString(),
      data,
    });
  }

  return postQuery(serviceUrl, staffToken(), { message, evidence });
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
  if (!/^\/v1\/admin\/knowledge\/catalog-links(?:\/|$)/.test(safePath)) {
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
