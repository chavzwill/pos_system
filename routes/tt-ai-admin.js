'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../lib/permissions');
const { requestTTAIAdmin } = require('../lib/tt-ai-client');

function rejectMachineCredential(req, res, next) {
  if (req.apiKey) return res.status(403).json({
    error: 'TT AI knowledge administration requires an authenticated staff session',
    code: 'TT_AI_ADMIN_STAFF_SESSION_REQUIRED',
  });
  next();
}

function sendError(res, error, fallback) {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error('tt_ai_admin_gateway_error', {
    code: error?.code || 'unknown',
    message: String(error?.message || error).slice(0, 300),
  });
  return res.status(status).json({
    error: status >= 500 ? fallback : error.message,
    code: error?.code || 'TT_AI_ADMIN_REQUEST_FAILED',
  });
}

function safeStatus(value) {
  const status = String(value || 'pending').trim().toLowerCase();
  return ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
}

function safeLimit(value, fallback = 100, max = 500) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), max) : fallback;
}

function notes(value) {
  return String(value || '').trim().slice(0, 2000) || null;
}

router.use(rejectMachineCredential);

router.get('/context', requireAuth, requirePermission('settings_integrations'), (req, res) => {
  res.json({
    employee_id: req.employee.id,
    permission: 'settings_integrations',
    configured: Boolean(process.env.TT_AI_SERVICE_URL && process.env.TT_AI_SIGNING_PRIVATE_KEY),
    operational_writes: false,
    knowledge_review_writes: true,
  });
});

router.get('/knowledge-review', requireAuth, requirePermission('settings_integrations'), async (req, res) => {
  try {
    const result = await requestTTAIAdmin({
      employee: req.employee,
      path: '/v1/admin/knowledge/catalog-links/list',
      requestId: req.requestId || undefined,
      body: {
        status: safeStatus(req.query.status),
        part_id: String(req.query.part_id || '').trim().slice(0, 256) || null,
        limit: safeLimit(req.query.limit),
      },
    });
    res.json(result);
  } catch (error) {
    sendError(res, error, 'Unable to load TT AI knowledge review');
  }
});

router.post('/knowledge-review/propose', requireAuth, requirePermission('settings_integrations'), async (req, res) => {
  try {
    const result = await requestTTAIAdmin({
      employee: req.employee,
      path: '/v1/admin/knowledge/catalog-links/propose-all',
      requestId: req.requestId || undefined,
      body: {
        part_limit: safeLimit(req.body?.part_limit, 100, 1000),
        candidates_per_part: safeLimit(req.body?.candidates_per_part, 5, 25),
      },
    });
    res.json(result);
  } catch (error) {
    sendError(res, error, 'Unable to generate TT AI catalog-link proposals');
  }
});

router.post('/knowledge-review/:proposalId/approve', requireAuth, requirePermission('settings_integrations'), async (req, res) => {
  try {
    const result = await requestTTAIAdmin({
      employee: req.employee,
      path: `/v1/admin/knowledge/catalog-links/${encodeURIComponent(req.params.proposalId)}/approve`,
      requestId: req.requestId || undefined,
      body: { notes: notes(req.body?.notes) },
    });
    res.json(result);
  } catch (error) {
    sendError(res, error, 'Unable to approve TT AI knowledge mapping');
  }
});

router.post('/knowledge-review/:proposalId/reject', requireAuth, requirePermission('settings_integrations'), async (req, res) => {
  try {
    const result = await requestTTAIAdmin({
      employee: req.employee,
      path: `/v1/admin/knowledge/catalog-links/${encodeURIComponent(req.params.proposalId)}/reject`,
      requestId: req.requestId || undefined,
      body: { notes: notes(req.body?.notes) },
    });
    res.json(result);
  } catch (error) {
    sendError(res, error, 'Unable to reject TT AI knowledge mapping');
  }
});

module.exports = router;
